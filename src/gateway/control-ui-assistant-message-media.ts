import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { sameTranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { buildInboundMediaUriFromPath, parseInboundMediaUri } from "../media/media-reference.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import type { resolveAssistantMediaPolicy } from "./assistant-media-policy.js";
import { normalizeAssistantMediaSource } from "./control-ui-assistant-media-read.js";
import { MAX_PAYLOAD_BYTES } from "./payload-limits.js";
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
  const content = Array.isArray(display) ? display : record.content;
  for (const value of Array.isArray(content) ? content : []) {
    const block = asOptionalRecord(value);
    if (!block) {
      continue;
    }
    const source = asOptionalRecord(block.source);
    switch (block.type) {
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

function mediaIdentity(source: string, cwd: string | undefined) {
  const normalized = normalizeAssistantMediaSource(source);
  if (!normalized) {
    return undefined;
  }
  const inbound = parseInboundMediaUri(buildInboundMediaUriFromPath(normalized) ?? normalized);
  if (inbound) {
    return `media://inbound/${encodeURIComponent(inbound.id)}`;
  }
  return path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : cwd && !/^[a-z][a-z0-9+.-]*:/iu.test(normalized)
      ? path.resolve(cwd, normalized)
      : undefined;
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
  const identity = mediaIdentity(source, policy.executionCwd);
  if (
    !anchor ||
    !selected?.found ||
    selected.oversized ||
    !identity ||
    !messageMediaSources(selected.message).some(
      (candidate) => mediaIdentity(candidate, policy.executionCwd) === identity,
    )
  ) {
    throw new FsSafeError("path-mismatch", "Message attachment unavailable");
  }
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
