import type { AgentMessage } from "../../agents/runtime/index.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { SessionTranscriptAccountingSnapshot } from "../../config/sessions/session-transcript-accounting.types.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence.js";
import {
  readSessionMessagesAsync,
  readSessionTranscriptAccountingAsync,
} from "../../gateway/session-transcript-readers.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";

type TranscriptScope = {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
};

export async function readPreflightTranscriptContextMessages(
  scope: TranscriptScope,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  const readLegacyProjection = async () => {
    signal?.throwIfAborted();
    const messages = (await readSessionMessagesAsync(scope, {
      mode: "full",
      reason: "preflight-compaction-estimate-legacy",
    })) as AgentMessage[]; // SAFETY: Gateway readers project stored rows as AgentMessage values.
    signal?.throwIfAborted();
    return messages.filter(
      (message) => !("excludeFromContext" in message && message.excludeFromContext === true),
    );
  };

  if (!scope.storePath || !scope.sessionKey) {
    return await readLegacyProjection();
  }
  const target = { ...scope, sessionKey: scope.sessionKey, storePath: scope.storePath };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const context = await SessionManager.openModelContextAsync(target, { signal });
      const messages = context.buildSessionContext().messages;
      if (messages.length > 0 || context.getEntries().length > 0) {
        return messages;
      }
      // Headerless legacy projections have no canonical model-context entries.
      return await readLegacyProjection();
    } catch (error) {
      if (error instanceof SessionTranscriptReadFenceError && attempt === 0) {
        continue;
      }
      if (
        !(error instanceof Error) ||
        error.message !==
          "Persisted legacy session transcripts require doctor/import migration before runtime use"
      ) {
        throw error;
      }
      return await readLegacyProjection();
    }
  }
  throw new Error("Preflight transcript context retry exhausted");
}

export async function readSessionLogSnapshot(params: {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  includeByteSize: boolean;
  includeTurnTaint?: boolean;
  includeUsage: boolean;
  usageEventLimit?: number;
  abortSignal?: AbortSignal;
}): Promise<SessionTranscriptAccountingSnapshot> {
  params.abortSignal?.throwIfAborted();
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  if (!params.sessionId || !params.storePath || !agentId) {
    return params.includeTurnTaint ? { turnTainted: true } : {};
  }
  const scope = {
    agentId,
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    storePath: params.storePath,
  };
  try {
    const snapshot = await readSessionTranscriptAccountingAsync(
      scope,
      {
        includeByteSize: params.includeByteSize,
        includeTurnTaint: params.includeTurnTaint,
        includeUsage: params.includeUsage,
        usageEventLimit: params.usageEventLimit,
      },
      params.abortSignal,
    );
    params.abortSignal?.throwIfAborted();
    return snapshot;
  } catch {
    params.abortSignal?.throwIfAborted();
    return params.includeTurnTaint ? { turnTainted: true } : {};
  }
}
