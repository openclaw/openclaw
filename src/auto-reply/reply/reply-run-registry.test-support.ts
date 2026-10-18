import "./reply-run-registry.js";
import { markDiagnosticRunProgress } from "../../logging/diagnostic-run-activity.js";
import { replyRunState } from "./reply-run-registry.state.js";

export const testing = {
  resetReplyRunRegistry(): void {
    for (const [sessionKey, operation] of replyRunState.activeRunsByKey) {
      markDiagnosticRunProgress({
        sessionKey,
        sessionId: operation.sessionId,
        reason: "reply_operation:registry_reset",
      });
      operation.complete();
    }
    replyRunState.activeRunsByKey.clear();
    replyRunState.activeKeysBySessionId.clear();
    replyRunState.waitKeysBySessionId.clear();
    replyRunState.sourceTurnByKey.clear();
    for (const waiters of replyRunState.waitersByKey.values()) {
      for (const waiter of waiters) {
        waiter(false);
      }
    }
    replyRunState.waitersByKey.clear();
    replyRunState.followupAdmissionBarriersByKey.clear();
    replyRunState.successorAdmissionBarriersByKey.clear();
  },
};
