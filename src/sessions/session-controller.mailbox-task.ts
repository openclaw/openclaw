/** Native producer claims share the physical mailbox selector and source custody. */
import { toErrorObject } from "../infra/errors.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  SessionControllerInput,
  SessionControllerMailboxClaim,
} from "./session-controller.contracts.js";
import { logSessionControllerSourceClaim } from "./session-controller.diagnostics.js";
import { releaseSessionControllerClaim } from "./session-controller.mailbox-claim.js";

/** A prepared producer consumes its existing source, never submits another runnable input. */
export function claimSessionControllerTask(
  input: SessionControllerInput,
  start: (claim: SessionControllerMailboxClaim) => void,
  kind: NonNullable<SessionControllerInput["taskTurnKind"]> = "direct",
): Promise<SessionControllerMailboxClaim> {
  if (input.phase === "consumed" || input.retirementRequested || input.abortSignal.aborted) {
    return Promise.reject(toErrorObject(input.abortSignal.reason, "Source no longer available"));
  }
  if (input.injection) {
    return Promise.reject(new Error("Source injection outcome pending"));
  }
  if (input.claim && !input.claim.released) {
    try {
      start(input.claim);
      return Promise.resolve(input.claim);
    } catch (error) {
      return Promise.reject(toErrorObject(error, "Source claim failed"));
    }
  }
  if (input.task || input.ready) {
    return Promise.reject(new Error("Source already has a claim request"));
  }
  const pending = createDeferredCore<SessionControllerMailboxClaim>();
  input.reject = (error) => {
    logSessionControllerSourceClaim(input, "failed");
    pending.reject(error);
  };
  input.taskTurnKind = kind;
  input.task = (claim) => {
    try {
      input.abortSignal.throwIfAborted();
      start(claim);
      pending.resolve(claim);
    } catch (error) {
      logSessionControllerSourceClaim(input, "failed");
      releaseSessionControllerClaim(claim);
      pending.reject(error);
    }
  };
  input.phase = "waiting";
  logSessionControllerSourceClaim(input, "waiting");
  input.mailbox.wake();
  return pending.promise;
}

/** Pre-dispatch may prepare a queued source, but cannot bypass the turn selector. */
export function tryClaimSessionControllerTask(
  input: SessionControllerInput,
  kind: NonNullable<SessionControllerInput["taskTurnKind"]> = "direct",
): SessionControllerMailboxClaim | undefined {
  if (input.claim && !input.claim.released) {
    return input.claim;
  }
  if (
    input.phase === "consumed" ||
    input.retirementRequested ||
    input.abortSignal.aborted ||
    input.injection ||
    input.withdrawalHolds
  ) {
    return undefined;
  }
  if (input.task || input.ready) {
    throw new Error("Source already has a claim request");
  }
  const phase = input.phase;
  let selected: SessionControllerMailboxClaim | undefined;
  input.taskTurnKind = kind;
  input.task = (claim) => {
    selected = claim;
  };
  input.phase = "waiting";
  try {
    input.mailbox.wake();
    return selected;
  } finally {
    input.task = undefined;
    if (!selected && !input.retirementRequested) {
      input.taskTurnKind = undefined;
      input.phase = phase;
    }
  }
}
