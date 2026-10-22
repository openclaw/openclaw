import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import { diagnosticLogger } from "../logging/diagnostic-runtime.js";
import { isMutationOwnedTurn } from "./session-controller.admission-rule.js";
import type { SessionControllerInput } from "./session-controller.contracts.js";
import { logSessionControllerPhase } from "./session-controller.lifecycle-diagnostics.js";
export {
  createSessionControllerPhaseLogger,
  logSessionControllerPhase,
} from "./session-controller.lifecycle-diagnostics.js";

/** Captures the selector's current blockers once per source claim transition. */
export function logSessionControllerSourceClaim(
  input: SessionControllerInput,
  status: "waiting" | "selected" | "failed",
): void {
  if (!areDiagnosticsEnabledForProcess() || !diagnosticLogger.isEnabled("info")) {
    return;
  }
  const { mailbox } = input;
  logSessionControllerPhase({
    phase: "source-claim",
    status,
    sessionKey: mailbox.key,
    sessionId: input.sourceSessionId,
    sourceId: input.protocolRunId ?? input.instance.id,
    reason: mailbox.owner.successorBarrier
      ? "successor-barrier"
      : mailbox.owner.followupBarrier
        ? "followup-barrier"
        : mailbox.claim
          ? "claim-owned"
          : mailbox.owner.active
            ? "operation-owned"
            : mailbox.owner.lifecycle?.blocksTurnAdmission &&
                !isMutationOwnedTurn(mailbox.owner, input)
              ? "lifecycle-blocked"
              : "mailbox-selection",
    pendingInputs: mailbox.entries.length,
    injectingInputs: mailbox.entries.filter((entry) => entry.injection).length,
    withdrawalHolds: input.withdrawalHolds,
    prioritySourceId: mailbox.priority?.instance.id,
  });
}
