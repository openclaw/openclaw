import type { AgentMessage } from "../../agents/runtime/index.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";

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
