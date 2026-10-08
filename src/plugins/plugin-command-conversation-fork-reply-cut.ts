import type { SessionMessageCutMutationParams } from "../config/sessions/session-accessor.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";

/** The canonical message-cut owner selects the process-held or agent-writer path. */
export async function forkReplySession(
  params: SessionMessageCutMutationParams & { targetKey: string },
  expected: Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision">,
) {
  return (await import("../config/sessions/session-accessor.js")).forkSessionAtMessage(
    params,
    expected,
  );
}
