import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { findMarkdownImageSpans } from "../../packages/markdown-core/src/image-spans.js";
import { readPersistedMediaImageLayout } from "../agents/embedded-agent-runner/run/prompt-image-metadata.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { splitMediaOutput } from "../media/parse-output.js";
import {
  ASSISTANT_DISPLAY_CONTENT_FIELD,
  readAssistantDisplayContent,
} from "../shared/assistant-display-content.js";
import type { ArtifactRecord } from "./artifacts-content.js";
import { projectChatDisplayMessage } from "./chat-display-projection.core.js";
import { sqliteMessageEventWithSeq } from "./session-transcript-entry-message.js";

// Discovery sends references, never inline data (including data URLs), tool arguments or reply prose.
const reference = (value: unknown) =>
  typeof value === "string" && value && !/^\s*data:/i.test(value) ? value : undefined;
const hasMediaSyntax = (value: unknown) =>
  typeof value === "string" && (value.includes("MEDIA:") || value.includes("!["));

export function sessionFileAttachmentMessage(
  stored: Record<string, unknown>,
  artifacts: ReadonlyMap<number, ArtifactRecord>,
  entry?: Parameters<typeof sqliteMessageEventWithSeq>[0],
) {
  const raw = readAssistantDisplayContent(stored);
  if (
    !artifacts.size &&
    !readPersistedMediaFacts(stored)?.length &&
    !hasMediaSyntax(stored.content) &&
    !raw.some((b) => hasMediaSyntax(b.text) || b.type === "attachment_error")
  ) {
    return undefined;
  }
  const message = entry ? asOptionalRecord(sqliteMessageEventWithSeq(entry)) : stored;
  if (!message) {
    return undefined;
  }
  // Bind the durable catalog id before display sanitation can remove/reorder blocks.
  const field = Array.isArray(message[ASSISTANT_DISPLAY_CONTENT_FIELD])
    ? ASSISTANT_DISPLAY_CONTENT_FIELD
    : "content";
  const tagged = artifacts.size
    ? {
        ...message,
        [field]: Array.from(raw, (block, index) => {
          const row = artifacts.get(index);
          return row ? { ...block, artifactId: row.id } : block;
        }),
      }
    : message;
  const visible = projectChatDisplayMessage(tagged, { maxChars: Number.MAX_SAFE_INTEGER });
  if (!visible) {
    return undefined;
  }
  const meta = asOptionalRecord(visible["__openclaw"]);
  const content: Record<string, unknown>[] = [];
  const blocks =
    typeof visible.content === "string"
      ? [{ type: "text", text: visible.content }]
      : readAssistantDisplayContent(visible);
  for (const block of blocks) {
    if (
      typeof block.text === "string" &&
      ["text", "input_text", "output_text"].includes(String(block.type))
    ) {
      if (!hasMediaSyntax(block.text)) {
        continue;
      }
      const urls =
        visible.role === "assistant"
          ? splitMediaOutput(block.text, { extractAudioDirectives: false }).mediaUrls
          : undefined;
      for (const url of urls ?? []) {
        if (reference(url)) {
          content.push({ type: "text", text: `MEDIA:${url}` });
        }
      }
      for (const span of findMarkdownImageSpans(block.text)) {
        if (reference(span.destination)) {
          content.push({ type: "image", url: span.destination });
        }
      }
      continue;
    }
    const attachment = asOptionalRecord(block.attachment);
    if (block.type === "attachment_error" && attachment) {
      content.push({
        type: block.type,
        attachment: {
          code: attachment.code,
          kind: attachment.kind,
          label: attachment.label,
          mimeType: attachment.mimeType,
        },
      });
      continue;
    }
    if (
      ![
        "image",
        "image_url",
        "input_image",
        "attachment",
        "file",
        "input_file",
        "video",
        "input_video",
        "audio",
        "input_audio",
        "openclaw_pairing_qr",
      ].includes(String(block.type))
    ) {
      continue;
    }
    const id = typeof block.artifactId === "string" ? block.artifactId : undefined;
    const source = asOptionalRecord(block.source);
    const url =
      reference(attachment?.url) ??
      reference(block.url) ??
      reference(source?.url) ??
      reference(block.image_url) ??
      reference(asOptionalRecord(block.image_url)?.url);
    if (block.type === "openclaw_pairing_qr") {
      // Short-lived pairing credentials never enter the session-wide Files catalog.
      continue;
    }
    if (attachment && url) {
      const {
        kind,
        label,
        mimeType,
        sizeBytes,
        durationMs,
        width,
        height,
        playback,
        isVoiceNote,
        origin,
      } = attachment;
      content.push({
        type: "attachment",
        attachment: {
          url,
          kind,
          label,
          mimeType,
          sizeBytes,
          durationMs,
          width,
          height,
          playback,
          isVoiceNote,
          origin,
          artifactId: id,
        },
      });
    } else if (["image", "image_url", "input_image"].includes(String(block.type)) && (url || id)) {
      content.push({
        type: "image",
        url,
        artifactId: id,
        fileName: block.fileName ?? block.filename,
        alt: block.alt,
        mimeType: block.mimeType ?? source?.media_type,
        sizeBytes: block.sizeBytes,
        width: block.width,
        height: block.height,
      });
    }
  }
  const media = readPersistedMediaFacts(visible)?.map(
    ({ path, url, kind, contentType, fileName, sizeBytes, durationMs, width, height, origin }) => ({
      path: reference(path),
      url: reference(url),
      kind,
      contentType,
      fileName,
      sizeBytes,
      durationMs,
      width,
      height,
      origin,
    }),
  );
  if (!content.length && !media?.some((fact) => fact.path || fact.url)) {
    return undefined;
  }
  const sender = asOptionalRecord(visible.senderSession);
  return {
    ...(sender
      ? { senderSession: { agentId: sender.agentId, sessionKey: sender.sessionKey } }
      : {}),
    role: visible.role,
    timestamp: visible.timestamp,
    content,
    __openclaw: {
      id: meta?.id,
      seq: meta?.seq,
      media,
      mediaImageLayout: readPersistedMediaImageLayout(visible),
    },
  };
}
