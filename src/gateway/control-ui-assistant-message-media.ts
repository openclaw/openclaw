import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { extractCanvasShortcodes } from "../chat/canvas-render.js";
import { readSessionPendingInput } from "../config/sessions/session-pending-input-history.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { sameTranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { buildInboundMediaUriFromPath } from "../media/inbound-media-path.js";
import { parseInboundMediaUri } from "../media/inbound-media-uri.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import type { resolveAssistantMediaPolicy } from "./assistant-media-policy.js";
import {
  normalizeAssistantMediaSource,
  resolveAssistantMediaSource,
} from "./control-ui-assistant-media-read.js";
import { MAX_PAYLOAD_BYTES } from "./payload-limits.js";
import { projectPendingInputMessage } from "./server-methods/chat-pending-inputs.js";
import { readSessionMessageByIdAsync } from "./session-transcript-readers.js";

type MediaPolicy = NonNullable<Awaited<ReturnType<typeof resolveAssistantMediaPolicy>>>;

function messageMediaSources(message: unknown): string[] {
  const record = asOptionalRecord(message);
  if (!record) {
    return [];
  }
  const sources: unknown[] = (readPersistedMediaFacts(record) ?? []).flatMap((fact) => [
    fact.url,
    fact.path,
  ]);
  const display = record[ASSISTANT_DISPLAY_CONTENT_FIELD];
  const content = Array.isArray(display) ? display : (record.content ?? record.text);
  const assistant = record.role === "assistant";
  const addDirectives = (text: string) => {
    sources.push(
      ...(splitMediaFromOutput(extractCanvasShortcodes(text).text, {
        extractAudioDirectives: false,
      }).mediaUrls ?? []),
    );
  };
  if (assistant && typeof content === "string") {
    addDirectives(content);
  }
  for (const value of Array.isArray(content) ? content : []) {
    const block = asOptionalRecord(value);
    if (!block) {
      continue;
    }
    const source = asOptionalRecord(block.source);
    switch (block.type) {
      case "text":
      case "input_text":
      case "output_text":
        if (assistant && typeof block.text === "string") {
          addDirectives(block.text);
        }
        break;
      case "attachment":
        sources.push(asOptionalRecord(block.attachment)?.url);
        break;
      case "image":
        sources.push(block.url, block.openUrl, source?.url);
        break;
      case "image_url":
        sources.push(asOptionalRecord(block.image_url)?.url);
        break;
      case "input_image":
        sources.push(block.image_url, asOptionalRecord(block.image_url)?.url, source?.url);
        break;
      case "audio":
      case "video":
        sources.push(block.url, source?.type === "url" ? source.url : undefined);
        break;
    }
  }
  return sources.filter((source): source is string => typeof source === "string");
}

function mediaIdentity(source: string, policy: MediaPolicy) {
  const normalized = normalizeAssistantMediaSource(source);
  if (!normalized) {
    return undefined;
  }
  const inbound = parseInboundMediaUri(buildInboundMediaUriFromPath(normalized) ?? normalized);
  if (inbound) {
    return `media://inbound/${encodeURIComponent(inbound.id)}`;
  }
  const resolved = resolveAssistantMediaSource(normalized, policy);
  return resolved && path.isAbsolute(resolved) ? path.resolve(resolved) : undefined;
}

/** Bind narrow session readers to an existing visible message and its current media references. */
export async function prepareAssistantMessageMedia(
  source: string,
  policy: MediaPolicy,
  signal: AbortSignal,
): Promise<(publish: () => void) => Promise<void>> {
  if (!policy.messageId) {
    return async (publish) => publish();
  }
  const messageId = policy.messageId;
  const loaded = policy.readSession();
  if (!loaded?.entry?.sessionId) {
    throw new FsSafeError("path-mismatch", "Message attachment unavailable");
  }
  const scope = {
    agentId: loaded.readSource?.agentId ?? loaded.agentId,
    sessionKey: loaded.canonicalKey,
    sessionId: loaded.entry.sessionId,
    storePath: loaded.readSource?.path ?? loaded.storePath,
    sessionEntry: loaded.entry,
  };
  const identity = mediaIdentity(source, policy);
  const assertAssociation = (message: unknown) => {
    signal.throwIfAborted();
    if (
      !identity ||
      !messageMediaSources(message).some(
        (candidate) => mediaIdentity(candidate, policy) === identity,
      )
    ) {
      throw new FsSafeError("path-mismatch", "Message attachment unavailable");
    }
  };
  if (messageId.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)) {
    const inputId = messageId.slice(CHAT_PENDING_INPUT_MESSAGE_PREFIX.length);
    // Attachment association needs visibility and media, not forwarded sender labels.
    const project = (input: Awaited<ReturnType<typeof readSessionPendingInput>>) =>
      input
        ? projectPendingInputMessage(input, MAX_PAYLOAD_BYTES, undefined, () => undefined)
        : undefined;
    assertAssociation(project(await readSessionPendingInput(scope, inputId)));
    return async (publish) => {
      let published = false;
      await readSessionPendingInput(scope, inputId, (current) => {
        assertAssociation(project(current));
        publish();
        published = true;
      });
      if (!published) {
        throw new FsSafeError("path-mismatch", "Message attachment unavailable");
      }
    };
  }
  const selection = { entryIds: [messageId] };
  const anchor = (await readSessionTranscriptAnchorsAsync(scope, selection, signal)).anchors[0];
  const selected =
    anchor &&
    (await readSessionMessageByIdAsync(
      scope,
      messageId,
      {
        currentOnly: true,
        maxBytes: MAX_PAYLOAD_BYTES,
        allowResetArchiveFallback: false,
        historyVisibility: {
          sessionStartedAt: loaded.entry.sessionStartedAt,
          requireVisible: true,
        },
      },
      signal,
    ));
  if (!anchor || !selected?.found || selected.oversized) {
    throw new FsSafeError("path-mismatch", "Message attachment unavailable");
  }
  assertAssociation(selected.message);
  return async (publish) => {
    let published = false;
    // Media enrichment can rewrite an existing message ID. The transcript owner
    // checks its anchor and holds write ordering until response publication starts.
    await readSessionTranscriptAnchorsAsync(scope, selection, signal, (current) => {
      if (!sameTranscriptEntryAnchor(anchor, current.anchors[0])) {
        throw new FsSafeError("path-mismatch", "Message attachment changed");
      }
      publish();
      published = true;
    });
    if (!published) {
      throw new FsSafeError("path-mismatch", "Message attachment changed");
    }
  };
}
