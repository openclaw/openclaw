import type { SessionControllerInput } from "./session-controller.contracts.js";
import { updateSessionControllerSourcePolicy } from "./session-controller.mailbox-source.js";
import { captureSessionControllerStop, stopSession } from "./session-controller.stop.js";

/** Read-only projection of the same eligibility checked at the effect. */
export function isSessionControllerInputInterruptible(input: SessionControllerInput): boolean {
  const mailbox = input.mailbox;
  return !(
    mailbox.owner.mailbox !== mailbox ||
    !mailbox.entries.includes(input) ||
    (input.phase !== "waiting" && input.phase !== "preparing") ||
    (!input.custody.enqueued && !input.custody.rpcAccepted) ||
    input.claim ||
    input.injection ||
    input.withdrawalHolds ||
    input.retirementRequested ||
    input.abortSignal.aborted ||
    input.custody.cancellationRetired
  );
}

/** Promote the retained source, never reconstruct or resubmit accepted input. */
export function interruptForSessionControllerInput(
  input: SessionControllerInput,
  assertCurrent: () => void,
): { status: "queued" | "not_queued"; cancellationRequested: boolean } {
  assertCurrent();
  input.sourceAdapter?.authority?.assertCurrent();
  input.source?.operatorAuthority?.assertCurrent();
  const mailbox = input.mailbox;
  if (!isSessionControllerInputInterruptible(input)) {
    return { status: "not_queued", cancellationRequested: false };
  }
  // Only the current execution is interrupted. Queued siblings retain their
  // custody and FIFO positions; the selected input gets the existing priority.
  const capture = captureSessionControllerStop({ operations: [mailbox.owner.active] });
  assertCurrent();
  updateSessionControllerSourcePolicy(input, { ...input.policy, mode: "interrupt" });
  input.modeOverride = "interrupt";
  // An explicit re-selection wins even when this source already has interrupt policy.
  mailbox.priority = input;
  const stopped = stopSession({
    source: "interrupt",
    capture,
    assertCurrent,
    onError: () => "continue",
  });
  mailbox.wake();
  // Existing claim/writer fences, not this acknowledgement, decide when it runs.
  return { status: "queued", cancellationRequested: stopped.aborted };
}
