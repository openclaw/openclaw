import { randomUUID } from "node:crypto";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createRestartRecoveryOperatorSource } from "../../agents/operator-run-recovery-source.js";
import { captureRequesterOrigin } from "../../agents/requester-origin.js";
import { createRestartRecoveryRequesterSource } from "../../agents/requester-run-recovery-source.js";
import {
  buildRestartRecoveryClaimCleanupPatch,
  getRestartRecoveryPendingFinalSourceRunId,
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
  isMainRestartRecoveryCandidate,
  recordLifecycleFence,
} from "../../config/sessions/restart-recovery-state.js";
import { patchSessionEntryTarget } from "../../config/sessions/session-accessor.js";
import { applySessionEntryTargetOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntryTargetPatchScope } from "../../config/sessions/session-accessor.types.js";
import type {
  SessionActor,
  SessionActorAuthority,
} from "../../config/sessions/session-actor-contract.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { bindUserTurnInputActor } from "../../config/sessions/session-input-actor.js";
import type { SessionTranscriptTurnLifecyclePatch } from "../../config/sessions/session-transcript-turn-lifecycle.types.js";
import {
  buildRestartRecoveryExpectedState,
  sessionMatchesExpectedTranscriptTurn,
} from "../../config/sessions/session-transcript-turn-state.js";
import {
  isTerminalSessionStatus,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions/types.js";
import { resolveSessionWorkerPlacementContext } from "../../gateway/session-worker-placement-context.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  createAgentRunStaleLifecycleError,
  createRestartRecoveryClaimChangedError,
  isAgentRunStaleLifecycleError,
} from "../../infra/agent-lifecycle-error.js";
import { wrapSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { isMainSessionRestartRecoveryInputProvenance } from "../../sessions/input-provenance.js";
import type { AgentTurnRestartClaimCleanup } from "./agent-runner-completion.types.js";
import type {
  ReplyAdmissionPatch,
  ReplyRestartRecoveryClaimController,
  ReplyRestartRecoveryClaimControllerParams,
  ReplyRecoveryAdoption,
} from "./restart-recovery-claim.types.js";
import { readReplyAdmissionSession } from "./restart-recovery-placement.js";
import { retireTerminalRestartRecoverySourceClaim } from "./restart-recovery-source.js";

export function createReplyRestartRecoveryClaimController(
  params: ReplyRestartRecoveryClaimControllerParams,
): ReplyRestartRecoveryClaimController {
  const requesterOrigin = captureRequesterOrigin({ requesterOrigin: params.requesterOrigin });
  const sourceTurnId = normalizeOptionalString(params.sourceTurnId);
  // The retry shares delivery correlation with its parent, but owns one internal admission.
  const strandedRetryRunId =
    params.strandedReplyRetry === true && sourceTurnId
      ? `stranded-reply-retry:${sourceTurnId}`
      : undefined;
  let recoveryRunId =
    strandedRetryRunId ?? normalizeOptionalString(params.admissionRunId) ?? randomUUID();
  const executionRunId = params.executionRunId ?? recoveryRunId;
  const executionGeneration = params.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  let recoverySourceRunId: string | undefined;
  let trackedSessionId: string | undefined;
  let trackedLifecycleRevision: string | undefined;
  let tracked = false;
  let confirmedArmed = false;
  let sessionActor: SessionActor | undefined;
  let readTarget: SessionEntryTargetPatchScope | undefined;
  const recordReadTarget = (target: SessionEntryTargetPatchScope) => (readTarget ??= target);
  const preparedTarget = () => {
    if (!readTarget) {
      throw new Error("Restart recovery claim has no admitted session target");
    }
    return readTarget;
  };
  const isExecutionFence = (run: NonNullable<SessionEntry["restartRecoveryRuns"]>[number]) =>
    run.runId === executionRunId && run.lifecycleGeneration === executionGeneration;
  const isTrackedClaim = (entry: SessionEntry | undefined) =>
    entry !== undefined &&
    entry.sessionId === trackedSessionId &&
    entry.sessionId === params.getSessionId() &&
    entry.lifecycleRevision === trackedLifecycleRevision &&
    (entry.restartRecoveryDeliveryRunId !== undefined
      ? entry.restartRecoveryDeliveryRunId === recoveryRunId &&
        normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) === recoverySourceRunId
      : entry.restartRecoveryRuns?.some(isExecutionFence) === true);
  const recordAdmittedClaim = (entry: SessionEntry, exactRunId?: string) => {
    recoveryRunId = exactRunId ?? recoveryRunId;
    recoverySourceRunId = normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId);
    trackedSessionId = entry.sessionId;
    trackedLifecycleRevision = entry.lifecycleRevision;
    tracked = exactRunId !== undefined || isTrackedClaim(entry);
    params.setEntry(entry);
  };
  const assertReadCurrent = () => {
    if (params.lifecycleGeneration) {
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
    }
  };

  const assertClaimCurrent = (sessionId: string) => {
    assertReadCurrent();
    if (params.getSessionId() !== sessionId) {
      throw createRestartRecoveryClaimChangedError();
    }
  };

  const readAuthority: SessionActorAuthority = {
    assertCurrent: assertReadCurrent,
    authorize: assertReadCurrent,
  };
  const acquireActor = async () => {
    if (!sessionActor) {
      const acquired = await params.acquireSessionActor();
      assertReadCurrent();
      if (!acquired) {
        return undefined;
      }
      recordReadTarget(acquired.target);
      sessionActor = acquired.actor;
    }
    return sessionActor;
  };
  const readEntry = async (sessionKey: string) => {
    const actor = await acquireActor();
    if (actor) {
      return (actor.snapshot(readAuthority) ?? (await actor.read(readAuthority))).entry;
    }
    return readSessionEntryInWorker(
      { agentId: params.agentId, sessionKey, storePath: params.storePath },
      assertReadCurrent,
      undefined,
      recordReadTarget,
    );
  };
  const adoptLifecycle = async (options: ReplyRecoveryAdoption): Promise<SessionEntry> => {
    const actor = await acquireActor();
    const sessionId = options.entry.sessionId;
    const expectedState = buildRestartRecoveryExpectedState(options.entry);
    const validate = (entry: SessionEntry | undefined) => {
      if (
        !entry ||
        entry.lifecycleRevision !== options.entry.lifecycleRevision ||
        !sessionMatchesExpectedTranscriptTurn(
          { entry },
          { expectedSessionId: sessionId, expectedSessionState: expectedState },
        ) ||
        (options.validate && !options.validate(entry))
      ) {
        throw createRestartRecoveryClaimChangedError();
      }
    };
    const assertCurrent = () => {
      assertClaimCurrent(sessionId);
      params.operatorAuthority?.assertCurrent();
      options.writer?.assertCurrent?.();
    };
    if (!actor) {
      const committed = await patchSessionEntryTarget(
        preparedTarget(),
        (entry) => {
          validate(entry);
          return options.patch;
        },
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
          preserveActivity: options.patch.updatedAt === options.entry.updatedAt,
          workerGuard: { assertCurrent },
        },
      );
      if (!committed) {
        throw createRestartRecoveryClaimChangedError();
      }
      options.committed(committed);
      return committed;
    }
    let admitted = false;
    let authorityFailure: unknown;
    const authorize = (stage?: "transaction" | "commit", entry?: SessionEntry) => {
      try {
        assertCurrent();
        if (stage === "transaction" && !admitted) {
          validate(entry);
          admitted = true;
        }
      } catch (error) {
        authorityFailure = error;
        throw error;
      }
    };
    let committed: SessionEntry | undefined;
    let pending: ReturnType<SessionActor["adoptRun"]>;
    try {
      pending = actor.adoptRun(
        {
          commandId: randomUUID(),
          phaseId: "reply.restart-recovery",
          sessionId,
          expectedState,
          lifecycle: options.patch,
          runId: options.writer?.runId,
        },
        {
          assertCurrent: authorize,
          authorize: (stage, facts) => authorize(stage, facts.entry),
        },
        {
          committed(receipt) {
            committed = receipt.receipt.postimage.entry;
            if (!committed) {
              throw new Error("Committed restart recovery adoption omitted its session");
            }
            options.committed(committed);
          },
        },
      );
    } catch (error) {
      // Synchronous rejection precedes actor acceptance; no write can have started.
      options.rolledBack?.();
      throw error;
    }
    const outcome = await pending;
    if (outcome.kind === "committed") {
      if (outcome.failure && outcome.failure.origin !== "response") {
        throw Object.assign(new Error(outcome.failure.message), { name: outcome.failure.name });
      }
      if (!committed) {
        throw new Error("Restart recovery adoption omitted its committed receipt");
      }
      return committed;
    }
    if (outcome.kind === "unknown") {
      throw wrapSqliteWorkerError(outcome.error.message, "outcome-unknown", outcome.error);
    }
    options.rolledBack?.();
    if (authorityFailure) {
      throw toErrorObject(authorityFailure, "Restart recovery authority rejected the operation");
    }
    throw Object.assign(new Error(outcome.error.message), { name: outcome.error.name });
  };

  const persistAdmissionPatch = async (options: ReplyAdmissionPatch): Promise<SessionEntry> => {
    const expectedSessionState = buildRestartRecoveryExpectedState(options.entry);
    // A staged event remains durable while waiting for the execution lane. Promoting
    // it here would let an earlier completion mistake the queued input for an orphan.
    const pendingInternalInput =
      params.inputProvenance?.kind === "internal_system" &&
      options.recorder?.getPendingInputMessage?.() !== undefined;
    if (options.recorder && !options.recorder.hasPersisted() && !pendingInternalInput) {
      bindUserTurnInputActor(options.recorder, {
        phase: "adoptRun",
        acquire: async () => {
          const actor = await acquireActor();
          return actor ? { actor, target: preparedTarget() } : undefined;
        },
      });
      const result = await options.recorder.persistApproved({
        target: params.resolveUserTurnTarget?.({
          entry: options.entry,
          sessionId: options.sessionId,
          sessionKey: options.sessionKey,
          storePath: options.storePath,
        }),
        expectedSessionId: options.sessionId,
        expectedSessionState,
        sessionLifecyclePatch: options.patch,
      });
      if (!result?.sessionEntry) {
        throw new Error("session changed before durable user-turn admission");
      }
      return result.sessionEntry;
    }
    return adoptLifecycle({
      entry: options.entry,
      patch: options.patch,
      committed: (entry) => recordAdmittedClaim(entry),
    });
  };

  const admitUserTurn: ReplyRestartRecoveryClaimController["admitUserTurn"] = async (recorder) => {
    if (!params.sessionKey || !params.storePath) {
      await recorder?.persistApproved();
      return "admitted";
    }
    const sessionId = params.getSessionId();
    assertReadCurrent();
    const hasPendingPlacementInput = () =>
      Boolean(recorder?.getPendingInputMessage?.() && !recorder.hasPersisted());
    const pendingPlacementInput = hasPendingPlacementInput();
    const placementContext = pendingPlacementInput
      ? resolveSessionWorkerPlacementContext()
      : undefined;
    const sessionKey = params.sessionKey;
    const { entry, stagedWorkerInput } = await readReplyAdmissionSession({
      sessionId,
      placementContext,
      readEntry: () => readEntry(sessionKey),
      assertCurrent: () => {
        assertReadCurrent();
        if (params.getSessionId() !== sessionId) {
          throw new Error("session changed before durable user-turn admission");
        }
        if (hasPendingPlacementInput() !== pendingPlacementInput) {
          throw new Error("pending user turn changed before durable user-turn admission");
        }
      },
    });
    const admissionRunId = strandedRetryRunId ?? normalizeOptionalString(params.admissionRunId);
    const activeClaimRunId = normalizeOptionalString(entry.restartRecoveryDeliveryRunId);
    const isExactRecoveryClaim = admissionRunId && activeClaimRunId === admissionRunId;
    if (
      strandedRetryRunId &&
      (activeClaimRunId === strandedRetryRunId ||
        hasRestartRecoveryTerminalRun(entry, strandedRetryRunId))
    ) {
      return "duplicate-source";
    }
    if (sourceTurnId && !strandedRetryRunId) {
      if (hasRestartRecoveryTerminalRun(entry, sourceTurnId)) {
        return "duplicate-source";
      }
      if (!isExactRecoveryClaim && hasRestartRecoverySourceClaim(entry, sourceTurnId)) {
        const retired = await retireTerminalRestartRecoverySourceClaim({
          target: preparedTarget(),
          assertCurrent: assertReadCurrent,
          sessionId,
          sourceTurnId,
        });
        if (retired) {
          params.setEntry(retired);
        }
        return "duplicate-source";
      }
    }
    if (stagedWorkerInput) {
      // A staged worker input belongs to placement admission, not local restart
      // recovery. Its runtime writer consumes it only after setup and sync finish.
      return "admitted";
    }
    if (isExactRecoveryClaim) {
      if (isTerminalSessionStatus(entry.status) || entry.abortedLastRun === true) {
        throw createRestartRecoveryClaimChangedError();
      }
      // Clear the retry verifier as the exact admitted claim crosses into execution.
      const preservesTerminalReceipt =
        entry.restartRecoveryDeliveryReceiptState === "terminal-pending";
      const patch: SessionTranscriptTurnLifecyclePatch = {
        lifecycleRunId: executionRunId,
        lastRunId: undefined,
        restartRecoveryBeforeAgentReplyState: undefined,
        ...(preservesTerminalReceipt
          ? {}
          : {
              restartRecoveryDeliveryReceiptState: undefined,
              restartRecoveryDeliveryToolCallId: undefined,
              restartRecoveryDeliveryRequestFingerprint: undefined,
            }),
        restartRecoverySourceIngress: entry.restartRecoverySourceIngress ?? "control-ui",
        // Input acceptance already records activity; adoption only changes custody.
        updatedAt: entry.updatedAt,
      };
      if (isMainRestartRecoveryCandidate(entry, params.sessionKey)) {
        patch.restartRecoveryRuns = entry.restartRecoveryRuns;
        recordLifecycleFence(patch, {
          runId: executionRunId,
          lifecycleGeneration: executionGeneration,
        });
      }
      const admission = params.operationAdmission;
      if (
        sessionActor &&
        admission &&
        (!recorder || recorder.hasPersisted()) &&
        !preservesTerminalReceipt &&
        !entry.restartRecoveryBeforeAgentReplyState &&
        !isMainSessionRestartRecoveryInputProvenance(params.inputProvenance)
      ) {
        // The accepted input already survives restart; track it for cancellation
        // while the native capacity owner delays writer adoption.
        recordAdmittedClaim(entry, admissionRunId);
        // Preserve activity written while this input waits for capacity.
        delete patch.updatedAt;
        // A rejected outcome stays installed so fallback cannot replay an uncertain write.
        let adoption: Promise<SessionEntry> | undefined;
        admission.adoptInput = (writer) => {
          if (!adoption) {
            // Uncertain adoption must not clear a possibly committed claim.
            tracked = false;
            adoption = adoptLifecycle({
              entry,
              patch,
              writer,
              committed: (committed) => recordAdmittedClaim(committed, admissionRunId),
              rolledBack: () => {
                tracked = true;
              },
            }).then((committed) => {
              admission.adoptInput = undefined;
              return committed;
            });
          }
          return adoption;
        };
        return "admitted";
      }
      const adopted = await persistAdmissionPatch({
        entry,
        patch,
        recorder,
        sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
      recordAdmittedClaim(adopted, admissionRunId);
      return "admitted";
    }

    const deliveryContext = params.resolveDeliveryContext(entry);
    const recoverableDeliveryContext =
      deliveryContext && sourceTurnId ? deliveryContext : undefined;
    if (recoverableDeliveryContext && !strandedRetryRunId) {
      const sourceMessage = recorder?.getPersistedMessage?.() ?? (await recorder?.resolveMessage());
      const persistedSourceTurnId = normalizeOptionalString(sourceMessage?.idempotencyKey);
      if (!recorder || persistedSourceTurnId !== sourceTurnId) {
        throw new Error("channel restart recovery requires source-keyed user-turn admission");
      }
    }
    const operatorSource =
      !recoverableDeliveryContext && !sourceTurnId
        ? createRestartRecoveryOperatorSource({
            authority: params.operatorAuthority,
            entry,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            sourceRunId: recoveryRunId,
            inputProvenance: params.inputProvenance,
            requesterOrigin,
          })
        : undefined;
    if (
      !recoverableDeliveryContext &&
      !activeClaimRunId &&
      (!recorder || recorder.hasPersisted()) &&
      !operatorSource
    ) {
      // These turns have no admission write to extend; lifecycle start owns their claim.
      return "admitted";
    }
    const updatedAt = Date.now();
    const canTransferAbortedControlUiClaim = Boolean(
      admissionRunId &&
      activeClaimRunId &&
      admissionRunId !== activeClaimRunId &&
      entry.abortedLastRun === true &&
      (entry.status === undefined || entry.status === "interrupted") &&
      entry.pendingFinalDelivery === undefined &&
      entry.restartRecoveryBeforeAgentReplyState === undefined &&
      entry.restartRecoveryDeliveryReceiptState === undefined &&
      entry.restartRecoverySourceIngress === "control-ui",
    );
    if (
      activeClaimRunId &&
      !canTransferAbortedControlUiClaim &&
      (entry.abortedLastRun === true ||
        !isTerminalSessionStatus(entry.status) ||
        entry.status === "interrupted" ||
        entry.restartRecoveryDeliveryReceiptState === "terminal-pending")
    ) {
      throw createRestartRecoveryClaimChangedError();
    }
    const retiredClaim = activeClaimRunId
      ? buildRestartRecoveryClaimCleanupPatch({
          entry,
          recordTerminalSource: true,
          terminalSourceRunId: normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId),
        })
      : {};
    const transfersControlUiClaim = canTransferAbortedControlUiClaim && !recoverableDeliveryContext;
    const claimSourceRunId =
      transfersControlUiClaim || operatorSource
        ? recoveryRunId
        : recoverableDeliveryContext
          ? sourceTurnId
          : undefined;
    const patch: SessionTranscriptTurnLifecyclePatch = {
      ...retiredClaim,
      abortedLastRun: false,
      endedAt: undefined,
      lifecycleRunId: executionRunId,
      lastRunId: undefined,
      restartRecoveryBeforeAgentReplyState: undefined,
      restartRecoveryDeliveryReceiptState: undefined,
      restartRecoveryDeliveryToolCallId: undefined,
      restartRecoveryDeliveryContext: recoverableDeliveryContext,
      restartRecoveryDeliveryRequestFingerprint: undefined,
      restartRecoveryDeliveryRunId:
        recoverableDeliveryContext || transfersControlUiClaim || operatorSource
          ? recoveryRunId
          : undefined,
      restartRecoveryOperatorSource: operatorSource,
      restartRecoveryRequesterSource: claimSourceRunId
        ? createRestartRecoveryRequesterSource({
            requesterOrigin,
            entry,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            sourceRunId: claimSourceRunId,
          })
        : undefined,
      restartRecoveryDeliverySourceRunId: claimSourceRunId,
      restartRecoveryRequesterAccountId: transfersControlUiClaim
        ? undefined
        : normalizeOptionalString(params.requesterAccountId),
      restartRecoveryRequesterSenderId: transfersControlUiClaim
        ? undefined
        : normalizeOptionalString(params.requesterSenderId),
      restartRecoverySameChannelThreadRequired:
        !transfersControlUiClaim && params.sameChannelThreadRequired === true ? true : undefined,
      restartRecoverySourceIngress: recoverableDeliveryContext
        ? "channel"
        : transfersControlUiClaim
          ? "control-ui"
          : operatorSource && params.inputProvenance?.kind === "inter_session"
            ? "internal"
            : operatorSource?.snapshot.sourceIngress,
      restartRecoverySourceReplyDeliveryMode: transfersControlUiClaim
        ? undefined
        : params.sourceReplyDeliveryMode,
      runtimeMs: undefined,
      startedAt: updatedAt,
      status: undefined,
      lastRunError: undefined,
      updatedAt,
    };
    patch.restartRecoveryRuns = entry.restartRecoveryRuns;
    if (isMainRestartRecoveryCandidate(entry, params.sessionKey)) {
      recordLifecycleFence(patch, {
        runId: executionRunId,
        lifecycleGeneration: executionGeneration,
      });
    }
    const persisted = await persistAdmissionPatch({
      entry,
      patch,
      recorder,
      sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    recordAdmittedClaim(persisted);
    return "admitted";
  };

  const updateBeforeAgentReply = async (
    expectedState: "pending" | undefined,
    {
      state,
      pendingFinalDelivery,
    }: Parameters<ReplyRestartRecoveryClaimController["checkpointBeforeAgentReply"]>[0],
  ): Promise<void> => {
    if (!tracked || !params.sessionKey || !params.storePath) {
      return;
    }
    const updatedAt = Date.now();
    const current = await readEntry(params.sessionKey);
    if (!isTrackedClaim(current) || !current) {
      throw createRestartRecoveryClaimChangedError();
    }
    await adoptLifecycle({
      entry: current,
      validate: (entry) =>
        isTrackedClaim(entry) && entry?.restartRecoveryBeforeAgentReplyState === expectedState,
      patch: {
        restartRecoveryBeforeAgentReplyState: state,
        ...(pendingFinalDelivery
          ? {
              pendingFinalDelivery: {
                ...(pendingFinalDelivery.text
                  ? { kind: "replayable" as const, text: pendingFinalDelivery.text }
                  : { kind: "transport-only" as const }),
                createdAt: updatedAt,
                ...(pendingFinalDelivery.intentId
                  ? { intentId: pendingFinalDelivery.intentId }
                  : {}),
                deliveries: pendingFinalDelivery.deliveries,
                sourceRunId: getRestartRecoveryPendingFinalSourceRunId(
                  current,
                  pendingFinalDelivery.context,
                ),
                ...(pendingFinalDelivery.context ? { context: pendingFinalDelivery.context } : {}),
              },
              // Hook-owned replies are already terminal. A restart may only deliver this
              // checkpoint; it must never resume the model or broader tool surface.
              restartRecoveryForceSafeTools: true,
            }
          : {}),
        updatedAt,
      },
      committed: params.setEntry,
    });
  };

  const prepareClearOperation = (): AgentTurnRestartClaimCleanup["operation"] | undefined => {
    const lifecycleGeneration = params.lifecycleGeneration;
    if (
      !tracked ||
      !params.sessionKey ||
      !params.storePath ||
      !lifecycleGeneration ||
      params.isRestartAbort()
    ) {
      return undefined;
    }
    const sessionId = params.getSessionId();
    if (sessionId !== trackedSessionId) {
      return undefined;
    }
    return {
      kind: "restart-claim-clear",
      expected: { sessionId, lifecycleRevision: trackedLifecycleRevision },
      sessionId,
      recoveryRunId,
      recoverySourceRunId,
      executionRunId,
      executionGeneration,
      ...(strandedRetryRunId ? { terminalRunId: strandedRetryRunId } : {}),
    };
  };

  const clear = async (): Promise<void> => {
    const operation = prepareClearOperation();
    if (!operation) {
      return;
    }
    const persisted = await applySessionEntryTargetOperation(preparedTarget(), operation, {
      // The worker owns row predicates; live host authority survives every admission wait.
      workerGuard: {
        assertCurrent: () => {
          assertAgentRunLifecycleGenerationCurrent(executionGeneration);
          if (params.isRestartAbort()) {
            throw createAgentRunStaleLifecycleError();
          }
          if (params.getSessionId() !== operation.sessionId) {
            throw createRestartRecoveryClaimChangedError();
          }
        },
      },
    });
    // A refused reduction returns the current row; it cannot retarget this run's cache.
    if (
      persisted?.sessionId === operation.sessionId &&
      persisted.lifecycleRevision === trackedLifecycleRevision
    ) {
      params.setEntry(persisted);
    }
  };

  const isArmed = async (): Promise<boolean> => {
    if (!tracked || !params.sessionKey || !params.storePath) {
      return false;
    }
    const isRetiredRestart = () =>
      params.lifecycleGeneration
        ? params.isRestartAbort() &&
          !isAgentEventLifecycleGenerationCurrent(params.lifecycleGeneration)
        : false;
    // Terminal settlement may reuse confirmed facts, but must not read successor storage.
    if (isRetiredRestart()) {
      return confirmedArmed;
    }
    try {
      // Restart abort revokes public actor reads; only its terminal reader remains.
      const persisted = params.isRestartAbort()
        ? await readSessionEntryInWorker(
            { agentId: params.agentId, sessionKey: params.sessionKey, storePath: params.storePath },
            assertReadCurrent,
            undefined,
            recordReadTarget,
          )
        : await readEntry(params.sessionKey);
      assertReadCurrent();
      if (!confirmedArmed) {
        const current = params.getEntry();
        confirmedArmed =
          (isTrackedClaim(persisted) && persisted?.abortedLastRun === true) ||
          (isTrackedClaim(current) && current?.abortedLastRun === true);
      }
      return confirmedArmed;
    } catch (error) {
      if (isAgentRunStaleLifecycleError(error) && isRetiredRestart()) {
        return confirmedArmed;
      }
      throw error;
    }
  };

  return {
    admitUserTurn,
    async beginBeforeAgentReply() {
      await params.operationAdmission?.adoptInput?.();
      // `pending` records only the ambiguous plugin side-effect window. A
      // finished unhandled hook clears it so recovery can re-enter normally.
      await updateBeforeAgentReply(undefined, { state: "pending" });
      return true;
    },
    checkpointBeforeAgentReply: (checkpoint) => updateBeforeAgentReply("pending", checkpoint),
    clear,
    prepareCompletionCleanup(entry) {
      // Unknown provider outcomes retain their separate reconciliation boundary.
      if (entry.restartRecoveryDeliveryReceiptState === "terminal-pending") {
        return undefined;
      }
      const operation = prepareClearOperation();
      return operation
        ? {
            operation,
            committed() {
              tracked = false;
            },
          }
        : undefined;
    },
    isArmed,
  };
}
