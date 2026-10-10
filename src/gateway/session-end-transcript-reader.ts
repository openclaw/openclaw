import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import {
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  normalizeVisibleMessageLimit,
} from "../config/sessions/session-accessor.sqlite-visible-cursor.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import type {
  PluginHookEndedTranscriptReadOptions,
  PluginHookEndedTranscriptReadResult,
  SessionEndTranscriptSource,
} from "../plugins/session-end-transcript.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessagesAroundIdWithStatsAsync,
} from "./session-transcript-readers.js";
import { capArrayByJsonBytes } from "./session-utils.fs.js";

const ENDED_TRANSCRIPT_MAX_BYTES = Math.min(MAX_VISIBLE_MESSAGE_MAX_BYTES, 8 * 1024 * 1024);

function normalizeEndedTranscriptOptions(
  options: PluginHookEndedTranscriptReadOptions,
): PluginHookEndedTranscriptReadOptions {
  return {
    maxMessages: normalizeVisibleMessageLimit(
      options.maxMessages,
      1,
      MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
      "maxMessages",
    ),
    maxBytes: normalizeVisibleMessageLimit(
      options.maxBytes,
      1_024,
      ENDED_TRANSCRIPT_MAX_BYTES,
      "maxBytes",
    ),
  };
}

function finalizeEndedTranscriptRead(
  messages: unknown[],
  totalMessages: number,
  options: PluginHookEndedTranscriptReadOptions,
): PluginHookEndedTranscriptReadResult {
  const capped = capArrayByJsonBytes(messages, options.maxBytes);
  const strictMessages = capped.bytes <= options.maxBytes ? capped.items : [];
  return {
    messages: strictMessages,
    totalMessages,
    truncated: strictMessages.length < totalMessages,
  };
}

export function createClosedSessionTranscriptSource(
  scope: SessionTranscriptReadScope,
): SessionEndTranscriptSource {
  const binding = captureIncognitoSessionSource(scope);
  if (binding) {
    if ("kind" in binding || !scope.sessionKey) {
      return { available: false, reason: "incognito-deleted" };
    }
    const { actor, admissionSignal } = binding;
    const current = actor.sessions.readSharing(scope.sessionKey)?.entry;
    if (!current) {
      return { available: false, reason: "incognito-deleted" };
    }
    const target = {
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      lifecycleRevision: current.lifecycleRevision,
      historical: current.sessionId !== scope.sessionId,
    };
    const authority = {
      assertCurrent() {
        admissionSignal?.throwIfAborted();
        actor.assertReadable();
      },
    };
    return {
      available: true,
      async readTail(input) {
        const options = normalizeEndedTranscriptOptions(input);
        return actor.sessions.withCompute(
          authority,
          target,
          async (compute) => {
            const page = await compute.execute({
              type: "session.compute.endedTail",
              input: {
                ...target,
                options: { ...options, maxLines: options.maxMessages * 20 + 20 },
              },
            });
            return finalizeEndedTranscriptRead(page.messages, page.totalMessages, options);
          },
          admissionSignal,
        );
      },
    };
  }
  return {
    available: true,
    async readTail(input) {
      const options = normalizeEndedTranscriptOptions(input);
      const page = await readRecentSessionMessagesWithStatsAsync(scope, {
        maxMessages: options.maxMessages,
        maxLines: options.maxMessages * 20 + 20,
        maxBytes: options.maxBytes,
      });
      return finalizeEndedTranscriptRead(page.messages, page.totalMessages, options);
    },
  };
}

export function createResetBoundaryTranscriptSource(
  scope: SessionTranscriptReadScope,
  boundaryId: string,
): SessionEndTranscriptSource {
  return {
    available: true,
    async readTail(input) {
      const options = normalizeEndedTranscriptOptions(input);
      const page = await readSessionMessagesAroundIdWithStatsAsync(scope, {
        closedResetInterval: true,
        messageId: boundaryId,
        maxMessages: options.maxMessages,
        maxBytes: options.maxBytes,
        direction: "older",
      });
      if (!page.found) {
        throw new Error("Ended session reset boundary is no longer available");
      }
      return finalizeEndedTranscriptRead(page.messages, page.totalMessages, options);
    },
  };
}

export function createArchivedSessionTranscriptSource(params: {
  archivedPath: string;
  sessionId: string;
  agentId?: string;
  storePath?: string;
}): SessionEndTranscriptSource {
  return {
    available: true,
    async readTail(input) {
      const options = normalizeEndedTranscriptOptions(input);
      const { readSessionHistoryPageInWorker } =
        await import("../config/sessions/session-history-worker-runtime.js");
      const page = await readSessionHistoryPageInWorker({
        kind: "recent-page",
        params: {
          target: {
            sessionId: params.sessionId,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            ...(params.storePath ? { storePath: params.storePath } : {}),
          },
          exactArchivePath: params.archivedPath,
          options: {
            maxMessages: options.maxMessages,
            maxLines: options.maxMessages * 20 + 20,
            maxBytes: options.maxBytes,
          },
        },
      });
      if (!page.transcriptPath) {
        throw new Error("Ended session archive is no longer available");
      }
      return finalizeEndedTranscriptRead(page.messages, page.totalMessages, options);
    },
  };
}
