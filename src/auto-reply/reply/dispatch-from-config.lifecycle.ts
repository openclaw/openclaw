import crypto from "node:crypto";
import { resolveActiveEmbeddedRunSessionId } from "../../agents/embedded-agent-runner/active-run-projections.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { captureSessionEntrySourceAssertion } from "../../config/sessions/session-entry-source-authority.js";
import { isRecoverableTerminalSessionStatus } from "../../config/sessions/terminal-status.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionWorkerPlacementContext } from "../../gateway/worker-environments/session-placement-lifecycle.js";
import { logVerbose } from "../../globals.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import { captureCommandOwnerAssertion } from "../command-owner-authority.js";
import {
  isNativeCommandTurn,
  resolveCommandTurnTargetSessionKey,
} from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import {
  createAbortAwareDispatcher,
  DispatchReplyOperationAbortedError,
} from "./dispatch-from-config.abort.js";
import { restoreArchivedDispatchSession } from "./dispatch-from-config.archive-recovery.js";
import type { InboundMessageAuditTerminalRecorder } from "./dispatch-from-config.audit.js";
import {
  resolveDispatchResetAdmission,
  shouldLetSlackRoutedThreadBypassBusyReplyOperation,
} from "./dispatch-from-config.context.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { DispatchSessionRefreshRequiredError } from "./dispatch-session-refresh-error.js";
import { waitForReplyDispatcherIdle } from "./reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import {
  forceClearReplyRunBySessionId,
  replyRunRegistry,
  type ReplyOperation,
  waitForReplyBarrierSettlement,
} from "./reply-run-registry.js";
import { admitReplyTurn, runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";
import { resolveReplyTurnKind } from "./reply-turn-kind.js";

type DispatchReplyOperationAcquisition =
  | { status: "ready" }
  | { status: "busy" }
  | { status: "aborted" };

export function createDispatchReplyOperationCoordinator(params: {
  allowActiveQueueResolution?: boolean;
  assertCurrent?: () => void;
  agentId: string;
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  dispatchOperationSessionKey?: string;
  initialDispatchReplyOperation?: ReplyOperation;
  messageAuditTerminal?: InboundMessageAuditTerminalRecorder;
  operationSessionStoreEntry: {
    entry?: SessionEntry;
    storePath?: string;
  };
  targetSessionStoreEntry?: {
    agentId?: string;
    entry?: SessionEntry;
    sessionKey?: string;
    storePath?: string;
  };
  replyOptions?: DispatchFromConfigParams["replyOptions"];
  sessionWorkerPlacementContext?: SessionWorkerPlacementContext;
  resolveOperationExpectedSessionId: () => string | undefined;
  routeThreadId?: string | number;
}) {
  let dispatchReplyOperation: ReplyOperation | undefined;
  let admittedExpectedSessionId: string | undefined;
  let dispatchAbortOperation: ReplyOperation | undefined;
  let preDispatchAbortOperation: ReplyOperation | undefined;
  let preDispatchLifecycleAdmission: SessionWorkAdmissionLease | undefined;
  let removePreDispatchLifecycleAbortListener: (() => void) | undefined;
  let preDispatchLifecycleAbortController: AbortController | undefined;
  let dispatchLifecycleAbortController: AbortController | undefined;
  let preDispatchLifecycleInterrupted = false;
  let dispatchResetTriggered = false;
  let restoreNativeResetTarget: (() => Promise<void>) | undefined;
  const restorePendingNativeResetTarget = async () => {
    const restore = restoreNativeResetTarget;
    restoreNativeResetTarget = undefined;
    await restore?.();
  };
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
    if (!dispatchReplyOperation && !preDispatchLifecycleAdmission) {
      return;
    }
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
        waitForReplyDispatcherIdle(params.dispatcher),
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
    return preDispatchLifecycleAdmission
      ? await preDispatchLifecycleAdmission.run(run)
      : await run();
  };

  const ensureDispatchReplyOperation = async (
    phase: "pre_dispatch" | "command_resolution" | "dispatch",
    hasPluginOwnedBinding = false,
  ): Promise<DispatchReplyOperationAcquisition> => {
    // Archive restoration belongs to pre-dispatch ownership resolution. Later calls only upgrade admission.
    if (phase === "pre_dispatch") {
      const target = params.targetSessionStoreEntry;
      const nativeTarget = resolveCommandTurnTargetSessionKey(params.ctx);
      const effectiveNativeTarget =
        nativeTarget ??
        (target &&
        target.sessionKey === params.dispatchOperationSessionKey &&
        target.sessionKey === params.ctx.SessionKey
          ? target.sessionKey
          : undefined);
      const authorizedNativeCommand =
        isNativeCommandTurn(params.ctx.CommandTurn) &&
        params.ctx.CommandTurn?.authorized === true &&
        params.ctx.CommandAuthorized;
      const nativeReset =
        authorizedNativeCommand &&
        target !== undefined &&
        effectiveNativeTarget === target.sessionKey &&
        (params.ctx.CommandTurn?.commandName?.toLowerCase() === "new" ||
          params.ctx.CommandTurn?.commandName?.toLowerCase() === "reset") &&
        (
          await resolveDispatchResetAdmission({
            agentId: target.agentId ?? params.agentId,
            cfg: params.cfg,
            ctx: params.ctx,
            entry: target.entry,
            hasPluginOwnedBinding,
            sessionKey: target.sessionKey,
            storePath: target.storePath,
          })
        ).resetTriggered;
      const detachedNativeSource =
        authorizedNativeCommand &&
        nativeTarget !== undefined &&
        nativeTarget !== params.dispatchOperationSessionKey &&
        params.dispatchOperationSessionKey === params.ctx.SessionKey &&
        nativeTarget === target?.sessionKey &&
        target.entry?.pluginOwnerId === undefined &&
        (target.entry?.archivedAt === undefined || nativeReset);
      const restoringDetachedNativeSource =
        detachedNativeSource && params.operationSessionStoreEntry.entry?.archivedAt !== undefined;
      const assertCommandOwnerCurrent = captureCommandOwnerAssertion(params.ctx);
      const assertRestoreCurrent = () => {
        params.assertCurrent?.();
        params.replyOptions?.assertChannelAuthority?.();
        assertCommandOwnerCurrent?.();
        params.replyOptions?.operatorAuthority?.assertCurrent();
        params.replyOptions?.abortSignal?.throwIfAborted();
      };
      const targetGuard =
        restoringDetachedNativeSource && target?.sessionKey && target.storePath
          ? captureSessionEntrySourceAssertion({
              scope: {
                agentId: target.agentId ?? params.agentId,
                sessionKey: target.sessionKey,
                storePath: target.storePath,
              },
              expected: target.entry,
              fields: ["sessionId", "archivedAt", "pluginOwnerId", "lifecycleRevision"],
              assertCurrent: assertRestoreCurrent,
              refuse: () => {
                throw new DispatchSessionRefreshRequiredError(
                  new Error(
                    "Command target changed while restoring archived work. Retry the request.",
                  ),
                );
              },
            })
          : undefined;
      params.operationSessionStoreEntry.entry = await restoreArchivedDispatchSession({
        ctx: params.ctx,
        entry: params.operationSessionStoreEntry.entry,
        hasPluginOwnedBinding,
        allowNativeCommandRestore: detachedNativeSource,
        additionalCommitGuard: targetGuard,
        targetMutationScope:
          restoringDetachedNativeSource && target?.sessionKey && target.storePath
            ? { sessionKey: target.sessionKey, storePath: target.storePath, expected: target.entry }
            : undefined,
        assertCurrent: isNativeCommandTurn(params.ctx.CommandTurn)
          ? assertRestoreCurrent
          : undefined,
        requireSnapshotMatch: detachedNativeSource,
        placementContext: params.sessionWorkerPlacementContext,
        sessionKey: params.dispatchOperationSessionKey,
        storePath: params.operationSessionStoreEntry.storePath,
      });
      if (nativeReset && target) {
        const restoreTarget = async () => {
          target.entry = await restoreArchivedDispatchSession({
            ctx: params.ctx,
            entry: target.entry,
            hasPluginOwnedBinding,
            allowNativeCommandRestore: true,
            assertCurrent: assertRestoreCurrent,
            requireSnapshotMatch: true,
            placementContext: params.sessionWorkerPlacementContext,
            sessionKey: target.sessionKey,
            storePath: target.storePath,
          });
        };
        if (target.sessionKey === params.dispatchOperationSessionKey) {
          await restoreTarget();
          params.operationSessionStoreEntry.entry = target.entry;
        } else {
          restoreNativeResetTarget = restoreTarget;
        }
      }
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
    const activeReplyOperation = replyRunRegistry.get(dispatchOperationSessionKey);
    const activeEmbeddedSessionId = resolveActiveEmbeddedRunSessionId(dispatchOperationSessionKey);
    const allowGatewayQueueResolution =
      (replyTurnKind === "visible" || params.replyOptions?.internalEventExecution !== undefined) &&
      (params.replyOptions?.turnAdoptionLifecycle !== undefined ||
        params.allowActiveQueueResolution === true);
    if (
      allowGatewayQueueResolution &&
      (activeReplyOperation
        ? phase !== "pre_dispatch" &&
          (activeReplyOperation.turnKind !== "heartbeat" ||
            params.replyOptions?.internalEventExecution !== undefined)
        : activeEmbeddedSessionId === operationSessionId)
    ) {
      // Queue policy must steer the existing backend instead of creating a competing run.
      // An embedded owner can outlive its reply-operation registration, including pre-dispatch.
      // Registered owners first retain pre-dispatch admission, then resolve the queue in getReplyFromConfig.
      return { status: "ready" };
    }
    if (phase !== "pre_dispatch") {
      // Queue resolution still writes session metadata. Keep its borrowed lease
      // until the resolver settles or a full reply operation takes ownership.
      await releasePreDispatchLifecycleAdmission(() =>
        waitForReplyDispatcherIdle(params.dispatcher),
      );
      if (preDispatchLifecycleInterrupted) {
        return { status: dispatchReplyOperation ? "aborted" : "busy" };
      }
    }
    const allowActiveResolution =
      (replyTurnKind === "visible" || params.replyOptions?.internalEventExecution !== undefined) &&
      (phase === "pre_dispatch" || phase === "command_resolution");
    const allowSlackRoutedThreadBypass =
      phase !== "pre_dispatch" &&
      shouldLetSlackRoutedThreadBypassBusyReplyOperation({
        activeOperation: replyRunRegistry.get(dispatchOperationSessionKey),
        ctx: params.ctx,
        routeThreadId: params.routeThreadId,
      });
    const lifecycleOnlyAbortController =
      allowActiveResolution || allowSlackRoutedThreadBypass ? new AbortController() : undefined;
    const onLifecycleInterrupt = () => {
      preDispatchLifecycleInterrupted = true;
      lifecycleOnlyAbortController?.abort();
    };
    const admitCurrentReplyTurn = async () => {
      try {
        return await admitReplyTurn({
          assertRequestCurrent: () => {
            params.replyOptions?.operatorAuthority?.assertCurrent();
            params.replyOptions?.internalEventExecution?.assertCurrent?.();
          },
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
          originatingLeafEntryId:
            params.replyOptions?.turnAdoptionLifecycle?.originatingLeafEntryId,
          upstreamAbortSignal: params.replyOptions?.abortSignal,
          waitForActive: !allowActiveResolution && !allowSlackRoutedThreadBypass,
          retainLifecycleAdmissionOnActive: allowActiveResolution || allowSlackRoutedThreadBypass,
          onLifecycleInterrupt,
        });
      } catch (error) {
        if (
          phase === "pre_dispatch" &&
          replyTurnKind === "visible" &&
          isSessionWorkStartInvalidatedError(error)
        ) {
          throw new DispatchSessionRefreshRequiredError(error);
        }
        throw error;
      }
    };
    let admission = await admitCurrentReplyTurn();
    if (
      admission.status === "skipped" &&
      admission.reason === "active-run" &&
      // Only visible turns may clear a terminal predecessor in this session.
      // A concurrent reset or recovery may already own the key; neither a new
      // session nor a marked recovery may be cleared by this stale snapshot.
      replyTurnKind === "visible" &&
      isRecoverableTerminalSessionStatus(params.operationSessionStoreEntry.entry?.status) &&
      admission.activeOperation?.sessionId === params.operationSessionStoreEntry.entry?.sessionId &&
      !admission.activeOperation?.terminalRecovery
    ) {
      const cleared = forceClearReplyRunBySessionId(
        admission.activeOperation?.sessionId ?? operationSessionId,
        new Error("clearing stale terminal reply operation"),
      );
      if (cleared) {
        admission.lifecycleAdmission?.release();
        logVerbose(
          `dispatch-from-config: cleared stale active reply operation for terminal session ${dispatchOperationSessionKey}`,
        );
        admission = await admitCurrentReplyTurn();
      }
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
      if (
        admission.reason === "active-run" &&
        (allowActiveResolution ||
          shouldLetSlackRoutedThreadBypassBusyReplyOperation({
            activeOperation: admission.activeOperation,
            ctx: params.ctx,
            routeThreadId: params.routeThreadId,
          }))
      ) {
        if (allowActiveResolution) {
          preDispatchAbortOperation = admission.activeOperation;
        }
        preDispatchLifecycleAdmission = admission.lifecycleAdmission;
        if (allowActiveResolution && phase === "pre_dispatch") {
          preDispatchLifecycleAbortController = lifecycleOnlyAbortController;
        } else {
          dispatchLifecycleAbortController = lifecycleOnlyAbortController;
        }
        armPreDispatchLifecycleAbortRelease();
        if (!allowActiveResolution) {
          logVerbose(
            `dispatch-from-config: allowing Slack routed thread ${params.routeThreadId} while ${dispatchOperationSessionKey} has an active reply operation in another Slack thread`,
          );
        }
        await restorePendingNativeResetTarget();
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
    dispatchReplyOperation.retainFailureUntilComplete();
    dispatchAbortOperation = admission.operation;
    params.replyOptions?.onReplyOperationOwned?.(admission.operation);
    await restorePendingNativeResetTarget();
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
  let agentRunId = params.replyOptions?.runId;
  const markObservedReplyDelivery = async () => {
    if (observedReplyDelivery) {
      return;
    }
    observedReplyDelivery = true;
    await params.replyOptions?.onObservedReplyDelivery?.();
  };
  const getReplyOptions = (): DispatchFromConfigParams["replyOptions"] => {
    const abortSignal = getDispatchAbortSignal();
    const expectedExistingSessionId = params.replyOptions?.expectedExistingSessionId
      ? (dispatchReplyOperation?.sessionId ?? admittedExpectedSessionId)
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
      onAgentRunStart: (...args) => {
        agentRunTerminalOutcome = "completed";
        // Execution may generate its ID in copied options; finalization needs the observed run.
        agentRunId = args[0];
        params.messageAuditTerminal?.observeRunId(args[0]);
        return params.replyOptions?.onAgentRunStart?.(...args);
      },
      onAgentRunTerminalOutcome: (outcome) => {
        if (outcome === "failed" || agentRunTerminalOutcome === undefined) {
          agentRunTerminalOutcome = outcome;
        }
        params.replyOptions?.onAgentRunTerminalOutcome?.(outcome);
      },
      ...(dispatchReplyOperation ? { replyOperation: dispatchReplyOperation } : {}),
      ...(params.replyOptions?.internalEventExecution
        ? {
            onReplyOperationOwned: (operation: ReplyOperation) => {
              if (dispatchReplyOperation && dispatchReplyOperation !== operation) {
                throw new Error("Reply dispatch already owns another operation");
              }
              operation.abortSignal.throwIfAborted();
              params.replyOptions?.abortSignal?.throwIfAborted();
              params.replyOptions?.onReplyOperationOwned?.(operation);
              params.replyOptions?.internalEventExecution?.assertCurrent?.();
              operation.retainFailureUntilComplete();
              dispatchReplyOperation = operation;
              dispatchAbortOperation = operation;
              admittedExpectedSessionId = operation.sessionId;
              return true;
            },
          }
        : {}),
    };
  };

  const completeDispatchReplyOperation = () => {
    void releasePreDispatchLifecycleAdmission(() => waitForReplyDispatcherIdle(params.dispatcher));
    const operation = dispatchReplyOperation;
    if (!operation) {
      return;
    }
    const timeoutPolicy = params.dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.();
    const complete = () => {
      if (params.replyOptions?.internalEventExecution) {
        // Source-owned effects retain the admitted operation until delivery settles.
        const settle = () => operation.complete();
        void waitForDispatchDelivery().then(settle, settle);
      } else {
        operation.completeWithAfterClearBarrier(waitForDispatchDelivery(), timeoutPolicy);
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
    getAgentRunId: () => agentRunId,
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
    releasePreDispatchLifecycleAdmission,
    runWithDispatchLifecycleAdmission,
    throwIfDispatchOperationAborted,
    trackDispatchLifecycleWork,
  };
}
