import { readSessionTranscriptBoundedMessageTailPage } from "../config/sessions/session-accessor.sqlite-active-events.js";
import { SessionTranscriptColdError } from "../config/sessions/session-cold-storage-state.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "../config/sessions/session-transcript-projection-error.js";
import { readSessionTerminalFallbackModel } from "../status/session-fallback-model.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";
import type {
  SessionRowTranscriptFields,
  SessionRowTranscriptReadParams,
} from "./session-row-transcript-backfill.types.js";
import { sqliteMessageEventWithSeq } from "./session-transcript-entry-message.js";

/** The retained history worker reads bounded preview and terminal fallback facts. */
export function readSessionRowTranscriptFields(
  params: SessionRowTranscriptReadParams,
): SessionRowTranscriptFields {
  const transcriptScope = { ...params, agentId: params.storeAgentId ?? params.agentId };
  try {
    const terminalModel = params.includeTerminalModel
      ? readSessionTerminalFallbackModel({
          sessionEntry: params.sessionEntry,
          sessionScope: transcriptScope,
        })
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
          ...(terminalModel ? { terminalModel } : {}),
        };
      }
    }
    return terminalModel ? { terminalModel } : {};
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
