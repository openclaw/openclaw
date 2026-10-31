import type { ReplyOperation } from "./session-controller.contracts.js";
import {
  getCurrentSessionControllerOwner,
  getCurrentSessionControllerClaim,
  withSessionControllerOwner,
  withSessionControllerClaim,
  bindSessionControllerTarget,
  captureSessionTarget,
  type SessionTarget,
} from "./session-controller.lifecycle.js";
import {
  submitSessionControllerTask,
  abortSessionControllerInput,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  type SessionControllerMailboxClaim,
  type SessionControllerInput,
} from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";
import { runWithSessionControllerCleanup } from "./session-controller.owner-context.js";
import {
  assertSessionControllerOperation,
  getSessionControllerEntryForOperation,
  bindSessionControllerEntryTarget,
} from "./session-controller.state.js";
import { sessionTargetOwnersMatch } from "./session-controller.target.js";

export type SessionTurnAdmission = {
  sessionKey?: string;
  /** Absent until guarded row creation. The exact mailbox claim owns preparation. */
  sessionId?: string;
  agentId?: string;
  storePath?: string;
  sessionTarget?: { storePath?: string };
  target?: SessionTarget;
  detached?: boolean;
  replyOperation?: ReplyOperation;
  controllerInput?: SessionControllerInput;
  abortSignal?: AbortSignal;
  /** False for background work that must leave the session idle in operator views. */
  projectSessionActive?: false;
  /** Cancellation notification for a source reserved by this admission, before it settles. */
  onCancelled?: (reason?: unknown) => void;
  /** Source-specific terminal publication after a queued admission is cancelled. */
  onSettled?: () => Promise<void>;
};

/** One selector before preparation. Nested native work borrows exact async claim custody,
 * never ID equality; only the outer producer completes the adopted operation. */
export async function withSessionTurn<T>(
  params: SessionTurnAdmission,
  run: (operation: ReplyOperation | undefined, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // Native callers can have a physical session ID before they have a routable key.
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
  const storeScope = params.sessionTarget?.storePath ?? params.storePath;
  const target =
    params.target ??
    (storeScope && sessionKey
      ? captureSessionTarget({
          storeScope,
          sessionKey,
          agentId: params.agentId,
          incarnation: params.sessionId,
        })
      : undefined);
  const ambient = getCurrentSessionControllerOwner();
  const reservation = getCurrentSessionControllerClaim();
  const ownsInput = (
    claim: SessionControllerMailboxClaim | undefined,
    operation?: ReplyOperation,
  ) =>
    !params.controllerInput ||
    (claim?.inputs.includes(params.controllerInput) === true &&
      (!operation || claim.operation === operation));
  const ambientEntry = ambient && getSessionControllerEntryForOperation(ambient);
  const matches = (owner: { aliases: Set<string>; target?: SessionTarget }) =>
    sessionKey !== undefined &&
    sessionKey.length > 0 &&
    owner.aliases.has(sessionKey) &&
    (!target || !owner.target || sessionTargetOwnersMatch(owner.target, target));
  const inherited =
    params.replyOperation ??
    (!params.detached &&
    ambient &&
    ambientEntry &&
    matches(ambientEntry) &&
    ownsInput(ambientEntry.mailbox?.claim, ambient) &&
    (!params.sessionId || ambient.hasOwnedSessionId(params.sessionId))
      ? ambient
      : undefined);
  if (inherited) {
    assertSessionControllerOperation(inherited);
    const owner = getSessionControllerEntryForOperation(inherited);
    if (!ownsInput(owner.mailbox?.claim, inherited)) {
      throw new Error("Backend turn does not own the supplied source input");
    }
    if (!matches(owner) || (params.sessionId && !inherited.hasOwnedSessionId(params.sessionId))) {
      throw new Error(
        `Backend turn does not match its session controller admission: ${JSON.stringify({
          keyMatches: Boolean(sessionKey && owner.aliases.has(sessionKey)),
          storeScopeMatches:
            !target || !owner.target || owner.target.storeScope === target.storeScope,
          targetMatches: !target || !owner.target || sessionTargetOwnersMatch(owner.target, target),
          sessionIdOwned: !params.sessionId || inherited.hasOwnedSessionId(params.sessionId),
          explicitOperation: params.replyOperation !== undefined,
        })}`,
      );
    }
    if (target) {
      bindSessionControllerTarget(inherited, target);
    }
    params.abortSignal?.throwIfAborted();
    const signal = params.abortSignal
      ? AbortSignal.any([inherited.abortSignal, params.abortSignal])
      : inherited.abortSignal;
    const releaseExecution = inherited.retainExecution();
    try {
      return await withSessionControllerOwner(inherited, () => run(inherited, signal));
    } finally {
      releaseExecution();
    }
  }
  if (params.detached || !sessionKey) {
    const signal = params.abortSignal ?? new AbortController().signal;
    signal.throwIfAborted();
    return await runWithSessionControllerCleanup(() => run(undefined, signal));
  }
  const materialize = (claim: SessionControllerMailboxClaim): ReplyOperation | undefined => {
    if (claim.released || claim.releaseRequested || claim.mailbox.claim !== claim) {
      throw new Error("Mailbox claim no longer admits work");
    }
    claim.abortController.signal.throwIfAborted();
    params.abortSignal?.throwIfAborted();
    if (target) {
      bindSessionControllerEntryTarget(claim.mailbox.owner, target);
    }
    if (claim.operation) {
      assertSessionControllerOperation(claim.operation);
      if (params.sessionId && !claim.operation.hasOwnedSessionId(params.sessionId)) {
        throw new Error("Nested native turn changed incarnation without owner adoption");
      }
      return claim.operation;
    }
    if (!params.sessionId?.trim()) {
      return undefined;
    }
    return createReplyOperation({
      sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
      resetTriggered: false,
      turnKind: "direct",
      upstreamAbortSignal: claim.abortController.signal,
      mailboxClaim: claim,
      target,
    });
  };
  const invoke = async (claim: SessionControllerMailboxClaim) => {
    const operation = materialize(claim);
    const ownerSignal = operation?.abortSignal ?? claim.abortController.signal;
    const signal = params.abortSignal
      ? AbortSignal.any([ownerSignal, params.abortSignal])
      : ownerSignal;
    // A borrowed, initially unbound claim can materialize native work after its
    // outer producer starts. Its early reply must not release that execution.
    const releaseExecution = operation?.retainExecution();
    try {
      return await withSessionControllerClaim(claim, () =>
        operation
          ? withSessionControllerOwner(operation, () => run(operation, signal))
          : run(undefined, signal),
      );
    } finally {
      releaseExecution?.();
    }
  };
  if (
    reservation &&
    !params.detached &&
    matches(reservation.mailbox.owner) &&
    ownsInput(reservation)
  ) {
    return await invoke(reservation);
  }
  const input = params.controllerInput;
  if (input && !matches(input.mailbox.owner)) {
    throw new Error("Reserved source belongs to a different physical session");
  }
  if (input?.claim && !input.claim.released) {
    // Only the exact in-band owner above may borrow an executing source.
    throw new Error("Source is already executing under another turn admission");
  }
  let claim: SessionControllerMailboxClaim | undefined;
  // The reservation already exists, so cancellation must reach it while it waits
  // for selection, not only after an operation has been materialized.
  const abort = () => {
    if (claim) {
      claim.abortController.abort(params.abortSignal?.reason);
    } else if (input) {
      abortSessionControllerInput(input, params.abortSignal?.reason);
    }
  };
  params.abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    if (params.abortSignal?.aborted) {
      abort();
    }
    claim = input
      ? await claimSessionControllerTask(input, materialize)
      : await submitSessionControllerTask(sessionKey, {
          target,
          signal: params.abortSignal,
          projectSessionActive: params.projectSessionActive,
          onCancelled: params.onCancelled,
          onSettled: params.onSettled,
          start: materialize,
        });
    return await invoke(claim);
  } catch (error) {
    // Run errors belong to the caller and operation outcome. Source settlement
    // separately retains failures from registered persistence and cleanup work.
    if (claim?.operation && !claim.operation.result) {
      claim.operation.fail("run_failed", error);
    }
    throw error;
  } finally {
    params.abortSignal?.removeEventListener("abort", abort);
    if (claim) {
      try {
        claim.operation?.complete();
      } finally {
        releaseSessionControllerClaim(claim);
      }
    }
  }
}
