import type { SessionMessageCutMutationParams } from "../config/sessions/session-accessor.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";

/** Incognito SQLite remains process-held; durable transcripts use the agent writer. */
export async function forkReplySession(
  params: SessionMessageCutMutationParams & { targetKey: string },
  expected: Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision">,
  incognito: boolean,
) {
  return incognito
    ? (await import("../config/sessions/session-accessor.js")).forkSessionAtMessage(
        params,
        expected,
      )
    : (
        await import("../config/sessions/session-accessor.sqlite-message-cut-worker.js")
      ).forkSessionAtMessageInWorker(params, expected);
}
