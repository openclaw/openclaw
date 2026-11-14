/** Selected turn/source associations and their retained cleanup fence. */
import { isFollowupRunAborted, type FollowupRun } from "../auto-reply/reply/queue/types.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  ReplyOperation,
  SessionControllerMailboxClaim,
} from "./session-controller.contracts.js";
import {
  retireSessionControllerInput,
  settleSessionControllerSourceInjectionOrder,
} from "./session-controller.mailbox-source.js";
import { waitForReplyOperationSourceRelease } from "./session-controller.settlement.js";
import {
  isCurrentSessionControllerOperation,
  getSessionControllerEntryForOperation,
} from "./session-controller.state.js";

export function bindSessionControllerInputOperation(
  source: FollowupRun,
  operation: ReplyOperation,
): void {
  const input = source.controllerInput;
  if (!input?.claim || input.mailbox.claim !== input.claim) {
    throw new Error("Turn has no current mailbox claim");
  }
  if (
    !isCurrentSessionControllerOperation(operation) ||
    getSessionControllerEntryForOperation(operation) !== input.mailbox.owner ||
    (input.claim.operation && input.claim.operation !== operation)
  ) {
    throw new Error("Foreign operation cannot adopt source custody");
  }
  input.claim.operation = operation;
}

/** An ingress which already owns the exact operation joins that claim, never waits on itself. */
export function attachSessionControllerInputOperation(
  source: FollowupRun,
  operation: ReplyOperation,
): void {
  const input = source.controllerInput;
  if (
    !input ||
    input.injection ||
    input.withdrawalHolds ||
    input.retirementRequested ||
    input.phase === "consumed" ||
    !isCurrentSessionControllerOperation(operation) ||
    input.mailbox.owner !== getSessionControllerEntryForOperation(operation)
  ) {
    throw new Error("Cannot attach source to a foreign turn");
  }
  let claim = input.mailbox.claim;
  if (claim) {
    if (claim.operation !== operation || claim.releaseRequested) {
      throw new Error("Another source owns the selected turn");
    }
    if (!claim.inputs.includes(input)) {
      claim.inputs = [...claim.inputs, input];
    }
    if (!claim.sources.includes(source)) {
      claim.sources = [...claim.sources, source];
    }
  } else {
    claim = {
      mailbox: input.mailbox,
      inputs: [input],
      sources: [source],
      summary: false,
      operation,
      custody: {},
      released: false,
      settlement: createDeferredCore(),
      abortController: new AbortController(),
    };
    bindGatewayContextResolver(claim, getGatewayContextResolver(operation));
    input.mailbox.claim = claim;
  }
  settleSessionControllerSourceInjectionOrder(input, false);
  input.claim = claim;
  input.phase = "claimed";
}

/** The execution producer alone reports a closed, pre-execution refusal.
 * A callback throw, absent adoption callback, or cancellation is not this receipt. */
export function deferSessionControllerClaimBeforeExecution(
  claim: SessionControllerMailboxClaim,
): boolean {
  if (
    claim.released ||
    claim.releaseRequested ||
    claim.mailbox.claim !== claim ||
    (!claim.sources.length && claim.operation !== undefined) ||
    claim.custody.completed ||
    claim.inputs.some((input) => input.injection)
  ) {
    return false;
  }
  claim.retryBeforeExecution = true;
  return true;
}

export function releaseSessionControllerClaim(claim: SessionControllerMailboxClaim): void {
  if (claim.released || claim.releaseRequested) {
    return;
  }
  claim.releaseRequested = true;
  const pending = [
    claim.operation ? waitForReplyOperationSourceRelease(claim.operation) : undefined,
    claim.custody.adopting,
    claim.custody.settling,
    ...claim.inputs.flatMap((input) => [
      input.custody.adopting,
      input.custody.settling,
      input.injection?.settled,
    ]),
  ].filter((promise): promise is Promise<unknown> => Boolean(promise));
  const finish = () => {
    claim.released = true;
    // Sources may retire now, but the selected claim remains a lifecycle fence
    // until their real asynchronous cleanup receipts settle.
    const mailbox = claim.mailbox;
    const wasClearing = mailbox.clearing;
    mailbox.clearing = true;
    try {
      for (const input of claim.inputs) {
        let authorityCurrent = true;
        if (claim.retryBeforeExecution) {
          try {
            input.source?.operatorAuthority?.assertCurrent();
            input.sourceAdapter?.authority?.assertCurrent();
          } catch {
            authorityCurrent = false;
          }
        }
        const retry =
          authorityCurrent &&
          (!input.source || !isFollowupRunAborted(input.source)) &&
          input.claim === claim &&
          input.phase === "claimed" &&
          claim.retryBeforeExecution &&
          !input.retirementRequested &&
          !input.abortSignal.aborted &&
          !input.custody.completed;
        if (retry) {
          // The completed claim request cannot receive a second selection.
          input.ready = undefined;
          input.task = undefined;
          input.taskTurnKind = undefined;
          input.reject = undefined;
          input.claim = undefined;
          input.phase = "waiting";
        } else {
          retireSessionControllerInput(input);
        }
      }
    } finally {
      mailbox.clearing = wasClearing;
      void Promise.allSettled(
        claim.inputs
          .filter((input) => input.claim === claim)
          .map((input) => input.settlement.promise),
      ).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (mailbox.claim === claim) {
          mailbox.claim = undefined;
        }
        if (failures.length) {
          claim.settlement.reject(new AggregateError(failures, "Source cleanup failed"));
        } else {
          claim.settlement.resolve();
        }
        mailbox.wake();
      });
      void claim.settlement.promise.catch(() => {});
    }
  };
  if (pending.length) {
    void Promise.allSettled(pending).then(finish);
  } else {
    finish();
  }
}
