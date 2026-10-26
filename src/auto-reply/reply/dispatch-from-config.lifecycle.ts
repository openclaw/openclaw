import crypto from "node:crypto";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { isRecoverableTerminalSessionStatus } from "../../config/sessions/terminal-status.js";
import { logVerbose } from "../../globals.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withSessionControllerSource } from "../../sessions/session-controller.context.js";
import {
  type ReplyOperation,
  waitForReplyBarrierSettlement,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import type { SessionEffectRef } from "../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  tryClaimSessionControllerTask,
  trackSessionControllerSourceWork,
} from "../../sessions/session-controller.mailbox.js";
import { waitForReplyOperationSourceRelease } from "../../sessions/session-controller.settlement.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { observeAgentRunStart } from "../agent-run-start.js";
import {
  isNativeCommandTurn,
  isExplicitFollowupCommandTurn,
  resolveCommandTurnContext,
  resolveCommandTurnTargetSessionKey,
} from "../command-turn-context.js";
import { isExplicitCommandTurnContext } from "../command-turn-detection.js";
import { isActiveRunSafeCommandTurn } from "../commands-registry.js";
import { waitForReplyDispatcherSettlement } from "../dispatch-dispatcher.js";
import {
  createAbortAwareDispatcher,
  DispatchReplyOperationAbortedError,
  isDispatchReplyOperationAbortedError,
} from "./dispatch-from-config.abort.js";
import {
  resolveDispatchResetAdmission,
  shouldLetSlackRoutedThreadBypassBusyReplyOperation,
} from "./dispatch-from-config.context.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import type {
  DispatchFromConfigParams,
  DispatchReplyOperationCoordinatorParams,
} from "./dispatch-from-config.types.js";
import { restoreArchivedDispatchSession } from "./dispatch-session-archive.js";
import { DispatchSessionRefreshRequiredError } from "./dispatch-session-refresh-error.js";
import { isExplicitSteerCommandTurn } from "./explicit-steer-routing.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatch-outcome.types.js";
import { waitForReplyDispatcherIdle } from "./reply-dispatcher.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { readReplySourceInput } from "./reply-source-binding.js";
import { createReplyTurnAdmissionWaiter } from "./reply-turn-admission-wait.js";
import { admitReplyTurn, runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";
import { resolveReplyTurnKind } from "./reply-turn-kind.js";
import { isUnauthorizedTextSlashCommand } from "./source-reply-delivery-mode.js";

type DispatchReplyOperationAcquisition =
  | { status: "ready" }
  | { status: "busy" }
  | { status: "aborted" };

export function createDispatchReplyOperationCoordinator(
  params: DispatchReplyOperationCoordinatorParams,
) {
  let dispatchReplyOperation: ReplyOperation | undefined;
  let admittedExpectedSessionId: string | undefined;
  let dispatchAbortOperation: ReplyOperation | undefined;
  let preDispatchAbortOperation: ReplyOperation | undefined;
  let preDispatchLifecycleAdmission: SessionEffectRef | undefined;
  let removePreDispatchLifecycleAbortListener: (() => void) | undefined;
  let preDispatchLifecycleAbortController: AbortController | undefined;
  let dispatchLifecycleAbortController: AbortController | undefined;
  let preDispatchLifecycleInterrupted = false;
  let dispatchResetTriggered = false;
  let allowRestartTombstoneParentFork = false;
  let allowRestartTombstoneReset = false;
  const dispatchLifecycleWork = {
    owner: new Set<Promise<void>>(),
    delivery: new Set<Promise<void>>(),
  };

  const trackDispatchLifecycleWork = (
    work: Promise<unknown>,
    phase: "owner" | "delivery" = "owner",
  ) => {
    const input = readReplySourceInput(params.replyOptions);
    if (input && (phase === "owner" || !input.claim?.operation)) {
      trackSessionControllerSourceWork(
        input,
        work.catch((error: unknown) => {
          // Cancellation and bounded binding refresh retain raw work without
          // recording their expected control flow as failed source cleanup.
          if (
            !(error instanceof DispatchSessionRefreshRequiredError) &&
            (!input.abortSignal.aborted || error !== input.abortSignal.reason)
          ) {
            throw error;
          }
        }),
      );
    }
    // A native command can acquire its operation after resolver work starts.
    const pending = dispatchLifecycleWork[phase];
    const settled = work.then(
      () => {},
      () => {},
    );
    pending.add(settled);
    void settled.then(() => {
      pending.delete(settled);
    });
  };

  const waitForDispatchDelivery = async (): Promise<void> => {
    await Promise.allSettled(Array.from(dispatchLifecycleWork.delivery));
    await waitForReplyDispatcherIdle(params.dispatcher);
  };
  const waitForDispatchSettlement = async (): Promise<void> => {
    await Promise.allSettled(Array.from(dispatchLifecycleWork.delivery));
    await waitForReplyDispatcherSettlement(params.dispatcher);
  };

  const releasePreDispatchLifecycleAdmission = async (
    afterWorkBarrier?: () => PromiseLike<unknown>,
  ): Promise<void> => {
    removePreDispatchLifecycleAbortListener?.();
    removePreDispatchLifecycleAbortListener = undefined;
    const admission = preDispatchLifecycleAdmission;
    const preDispatchAbortController = preDispatchLifecycleAbortController;
    const dispatchAbortController = dispatchLifecycleAbortController;
    preDispatchLifecycleAdmission = undefined;
    if (!admission) {
      return;
    }
    const pendingWork = [...dispatchLifecycleWork.owner, ...dispatchLifecycleWork.delivery];
    const clearAbortControllers = () => {
      if (preDispatchLifecycleAbortController === preDispatchAbortController) {
        preDispatchLifecycleAbortController = undefined;
      }
      if (dispatchLifecycleAbortController === dispatchAbortController) {
        dispatchLifecycleAbortController = undefined;
      }
    };
    try {
      if (afterWorkBarrier || pendingWork.length > 0) {
        await Promise.allSettled(pendingWork);
      }
      if (afterWorkBarrier) {
        await waitForReplyBarrierSettlement(
          afterWorkBarrier(),
          params.dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.(),
        );
      }
    } finally {
      clearAbortControllers();
      admission.release();
    }
  };

  const armPreDispatchLifecycleAbortRelease = () => {
    const abortSignal =
      params.replyOptions?.turnAdoptionLifecycle?.abortSignal ?? params.replyOptions?.abortSignal;
    if (!abortSignal || !preDispatchLifecycleAdmission) {
      return;
    }
    removePreDispatchLifecycleAbortListener?.();
    const onAbort = () => {
      void releasePreDispatchLifecycleAdmission(() =>
        waitForReplyDispatcherSettlement(params.dispatcher),
      );
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    removePreDispatchLifecycleAbortListener = () =>
      abortSignal.removeEventListener("abort", onAbort);
    if (abortSignal.aborted) {
      onAbort();
    }
  };

  const runWithDispatchLifecycleAdmission = async <T>(run: () => Promise<T>): Promise<T> => {
    if (dispatchReplyOperation) {
      return await runWithReplyOperationLifecycleAdmission(dispatchReplyOperation, run);
    }
    const input = readReplySourceInput(params.replyOptions);
    // Without an operation or claim, only the source identifies this turn's own
    // input; otherwise a /new rollover inside it cancels the input it runs on.
    const runAsSource = input ? () => withSessionControllerSource(input, run) : run;
    const work = preDispatchLifecycleAdmission
      ? preDispatchLifecycleAdmission.run(runAsSource)
      : Promise.resolve().then(runAsSource);
    if (input) {
      // The abort race is cancellation; raw resolver failures have their own receipt.
      trackSessionControllerSourceWork(
        input,
        work.catch((error: unknown) => {
          if (!isDispatchReplyOperationAbortedError(error)) {
            throw error;
          }
        }),
      );
    }
    return await work;
  };

  const ensureDispatchReplyOperation = async (
    phase: "pre_dispatch" | "command_resolution" | "dispatch",
    hasPluginOwnedBinding = false,
  ): Promise<DispatchReplyOperationAcquisition> => {
    const input = readReplySourceInput(params.replyOptions);
    const assertRequestCurrent = () => {
      const sourceAuthority = input?.sourceAdapter?.authority;
      sourceAuthority?.assertCurrent();
      if (params.replyOptions?.operatorAuthority !== sourceAuthority) {
        params.replyOptions?.operatorAuthority?.assertCurrent();
      }
      params.replyOptions?.internalEventExecution?.assertCurrent?.();
    };
    const commandTurn = resolveCommandTurnContext(params.ctx);
    const activeRunSafe = isActiveRunSafeCommandTurn({
      commandTurn,
      cfg: params.cfg,
      provider: params.ctx.Provider ?? params.ctx.Surface,
    });
    // Safe controls must never acquire a target turn or wait for its capacity.
    // A command which continues into model execution retargets its unclaimed
    // input there and uses the ordinary mailbox selector.
    if (
      isNativeCommandTurn(commandTurn) ||
      activeRunSafe ||
      (resolveCommandTurnTargetSessionKey(params.ctx) &&
        resolveCommandTurnTargetSessionKey(params.ctx) !== params.dispatchOperationSessionKey)
    ) {
      assertRequestCurrent();
      // A resolved command may consume its input before delivering its refusal.
      // Retirement bars new work; cancellation still bars final delivery.
      if (
        getPreDispatchAbortSignal()?.aborted ||
        (phase !== "dispatch" && input?.retirementRequested)
      ) {
        return { status: "aborted" };
      }
      return { status: "ready" };
    }
    // Archive restoration belongs to pre-dispatch ownership resolution. Later calls only upgrade admission.
    if (phase === "pre_dispatch") {
      params.operationSessionStoreEntry.entry = await restoreArchivedDispatchSession({
        assertCurrent: () => getPreDispatchAbortSignal()?.throwIfAborted(),
        ctx: params.ctx,
        entry: params.operationSessionStoreEntry.entry,
        hasPluginOwnedBinding,
        placementContext: params.sessionWorkerPlacementContext,
        sessionKey: params.dispatchOperationSessionKey,
        storePath: params.operationSessionStoreEntry.storePath,
      });
      ({
        resetTriggered: dispatchResetTriggered,
        allowRestartTombstoneParentFork,
        allowRestartTombstoneReset,
      } = await resolveDispatchResetAdmission({
        agentId: params.agentId,
        cfg: params.cfg,
        ctx: params.ctx,
        entry: params.operationSessionStoreEntry.entry,
        hasPluginOwnedBinding,
        sessionKey: params.dispatchOperationSessionKey,
        storePath: params.operationSessionStoreEntry.storePath,
      }));
    }
    if (phase !== "pre_dispatch" && preDispatchLifecycleInterrupted) {
      return { status: dispatchReplyOperation ? "aborted" : "busy" };
    }
    if (dispatchReplyOperation) {
      return { status: "ready" };
    }
    if (dispatchAbortOperation && !dispatchAbortOperation.result) {
      return { status: "busy" };
    }
    if (
      phase !== "pre_dispatch" &&
      preDispatchAbortOperation?.result &&
      preDispatchAbortOperation.result.kind !== "completed" &&
      // Low-level queue resolution can abort the old owner before final delivery acquires its
      // successor operation. The old result belongs to that owner, not to this inbound turn.
      params.allowActiveQueueResolution !== true
    ) {
      dispatchAbortOperation = preDispatchAbortOperation;
      return { status: "busy" };
    }
    const dispatchOperationSessionKey = params.dispatchOperationSessionKey;
    if (!dispatchOperationSessionKey) {
      return { status: "ready" };
    }
    const operationSessionId =
      dispatchAbortOperation?.sessionId ??
      params.operationSessionStoreEntry.entry?.sessionId ??
      crypto.randomUUID();
    const replyTurnKind = resolveReplyTurnKind(params.replyOptions);
    const activeReplyOperation = input
      ? input.mailbox.owner.active
      : getSessionControllerOperation(
          dispatchOperationSessionKey,
          params.operationSessionStoreEntry.storePath
            ? captureSessionTarget({
                storeScope: params.operationSessionStoreEntry.storePath,
                sessionKey: dispatchOperationSessionKey,
                agentId: params.agentId,
                incarnation: params.operationSessionStoreEntry.entry?.sessionId,
              })
            : undefined,
        );
    // Queue commands must reach admission while the incumbent is active so their
    // steering or followup outcome can be reported before that turn ends.
    const explicitQueueCommandTurn =
      isExplicitSteerCommandTurn(params.ctx) || isExplicitFollowupCommandTurn(params.ctx);
    const commandRequiresTurn =
      (isExplicitCommandTurnContext(params.ctx, params.cfg) ||
        isUnauthorizedTextSlashCommand(params.ctx)) &&
      !activeRunSafe &&
      !explicitQueueCommandTurn;
    const queueEligible =
      replyTurnKind === "visible" || params.replyOptions?.internalEventExecution !== undefined;
    const allowQueuePreparation =
      queueEligible &&
      !commandRequiresTurn &&
      (explicitQueueCommandTurn ||
        params.replyOptions?.turnAdoptionLifecycle !== undefined ||
        params.allowActiveQueueResolution === true);
    const allowActiveResolution =
      queueEligible && (phase === "pre_dispatch" || phase === "command_resolution");
    const allowGatewayQueueResolution =
      phase !== "pre_dispatch" && allowQueuePreparation && activeReplyOperation !== undefined;
    if (allowGatewayQueueResolution) {
      // Gateway and low-level plugin turns must reach getReplyFromConfig while the owner is active;
      // that layer applies the session's steer/followup/collect/drop policy without concurrent runs.
      return { status: "ready" };
    }
    if (phase !== "pre_dispatch") {
      await releasePreDispatchLifecycleAdmission(() =>
        waitForReplyDispatcherIdle(params.dispatcher),
      );
      if (preDispatchLifecycleInterrupted) {
        return { status: dispatchReplyOperation ? "aborted" : "busy" };
      }
    }
    const allowSlackRoutedThreadBypass =
      phase !== "pre_dispatch" &&
      shouldLetSlackRoutedThreadBypassBusyReplyOperation({
        activeOperation: activeReplyOperation,
        ctx: params.ctx,
        routeThreadId: params.routeThreadId,
      });
    const lifecycleOnlyAbortController =
      allowActiveResolution || allowSlackRoutedThreadBypass ? new AbortController() : undefined;
    const onLifecycleInterrupt = () => {
      preDispatchLifecycleInterrupted = true;
      lifecycleOnlyAbortController?.abort();
    };
    // Queue/steer/question completion may already have handed this exact input
    // off without a dispatch operation. Final delivery must not reacquire it.
    if (input && (input.custody.enqueued || input.phase === "consumed" || input.injection)) {
      return { status: "ready" };
    }
    // Fast control events run before this gate. Ordinary pre-dispatch preparation
    // may proceed while occupied, but only the canonical selector grants a turn.
    let mailboxClaim = input ? tryClaimSessionControllerTask(input, replyTurnKind) : undefined;
    if (input && phase === "dispatch" && allowQueuePreparation) {
      while (!mailboxClaim) {
        if (input.abortSignal.aborted || input.retirementRequested) {
          return { status: "aborted" };
        }
        const active = input.mailbox.owner.active;
        if (active) {
          return { status: "ready" };
        }
        const predecessors = input.mailbox.entries.filter(
          (entry) =>
            entry.sequence < input.sequence &&
            entry.phase !== "consumed" &&
            !entry.retirementRequested,
        );
        if (!predecessors.length) {
          break;
        }
        // Keep FIFO until the earlier source publishes its operation; queue preparation
        // may then join that operation without waiting for its backend or completion.
        const resumed = await createReplyTurnAdmissionWaiter(input.mailbox.owner, {
          sessionKey: dispatchOperationSessionKey,
          runId: params.replyOptions?.runId,
          upstreamAbortSignal: input.abortSignal,
        }).inputs(undefined, predecessors);
        if (!resumed) {
          return { status: "aborted" };
        }
        mailboxClaim = tryClaimSessionControllerTask(input, replyTurnKind);
      }
    }
    if (input && !mailboxClaim) {
      if (input.abortSignal.aborted || input.retirementRequested) {
        return { status: "aborted" };
      }
      const predecessor = input.mailbox.owner.active;
      if (
        predecessor &&
        isRecoverableTerminalSessionStatus(params.operationSessionStoreEntry.entry?.status)
      ) {
        // Persisted terminal state is not proof that raw producer work settled.
        // Recovery acts only on this captured owner, never a by-ID successor.
        await predecessor.watchdog.tick();
        mailboxClaim = tryClaimSessionControllerTask(input, replyTurnKind);
      }
      if (!mailboxClaim && (allowActiveResolution || allowSlackRoutedThreadBypass)) {
        return { status: "ready" };
      }
      if (!mailboxClaim) {
        const selected = claimSessionControllerTask(input, () => {}, replyTurnKind);
        try {
          mailboxClaim = await selected;
        } catch (error) {
          if (input.abortSignal.aborted) {
            return { status: "aborted" };
          }
          throw error;
        }
      }
    }
    let admission: Awaited<ReturnType<typeof admitReplyTurn>>;
    try {
      admission = await admitReplyTurn({
        mailboxClaim,
        runId: params.replyOptions?.runId,
        onDatabaseRegistration: params.replyOptions?.onDatabaseRegistration,
        assertRequestCurrent,
        providerReviewAcknowledgment: params.replyOptions?.providerReviewAcknowledgment,
        agentId: params.agentId,
        sessionKey: dispatchOperationSessionKey,
        resolveGatewayContext:
          readChannelContextGatewayContextResolver(params.ctx) ??
          getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
        sessionId: operationSessionId,
        expectedSessionId:
          params.replyOptions?.expectedExistingSessionId ??
          params.resolveOperationExpectedSessionId(),
        expectedActiveOperations: [
          params.replyOptions?.expectedActiveReplyOperation,
          params.initialDispatchReplyOperation,
        ].filter((operation): operation is ReplyOperation => operation !== undefined),
        storePath: params.operationSessionStoreEntry.storePath,
        kind: replyTurnKind,
        resetTriggered: dispatchResetTriggered,
        allowRestartTombstoneParentFork,
        allowRestartTombstoneReset,
        routeThreadId: params.routeThreadId,
        originatingLeafEntryId: params.replyOptions?.turnAdoptionLifecycle?.originatingLeafEntryId,
        upstreamAbortSignal: input?.abortSignal ?? params.replyOptions?.abortSignal,
        waitForActive: !allowActiveResolution && !allowSlackRoutedThreadBypass,
        retainLifecycleAdmissionOnActive: allowActiveResolution || allowSlackRoutedThreadBypass,
        onLifecycleInterrupt,
      });
      if (mailboxClaim) {
        const claim = mailboxClaim;
        if (admission.status === "owned") {
          // Keep adoption open through execution; delivery remains with the operation.
          const releaseClaim = () => releaseSessionControllerClaim(claim);
          void waitForReplyOperationSourceRelease(admission.operation).then(releaseClaim);
        } else {
          releaseSessionControllerClaim(claim);
        }
      }
    } catch (error) {
      if (mailboxClaim) {
        releaseSessionControllerClaim(mailboxClaim);
      }
      if (
        phase === "pre_dispatch" &&
        replyTurnKind === "visible" &&
        isSessionWorkStartInvalidatedError(error)
      ) {
        throw new DispatchSessionRefreshRequiredError(error);
      }
      throw error;
    }
    // Admission has verified the predecessor's lineage in this physical store.
    // Carry that identity through initialization even when the active run still owns the slot.
    admittedExpectedSessionId =
      admission.status === "owned"
        ? admission.operation.sessionId
        : admission.sessionEntry?.sessionId;
    const runState = resolveReplyOperationRunState(params.replyOptions);
    // A turn already accepted into the queue or active run keeps that custody when
    // dispatch later finds the session idle; the queued turn owns its answer.
    if (runState && runState.admission?.status !== "accepted") {
      runState.admission =
        admission.status === "owned"
          ? { status: "owned" }
          : { status: "skipped", reason: admission.reason };
    }
    if (admission.status === "skipped") {
      if (admission.error) {
        params.replyOptions?.internalEventExecution?.onFailed?.(admission.error);
      }
      if (
        admission.reason === "active-run" &&
        // Releasing a refused claim retires its source. Its producer must retry
        // admission instead of resolving queue policy on that consumed input.
        !mailboxClaim &&
        (allowActiveResolution ||
          shouldLetSlackRoutedThreadBypassBusyReplyOperation({
            activeOperation: admission.activeOperation,
            ctx: params.ctx,
            routeThreadId: params.routeThreadId,
          }))
      ) {
        // Gateway and low-level successors retain their own cancellation while awaiting queue admission.
        if (allowActiveResolution && !allowGatewayQueueResolution) {
          preDispatchAbortOperation = admission.activeOperation;
        }
        preDispatchLifecycleAdmission = admission.lifecycleAdmission;
        if (allowActiveResolution && phase === "pre_dispatch") {
          preDispatchLifecycleAbortController = lifecycleOnlyAbortController;
        } else {
          dispatchLifecycleAbortController = lifecycleOnlyAbortController;
        }
        armPreDispatchLifecycleAbortRelease();
        return { status: "ready" };
      }
      admission.lifecycleAdmission?.release();
      dispatchAbortOperation = admission.activeOperation;
      logVerbose(
        `dispatch-from-config: skipped reply operation admission for ${dispatchOperationSessionKey}; reason=${admission.reason}`,
      );
      return { status: "busy" };
    }
    // Mark both initial and replacement admissions before a sibling can mistake
    // this recovery for the terminal predecessor it observed (#86827).
    if (
      replyTurnKind === "visible" &&
      isRecoverableTerminalSessionStatus(params.operationSessionStoreEntry.entry?.status) &&
      operationSessionId === params.operationSessionStoreEntry.entry?.sessionId
    ) {
      admission.operation.markTerminalRecovery();
    }
    dispatchReplyOperation = admission.operation;
    dispatchAbortOperation = admission.operation;
    params.replyOptions?.onReplyOperationOwned?.(admission.operation);
    return { status: "ready" };
  };

  let cachedOperationSignal: AbortSignal | undefined;
  let cachedLifecycleSignal: AbortSignal | undefined;
  let cachedUpstreamSignal: AbortSignal | undefined;
  let cachedPreDispatchAbortSignal: AbortSignal | undefined;
  const getPreDispatchAbortSignal = () => {
    const operationSignal = (dispatchAbortOperation ?? preDispatchAbortOperation)?.abortSignal;
    const lifecycleSignal = preDispatchLifecycleAbortController?.signal;
    const upstreamSignal = params.replyOptions?.abortSignal;
    if (
      cachedOperationSignal === operationSignal &&
      cachedLifecycleSignal === lifecycleSignal &&
      cachedUpstreamSignal === upstreamSignal
    ) {
      return cachedPreDispatchAbortSignal;
    }
    const abortSignals = [operationSignal, lifecycleSignal, upstreamSignal].filter(
      (signal): signal is AbortSignal => Boolean(signal),
    );
    cachedPreDispatchAbortSignal =
      abortSignals.length > 1 ? AbortSignal.any(abortSignals) : abortSignals[0];
    cachedOperationSignal = operationSignal;
    cachedLifecycleSignal = lifecycleSignal;
    cachedUpstreamSignal = upstreamSignal;
    return cachedPreDispatchAbortSignal;
  };

  const getDispatchAbortSignal = () => {
    // The full operation owns upstream cancellation and terminal delivery settlement.
    if (dispatchReplyOperation) {
      return dispatchReplyOperation.abortSignal;
    }
    const lifecycleSignal =
      dispatchLifecycleAbortController?.signal ?? preDispatchLifecycleAbortController?.signal;
    const upstreamSignal = params.replyOptions?.abortSignal;
    return lifecycleSignal && upstreamSignal
      ? AbortSignal.any([lifecycleSignal, upstreamSignal])
      : (lifecycleSignal ?? upstreamSignal);
  };

  const getQueuedFollowupAbortSignal = () =>
    params.replyOptions?.turnAdoptionLifecycle?.abortSignal ??
    dispatchReplyOperation?.abortSignal ??
    params.replyOptions?.abortSignal;
  let observedReplyDelivery = false;
  let agentRunTerminalOutcome: "completed" | "failed" | undefined;
  const observeDeliveryProgress = (
    deliveryOutcome: Promise<ReplyDispatchDeliveryOutcome> | undefined,
    event: string,
  ) => {
    const operation = dispatchReplyOperation;
    void deliveryOutcome?.then(
      (outcome) => {
        if (outcome === "delivered") {
          operation?.watchdog.progress("finalization", event);
        }
      },
      () => {},
    );
  };

  const markObservedReplyDelivery = async () => {
    if (observedReplyDelivery) {
      return;
    }
    observedReplyDelivery = true;
    dispatchReplyOperation?.watchdog.progress("finalization", "reply:delivery_observed");
    await params.replyOptions?.onObservedReplyDelivery?.();
  };
  const getReplyOptions = (): DispatchFromConfigParams["replyOptions"] => {
    const abortSignal = getDispatchAbortSignal();
    const expectedExistingSessionId = params.replyOptions?.expectedExistingSessionId
      ? (dispatchReplyOperation?.sessionId ??
        params.replyOptions.expectedActiveReplyOperation?.sessionId ??
        preDispatchAbortOperation?.sessionId ??
        admittedExpectedSessionId)
      : undefined;
    return {
      ...params.replyOptions,
      ...(expectedExistingSessionId ? { expectedExistingSessionId } : {}),
      ...(abortSignal
        ? {
            abortSignal,
            queuedFollowupAbortSignal: getQueuedFollowupAbortSignal(),
          }
        : {}),
      ...observeAgentRunStart(params.replyOptions, (start) => {
        agentRunTerminalOutcome = "completed";
        params.messageAuditTerminal?.observeRunId(start.runId);
      }),
      onAgentRunTerminalOutcome: (outcome) => {
        if (outcome === "failed" || agentRunTerminalOutcome === undefined) {
          agentRunTerminalOutcome = outcome;
        }
        params.replyOptions?.onAgentRunTerminalOutcome?.(outcome);
      },
      ...(dispatchReplyOperation ? { replyOperation: dispatchReplyOperation } : {}),
      // Native command continuations acquire their operation in the runner. Its
      // completion belongs to dispatch so the final answer retains delivery authority.
      onReplyOperationOwned: (operation: ReplyOperation) => {
        if (dispatchReplyOperation && dispatchReplyOperation !== operation) {
          throw new Error("Reply dispatch already owns another operation");
        }
        operation.abortSignal.throwIfAborted();
        params.replyOptions?.abortSignal?.throwIfAborted();
        params.replyOptions?.onReplyOperationOwned?.(operation);
        params.replyOptions?.internalEventExecution?.assertCurrent?.();
        dispatchReplyOperation = operation;
        dispatchAbortOperation = operation;
        admittedExpectedSessionId = operation.sessionId;
        return true;
      },
    };
  };

  const completeDispatchReplyOperation = () => {
    void releasePreDispatchLifecycleAdmission(waitForDispatchSettlement);
    const operation = dispatchReplyOperation;
    if (!operation) {
      return;
    }
    const timeoutPolicy = params.dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.();
    const complete = () => {
      if (params.replyOptions?.internalEventExecution) {
        // Source-owned effects retain the admitted operation until delivery settles.
        const settle = () =>
          operation.completeWithAfterClearBarrier(
            waitForReplyDispatcherSettlement(params.dispatcher),
            timeoutPolicy,
          );
        void waitForDispatchDelivery().then(settle, settle);
      } else {
        operation.completeWithAfterClearBarrier(waitForDispatchSettlement(), timeoutPolicy);
      }
    };
    // Abort races the resolver, not its bookkeeping. Retain this exact owner
    // until that work exits; delivery must remain after-clear to avoid queue cycles.
    if (dispatchLifecycleWork.owner.size > 0) {
      void Promise.allSettled(Array.from(dispatchLifecycleWork.owner)).then(complete);
    } else {
      complete();
    }
  };

  const failDispatchReplyOperation = (error: unknown, terminalOutcome?: "failed") => {
    if (terminalOutcome === "failed") {
      agentRunTerminalOutcome = "failed";
    }
    dispatchReplyOperation?.freezeAbort();
    if (dispatchReplyOperation && !dispatchReplyOperation.result) {
      dispatchReplyOperation.fail("run_failed", error);
    }
    completeDispatchReplyOperation();
  };

  const isDispatchOperationAborted = () => getDispatchAbortSignal()?.aborted === true;
  const isPreDispatchOperationAborted = () => getPreDispatchAbortSignal()?.aborted === true;
  const throwIfDispatchOperationAborted = () => {
    if (isDispatchOperationAborted()) {
      throw new DispatchReplyOperationAbortedError();
    }
  };

  const turnLedger = createReplyTurnLedger(params.dispatcher);
  return {
    completeDispatchReplyOperation,
    // Hook-queued payloads must settle through the turn ledger too, or a
    // hook-delivered visible reply could trigger the no-visible-reply fallback.
    dispatchHookDispatcher: createAbortAwareDispatcher({
      dispatcher: {
        ...params.dispatcher,
        sendToolResult: (payload) => turnLedger.sendQueued("tool", payload).queued,
        sendBlockReply: (payload) => turnLedger.sendQueued("block", payload).queued,
        sendFinalReply: (payload) => turnLedger.sendQueued("final", payload).queued,
        ...(params.dispatcher.sendPreparedReply
          ? {
              sendPreparedReply: (kind, plan) => turnLedger.sendPreparedQueued(kind, plan).queued,
            }
          : {}),
      },
      isAborted: isPreDispatchOperationAborted,
    }),
    turnLedger,
    ensureDispatchReplyOperation,
    failDispatchReplyOperation,
    getAgentRunTerminalOutcome: () => agentRunTerminalOutcome,
    getDispatchAbortOperation: () => dispatchAbortOperation,
    getDispatchAbortSignal,
    getDispatchReplyOperation: () => dispatchReplyOperation,
    getReplyOptions,
    getObservedReplyDelivery: () => observedReplyDelivery,
    getPreDispatchAbortSignal,
    isDispatchOperationAborted,
    isPreDispatchOperationAborted,
    markObservedReplyDelivery,
    observeDeliveryProgress,
    releasePreDispatchLifecycleAdmission,
    runWithDispatchLifecycleAdmission,
    throwIfDispatchOperationAborted,
    trackDispatchLifecycleWork,
  };
}
