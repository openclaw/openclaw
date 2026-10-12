import { randomUUID } from "node:crypto";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createRestartRecoveryOperatorSource } from "../../agents/operator-run-recovery-source.js";
import {
  buildRestartRecoveryClaimCleanupPatch,
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
  isMainRestartRecoveryCandidate,
  recordLifecycleFence,
} from "../../config/sessions/restart-recovery-state.js";
import type { RestartRecoveryBeforeAgentReplyState } from "../../config/sessions/restart-recovery-types.js";
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
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { retireTerminalRestartRecoverySourceClaim } from "./restart-recovery-source.js";

type ReplyRestartRecoveryClaimController = {
  admitUserTurn: (
    recorder?: UserTurnTranscriptRecorder,
  ) => Promise<"admitted" | "duplicate-source">;
  beginBeforeAgentReply: () => Promise<boolean>;
  checkpointBeforeAgentReply: (params: {
    state?: RestartRecoveryBeforeAgentReplyState;
    pendingFinalDelivery?: {
      context?: DeliveryContext;
      deliveries: NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"];
      intentId: string;
      text: string;
    };
  }) => Promise<void>;
  clear: () => Promise<void>;
  isArmed: () => Promise<boolean>;
};

export function createReplyRestartRecoveryClaimController(params: {
  agentId: string;
  acquireSessionActor: () => Promise<
    | {
        actor: SessionActor;
        target: SessionEntryTargetPatchScope;
      }
    | undefined
  >;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  inputProvenance?: InputProvenance;
  admissionRunId?: unknown;
  executionRunId?: string;
  lifecycleGeneration: string | undefined;
  getEntry: () => SessionEntry | undefined;
  getSessionId: () => string;
  isRestartAbort: () => boolean;
  resolveDeliveryContext: (entry: SessionEntry | undefined) => DeliveryContext | undefined;
  requesterAccountId?: unknown;
  requesterSenderId?: unknown;
  resolveUserTurnTarget?: (params: {
    entry: SessionEntry;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) => UserTurnTranscriptTarget | undefined;
  sessionKey?: string;
  setEntry: (entry: SessionEntry) => void;
  sameChannelThreadRequired?: boolean;
  sourceTurnId?: unknown;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  storePath?: string;
}): ReplyRestartRecoveryClaimController {
  let recoveryRunId = normalizeOptionalString(params.admissionRunId) ?? randomUUID();
  const executionRunId = params.executionRunId ?? recoveryRunId;
  const executionGeneration = params.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  let recoverySourceRunId: string | undefined;
  let trackedSessionId: string | undefined;
  let trackedLifecycleRevision: string | undefined;
  let tracked = false;
  let confirmedArmed = false;
  let sessionActor: SessionActor | undefined;
  let readTarget: SessionEntryTargetPatchScope | undefined;
  const recordReadTarget = (target: SessionEntryTargetPatchScope) => {
    if (
      readTarget &&
      (readTarget.agentId !== target.agentId ||
        readTarget.storePath !== target.storePath ||
        readTarget.target.canonicalKey !== target.target.canonicalKey ||
        readTarget.readSource?.agentId !== target.readSource?.agentId ||
        readTarget.readSource?.path !== target.readSource?.path ||
        readTarget.readSource?.databaseIdentity !== target.readSource?.databaseIdentity ||
        readTarget.readSource?.databaseBirthtime !== target.readSource?.databaseBirthtime)
    ) {
      throw createRestartRecoveryClaimChangedError();
    }
    readTarget ??= target;
  };
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
    // Native incognito retains the existing reader and its captured source.
    return readSessionEntryInWorker(
      { agentId: params.agentId, sessionKey, storePath: params.storePath },
      assertReadCurrent,
      undefined,
      recordReadTarget,
    );
  };
  const adoptLifecycle = async (options: {
    entry: SessionEntry;
    patch: SessionTranscriptTurnLifecyclePatch;
    validate?: (entry: SessionEntry | undefined) => boolean;
    committed: (entry: SessionEntry) => void;
  }): Promise<SessionEntry> => {
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
    const authority: SessionActorAuthority = {
      assertCurrent: authorize,
      authorize(stage, facts) {
        authorize(stage, facts.entry);
      },
    };
    let committed: SessionEntry | undefined;
    const outcome = await actor.adoptRun(
      {
        commandId: randomUUID(),
        phaseId: "reply.restart-recovery",
        sessionId,
        expectedState,
        lifecycle: options.patch,
      },
      authority,
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
      throw new SqliteWorkerError(outcome.error.message, "outcome-unknown");
    }
    if (authorityFailure) {
      throw toErrorObject(authorityFailure, "Restart recovery authority rejected the operation");
    }
    throw Object.assign(new Error(outcome.error.message), { name: outcome.error.name });
  };

  const persistAdmissionPatch = async (options: {
    entry: SessionEntry;
    patch: SessionTranscriptTurnLifecyclePatch;
    recorder?: UserTurnTranscriptRecorder;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }): Promise<SessionEntry> => {
    const expectedSessionState = buildRestartRecoveryExpectedState(options.entry);
    if (options.recorder && !options.recorder.hasPersisted()) {
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
    const placementService = placementContext?.workerSessionPlacementService;
    if (placementService && !placementService.prepareRuntimeRefresh) {
      throw new Error("Worker placement observation service is unavailable");
    }
    const placementObservation = placementService?.prepareRuntimeRefresh
      ? await placementService.prepareRuntimeRefresh(sessionId)
      : undefined;
    let entry: SessionEntry;
    let stagedWorkerInput = false;
    try {
      const assertAdmissionCurrent = () => {
        assertReadCurrent();
        if (params.getSessionId() !== sessionId) {
          throw new Error("session changed before durable user-turn admission");
        }
        if (hasPendingPlacementInput() !== pendingPlacementInput) {
          throw new Error("pending user turn changed before durable user-turn admission");
        }
        if (placementContext?.workerSessionPlacementService !== placementService) {
          throw new Error("Worker placement service changed before durable user-turn admission");
        }
        placementObservation?.assertCurrent();
      };
      let current: SessionEntry | undefined;
      try {
        current = await readEntry(params.sessionKey);
      } catch (error) {
        assertAdmissionCurrent();
        throw error;
      }
      assertAdmissionCurrent();
      if (!current || current.sessionId !== sessionId) {
        throw new Error("session changed before durable user-turn admission");
      }
      entry = current;
      stagedWorkerInput = Boolean(
        placementObservation?.placement && placementObservation.placement.state !== "local",
      );
    } finally {
      // The observation selects admission; the claim writer owns its later durable guards.
      placementObservation?.release();
    }
    const admissionRunId = normalizeOptionalString(params.admissionRunId);
    const sourceTurnId = normalizeOptionalString(params.sourceTurnId);
    const activeClaimRunId = normalizeOptionalString(entry.restartRecoveryDeliveryRunId);
    const isExactRecoveryClaim = admissionRunId && activeClaimRunId === admissionRunId;
    if (sourceTurnId) {
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
      const adopted = await persistAdmissionPatch({
        entry,
        patch: {
          restartRecoveryBeforeAgentReplyState: undefined,
          ...(preservesTerminalReceipt
            ? {}
            : {
                restartRecoveryDeliveryReceiptState: undefined,
                restartRecoveryDeliveryToolCallId: undefined,
                restartRecoveryDeliveryRequestFingerprint: undefined,
              }),
          restartRecoverySourceIngress: entry.restartRecoverySourceIngress ?? "control-ui",
          updatedAt: Date.now(),
        },
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
    if (recoverableDeliveryContext) {
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
    const hasDeliveryClaim = Boolean(
      recoverableDeliveryContext || transfersControlUiClaim || operatorSource,
    );
    const patch: SessionTranscriptTurnLifecyclePatch = {
      ...retiredClaim,
      abortedLastRun: false,
      endedAt: undefined,
      restartRecoveryBeforeAgentReplyState: undefined,
      restartRecoveryDeliveryReceiptState: undefined,
      restartRecoveryDeliveryToolCallId: undefined,
      restartRecoveryDeliveryContext: recoverableDeliveryContext,
      restartRecoveryDeliveryRequestFingerprint: undefined,
      restartRecoveryDeliveryRunId: hasDeliveryClaim ? recoveryRunId : undefined,
      restartRecoveryOperatorSource: operatorSource,
      restartRecoveryDeliverySourceRunId:
        transfersControlUiClaim || operatorSource
          ? recoveryRunId
          : recoverableDeliveryContext
            ? sourceTurnId
            : undefined,
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

  const clear = async (): Promise<void> => {
    const lifecycleGeneration = params.lifecycleGeneration;
    if (
      !tracked ||
      !params.sessionKey ||
      !params.storePath ||
      !lifecycleGeneration ||
      params.isRestartAbort()
    ) {
      return;
    }
    const sessionId = params.getSessionId();
    if (sessionId !== trackedSessionId) {
      return;
    }
    const expected = { sessionId, lifecycleRevision: trackedLifecycleRevision };
    const persisted = await applySessionEntryTargetOperation(
      preparedTarget(),
      {
        kind: "restart-claim-clear",
        expected,
        sessionId,
        recoveryRunId,
        recoverySourceRunId,
        executionRunId,
        executionGeneration,
      },
      {
        // The worker owns row predicates; live host authority survives every admission wait.
        workerGuard: {
          assertCurrent: () => {
            assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
            if (params.isRestartAbort()) {
              throw createAgentRunStaleLifecycleError();
            }
            if (params.getSessionId() !== sessionId) {
              throw createRestartRecoveryClaimChangedError();
            }
          },
        },
      },
    );
    // A refused reduction returns the current row; it cannot retarget this run's cache.
    if (
      persisted?.sessionId === expected.sessionId &&
      persisted.lifecycleRevision === expected.lifecycleRevision
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
      // `pending` records only the ambiguous plugin side-effect window. A
      // finished unhandled hook clears it so recovery can re-enter normally.
      await updateBeforeAgentReply(undefined, { state: "pending" });
      return true;
    },
    checkpointBeforeAgentReply: (checkpoint) => updateBeforeAgentReply("pending", checkpoint),
    clear,
    isArmed,
  };
}
