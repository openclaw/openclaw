import {
  createNativeSessionCommitFinalizer,
  getNativeSessionDeletionParticipant,
} from "../../agents/harness/native-session/deletion-participant.js";
import type { AgentHarnessSessionDeletionMutation } from "../../agents/harness/types.js";
import { getChildLogger } from "../../logging/logger.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";

/** Preserve typed participants; adapt legacy cleanup to the acknowledged worker commit. */
export function resolveSessionDeletionWorkerParticipant(
  mutation: AgentHarnessSessionDeletionMutation,
  sessionKey: string,
) {
  const participant = getNativeSessionDeletionParticipant(mutation);
  if (participant) {
    return participant;
  }
  warnPluginSdkDeprecation({
    family: "session-deletion-transaction-callback",
    method: "opaque AgentHarnessSessionDeletionMutation",
    replacement: "createNativeSessionCommitFinalizer or a native binding participant",
    compatibility:
      "The callback runs only after a successful session commit; its rollback callback is not used.",
  });
  const finalizer = createNativeSessionCommitFinalizer({
    commit() {
      try {
        mutation.commit();
      } catch (error) {
        getChildLogger({ subsystem: "session-sqlite" }).warn(
          "Session deletion committed, but legacy harness cleanup failed",
          { sessionKey, error },
        );
      }
    },
    rollback() {},
  });
  return getNativeSessionDeletionParticipant(finalizer)!;
}
