import {
  isSessionTranscriptProjectionUnavailableError,
  readSessionTranscriptBoundedMessageTailPage,
} from "../config/sessions/session-accessor.js";
import { SessionTranscriptColdError } from "../config/sessions/session-cold-storage-state.js";
import { SessionTranscriptStorageUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { readSessionFallbackModel } from "../status/session-fallback-model.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";
import { sqliteMessageEventWithSeq } from "./session-transcript-entry-message.js";

/** Read-only transcript fields run after foreground projection work, never during materialization. */
export async function backfillSessionRowTranscriptFields(params: {
  agentId: string;
  storeAgentId?: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  sessionEntry: SessionEntry;
  shouldCommit?: () => boolean;
  model?: Pick<
    Parameters<typeof readSessionFallbackModel>[0],
    "selectedProvider" | "selectedModel" | "config"
  >;
}): Promise<{ lastMessagePreview?: string; fallbackModel?: { provider: string; model: string } }> {
  if (params.shouldCommit?.() === false) {
    return {};
  }
  const transcriptScope = { ...params, agentId: params.storeAgentId ?? params.agentId };
  try {
    const fallback =
      params.model &&
      readSessionFallbackModel({
        ...params.model,
        sessionEntry: params.sessionEntry,
        sessionScope: transcriptScope,
      });
    const fallbackModel = fallback
      ? { provider: fallback.modelProvider, model: fallback.model }
      : undefined;
    const tail = readSessionTranscriptBoundedMessageTailPage(transcriptScope, {
      maxMessages: 20,
      maxBytes: 64 * 1024,
      offset: 0,
      readOnly: true,
    });
    // Older text cannot stand in for an oversized message skipped at the newest edge.
    const events = tail.newestContiguousEventCount
      ? tail.events.slice(-tail.newestContiguousEventCount)
      : [];
    for (const event of events.toReversed()) {
      const projected = projectSessionDisplayMessage(sqliteMessageEventWithSeq(event), {
        flattenMarkdown: true,
      });
      if (projected) {
        // Detach resident strings from the parsed transcript payload.
        return {
          lastMessagePreview: Buffer.from(projected.text, "utf16le").toString("utf16le"),
          ...(fallbackModel ? { fallbackModel } : {}),
        };
      }
    }
    return fallbackModel ? { fallbackModel } : {};
  } catch (error) {
    if (
      isSessionTranscriptProjectionUnavailableError(error) ||
      error instanceof SessionTranscriptStorageUnavailableError ||
      error instanceof SessionTranscriptColdError
    ) {
      return {};
    }
    throw error;
  }
}
