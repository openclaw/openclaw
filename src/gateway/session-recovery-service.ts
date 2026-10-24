import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsRecoverResult,
} from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveExecDefaultsAsync } from "../agents/exec-defaults.js";
import {
  buildMainSessionRecoveryClearPatch,
  buildMainSessionRecoverySettlementPatch,
} from "../agents/main-session-recovery/main-session-recovery-clear.js";
import {
  isMainSessionRecoveryPending,
  isMainSessionRecoveryReconciliationCandidate,
} from "../agents/main-session-recovery/main-session-recovery-state.js";
import { commitMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-store.js";
import { resolveMainSessionResumePolicy } from "../agents/main-session-recovery/main-session-restart-recovery-resume-policy.js";
import { isCliProvider } from "../agents/model-selection-cli.js";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import type { SessionRestartResume } from "../config/sessions/restart-resume.js";
import { recoverSessionEntryFromRestartTombstone } from "../config/sessions/session-accessor.js";
import {
  buildSessionCreationStamp,
  inheritSessionCreationPolicy,
  type SessionCreatedActor,
} from "../config/sessions/session-entry-provenance.js";
import { inheritSessionSelection } from "../config/sessions/session-entry-selection.js";
import { buildRestartRecoveryExpectedState } from "../config/sessions/session-transcript-turn-state.js";
import { readMessageIdempotencyKey } from "../config/sessions/transcript-message-identity.js";
import { mergeSessionEntry, type InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  captureSessionTarget,
  closeSessionControllerAdmission,
  isSessionControllerWorkActive,
  runSessionMutation,
} from "../sessions/session-controller.lifecycle.js";
import { recordSessionCreated } from "../sessions/session-created.js";
import { normalizeSessionIdentities } from "../sessions/session-lifecycle-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "./operator-role-policy.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import { buildDashboardSessionKey } from "./session-create-key.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import {
  prepareRecoverySource,
  reconcileOrphanedGatewaySessionRecovery,
  SessionRecoverySourceChangedError,
} from "./session-recovery-source.js";
import { invalidSessionRequest } from "./session-request-error.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-preparation.js";
import { prepareRestartInterruptedSubagentRecovery } from "./session-subagent-reactivation.js";
import { readSessionMessagesAsync } from "./session-transcript-readers.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveWorkerPlacementSessionRuntimeAsync } from "./worker-environments/placement-session-runtime.js";
import {
  prepareSessionWorkerPlacementMutationCheckAsync,
  prepareSessionWorkerPlacementStop,
  type SessionWorkerPlacementContext,
} from "./worker-environments/session-placement-lifecycle.js";

export type SessionRecoveryContinuationOutcome = SessionsRecoverResult["continuation"];

const recoveryQueues = resolveGlobalMap<string, StoreWriterQueue>(
  Symbol.for("openclaw.sessionRecoveryQueues"),
);

type RecoverGatewaySessionResult =
  | {
      ok: true;
      agentId: string;
      created: boolean;
      sourceKey: string;
      successorEntry: InternalSessionEntry;
      successorKey: string;
      continuation: SessionRecoveryContinuationOutcome;
    }
  | { ok: false; error: ErrorShape };

function recoveryConflictError(reason: string): ErrorShape {
  const unavailable = reason === "successor-missing" || reason === "transcript-missing";
  return errorShape(
    unavailable ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
    unavailable
      ? "Session recovery state is incomplete."
      : "Session changed before recovery; refresh and retry.",
    { details: { reason } },
  );
}

/** Owns explicit restart recovery from authorization through continuation launch. */
export async function recoverGatewaySession(params: {
  actor?: SessionCreatedActor;
  agentId?: string;
  authorizedPluginId?: string;
  cfg: OpenClawConfig;
  commitGuard?: () => void;
  key: string;
  mode?: "in-place" | "new-session";
  sessionId?: string;
  recoveryCycleId?: string;
  requestingOperatorProfileId?: string;
  operatorRoleActor?: GatewayOperatorRoleActor;
  workerPlacementContext: SessionWorkerPlacementContext;
  launchContinuation: (params: {
    assertRecoveryCurrent?: () => void;
    agentId: string;
    idempotencyKey: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
    resume?: SessionRestartResume;
  }) => Promise<SessionRecoveryContinuationOutcome>;
}): Promise<RecoverGatewaySessionResult> {
  const sourceTarget = await resolveGatewaySessionStoreTargetInWorker({
    cfg: params.cfg,
    key: params.key,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    assertActive: params.commitGuard,
  });
  const initialSource = findCanonicalStoreMatch(sourceTarget.store, sourceTarget.storeKeys)?.entry;
  if (!initialSource?.sessionId) {
    return invalidSessionRequest("Session recovery source was not found.");
  }
  const recovery = initialSource.mainRestartRecovery;
  const subagentRecovery =
    !recovery && params.mode !== "new-session"
      ? await prepareRestartInterruptedSubagentRecovery({
          sessionKey: sourceTarget.canonicalKey,
          agentId: sourceTarget.agentId,
          entry: initialSource,
          assertCurrent: params.commitGuard,
        })
      : undefined;
  // Rejected dispatches refund their attempt; startup can exhaust its passes without a tombstone.
  const pendingRecovery =
    params.mode !== "new-session" &&
    isMainSessionRecoveryPending(initialSource, sourceTarget.canonicalKey);
  if (
    subagentRecovery
      ? (params.sessionId !== undefined && params.sessionId !== initialSource.sessionId) ||
        params.recoveryCycleId !== undefined
      : params.mode === "in-place" &&
        (params.sessionId !== initialSource.sessionId ||
          params.recoveryCycleId !== recovery?.cycleId)
  ) {
    return { ok: false, error: recoveryConflictError("source-changed") };
  }
  if (isMainSessionRecoveryReconciliationCandidate(initialSource)) {
    const repaired = await reconcileOrphanedGatewaySessionRecovery({
      ...params,
      target: sourceTarget,
      entry: initialSource,
    });
    if (!repaired) {
      return invalidSessionRequest(
        "Session recovery is unavailable while the source still has active work.",
      );
    }
    const continuation = await params.launchContinuation({
      agentId: sourceTarget.agentId,
      idempotencyKey: `restart-recovery-reconcile:${repaired.sessionId}:${repaired.mainRestartRecovery?.cycleId}`,
      sessionId: repaired.sessionId,
      sessionKey: sourceTarget.canonicalKey,
      storePath: sourceTarget.storePath,
    });
    return {
      ok: true,
      agentId: sourceTarget.agentId,
      created: false,
      sourceKey: sourceTarget.canonicalKey,
      successorEntry: repaired,
      successorKey: sourceTarget.canonicalKey,
      continuation,
    };
  }
  if (!subagentRecovery && (!recovery || (!pendingRecovery && !recovery.tombstone))) {
    return invalidSessionRequest(
      "Session recovery requires pending restart recovery or a restart-tombstoned session.",
    );
  }
  if (
    subagentRecovery ||
    pendingRecovery ||
    (params.mode === "in-place" && recovery && !recovery.tombstone?.recoveredSessionKey)
  ) {
    return await runQueuedStoreWrite({
      queues: recoveryQueues,
      storePath: normalizeSessionIdentities(sourceTarget.storePath, [
        sourceTarget.canonicalKey,
      ])[0]!,
      label: "resumeGatewaySession",
      fn: async () => {
        using source = await prepareRecoverySource({ ...params, target: sourceTarget });
        const assertCurrent = () => {
          params.commitGuard?.();
          subagentRecovery?.assertCurrent();
          const current = source.current();
          const ownershipError = resolvePluginSessionOwnershipError({
            action: "recover",
            entry: current,
            key: sourceTarget.canonicalKey,
            pluginOwnerId: params.authorizedPluginId,
          });
          if (ownershipError) {
            throw new Error(ownershipError.message);
          }
          if (
            current?.sessionId !== initialSource.sessionId ||
            current.lifecycleRevision !== initialSource.lifecycleRevision ||
            (subagentRecovery
              ? current.lastRunId !== subagentRecovery.runId ||
                current.status !== "interrupted" ||
                current.abortedLastRun !== true ||
                current.mainRestartRecovery !== undefined
              : !recovery ||
                current.mainRestartRecovery?.cycleId !== recovery.cycleId ||
                current.mainRestartRecovery.revision !== recovery.revision ||
                (pendingRecovery
                  ? !isMainSessionRecoveryPending(current, sourceTarget.canonicalKey)
                  : !current.mainRestartRecovery.tombstone) ||
                current.mainRestartRecovery.tombstone?.recoveredSessionKey) ||
            current.archivedAt !== undefined ||
            current.providerReview ||
            isSessionControllerWorkActive(
              sourceTarget.storePath,
              [sourceTarget.canonicalKey, current.sessionId],
              sourceTarget.agentId,
            )
          ) {
            throw new SessionRecoverySourceChangedError();
          }
        };
        await source.refresh();
        assertCurrent();
        // Delivery custody stays with its existing owner; a new turn must not discard it.
        if (initialSource.pendingFinalDelivery) {
          return invalidSessionRequest(
            "Finish the pending reply delivery before resuming this session.",
          );
        }
        const stop = await runSessionMutation({
          diagnosticLabel: "recovery-drain",
          target: captureSessionTarget({
            storeScope: sourceTarget.storePath,
            sessionKey: sourceTarget.canonicalKey,
            aliases: sourceTarget.storeKeys,
            agentId: sourceTarget.agentId,
            incarnation: initialSource.sessionId,
          }),
          run: async () => {
            assertCurrent();
            return await prepareSessionWorkerPlacementStop({
              action: "recover",
              agentId: sourceTarget.agentId,
              authorize: assertCurrent,
              context: params.workerPlacementContext,
              sessionId: initialSource.sessionId,
              sessionKey: sourceTarget.canonicalKey,
            });
          },
        });
        await stop.stop();
        await source.refresh();
        assertCurrent();
        const assertPlacementCurrent = await prepareSessionWorkerPlacementMutationCheckAsync({
          context: params.workerPlacementContext,
          sessionId: initialSource.sessionId,
        });
        const messages = await readSessionMessagesAsync(
          {
            agentId: sourceTarget.agentId,
            storePath: sourceTarget.storePath,
            sessionKey: sourceTarget.canonicalKey,
            sessionId: initialSource.sessionId,
            sessionEntry: initialSource,
          },
          { mode: "recent", maxMessages: 20, maxBytes: 256 * 1024 },
        );
        if (messages.length === 0) {
          return { ok: false as const, error: recoveryConflictError("transcript-missing") };
        }
        const execPolicy = await resolveExecDefaultsAsync({
          cfg: params.cfg,
          agentId: sourceTarget.agentId,
          sessionKey: sourceTarget.canonicalKey,
          sessionEntry: initialSource,
        });
        const fullAccess =
          execPolicy.mode === "full" &&
          execPolicy.security === "full" &&
          execPolicy.ask === "off" &&
          initialSource.restartRecoveryDeliveryMediaUrls === undefined &&
          initialSource.restartRecoveryDisableMessageTool !== true &&
          initialSource.restartRecoverySuppressTextDelivery !== true;
        const retainedSafeTools =
          initialSource.restartRecoveryForceSafeTools === true && !fullAccess;
        const noticeKey = `main-session-restart-recovery:${initialSource.restartRecoveryDeliverySourceRunId ?? initialSource.restartRecoveryDeliveryRunId ?? initialSource.sessionId}:failed-notice`;
        const policy = resolveMainSessionResumePolicy(
          messages.filter((message) => readMessageIdempotencyKey(message) !== noticeKey),
          retainedSafeTools,
          initialSource.restartRecoveryDeliverySourceRunId,
          initialSource.restartRecoveryBeforeAgentReplyState,
          initialSource.restartRecoveryDeliveryReceiptState,
          initialSource.restartRecoveryDeliveryToolCallId,
          fullAccess,
        );
        const forceRestartSafeTools =
          retainedSafeTools || policy.action === "complete" || policy.forceRestartSafeTools;
        if (forceRestartSafeTools) {
          const runtime = await resolveWorkerPlacementSessionRuntimeAsync({
            cfg: params.cfg,
            entry: initialSource,
            agentId: sourceTarget.agentId,
            sessionKey: sourceTarget.canonicalKey,
            assertCurrent,
          });
          if (isCliProvider(runtime, params.cfg)) {
            let successorEntry = initialSource;
            if (pendingRecovery && recovery) {
              const tombstoned = await commitMainSessionRecovery({
                assertCommitAllowed: () => {
                  assertCurrent();
                  assertPlacementCurrent();
                },
                command: {
                  kind: "tombstone",
                  now: Date.now(),
                  observation: {
                    sessionId: initialSource.sessionId,
                    cycleId: recovery.cycleId,
                    revision: recovery.revision,
                  },
                  reason: "CLI runtime cannot enforce restart-safe tools",
                },
                requireWriteSuccess: true,
                target: { ...sourceTarget, sessionKey: sourceTarget.canonicalKey },
              });
              if (tombstoned.transition.kind !== "tombstoned" || !tombstoned.entry) {
                throw new SessionRecoverySourceChangedError();
              }
              successorEntry = tombstoned.entry;
            }
            return {
              ok: true as const,
              agentId: sourceTarget.agentId,
              created: false,
              sourceKey: sourceTarget.canonicalKey,
              successorEntry,
              successorKey: sourceTarget.canonicalKey,
              continuation: {
                status: "rejected" as const,
                error: errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  subagentRecovery
                    ? "This CLI runtime cannot enforce restart-safe tools. Select a native runtime, then retry recovery."
                    : "This CLI runtime cannot enforce restart-safe tools. Use Resume in new session.",
                  { details: { reason: "restart-safe-tools-unavailable" } },
                ),
              },
            };
          }
        }
        assertCurrent();
        assertPlacementCurrent();
        const resume: SessionRestartResume = {
          sessionId: initialSource.sessionId,
          lifecycleRevision: initialSource.lifecycleRevision,
          expectedState: {
            ...buildRestartRecoveryExpectedState(initialSource),
            expectedWriterRunId: initialSource.activeWriterRunId,
            pendingFinalDelivery: null,
          },
          lifecycle: buildMainSessionRecoverySettlementPatch({
            entry: initialSource,
            recordTerminalSource: true,
          }),
          forceRestartSafeTools,
          ...(policy.action === "resume" && policy.forceCodeModeTools
            ? { forceCodeModeTools: true }
            : {}),
        };
        // The input actor commits this patch with the pending operator input. Never clear first:
        // a crash between clearing and accepting would otherwise lose the unfinished task.
        const continuation = await params.launchContinuation({
          agentId: sourceTarget.agentId,
          ...(subagentRecovery ? { assertRecoveryCurrent: subagentRecovery.assertCurrent } : {}),
          idempotencyKey: subagentRecovery
            ? `subagent-restart-recovery:${subagentRecovery.runId}`
            : `restart-recovery-resume:${initialSource.sessionId}:${recovery?.cycleId}`,
          sessionId: initialSource.sessionId,
          sessionKey: sourceTarget.canonicalKey,
          storePath: sourceTarget.storePath,
          resume,
        });
        return {
          ok: true as const,
          agentId: sourceTarget.agentId,
          created: false,
          sourceKey: sourceTarget.canonicalKey,
          successorEntry: initialSource,
          successorKey: sourceTarget.canonicalKey,
          continuation,
        };
      },
    }).catch((error: unknown) => {
      if (
        error instanceof SessionRecoverySourceChangedError ||
        error instanceof SessionMutationFactsUnavailableError
      ) {
        return { ok: false as const, error: recoveryConflictError("source-changed") };
      }
      throw error;
    });
  }
  if (!recovery) {
    return invalidSessionRequest("Session recovery source is no longer available.");
  }
  const generatedSuccessorKey = buildDashboardSessionKey(sourceTarget.agentId);
  const successorTarget = await resolveGatewaySessionStoreTargetInWorker({
    cfg: params.cfg,
    key: generatedSuccessorKey,
    agentId: sourceTarget.agentId,
    assertActive: params.commitGuard,
  });
  const successorSessionId = randomUUID();

  const sourceControllerTarget = captureSessionTarget({
    storeScope: sourceTarget.storePath,
    sessionKey: sourceTarget.canonicalKey,
    aliases: sourceTarget.storeKeys,
    agentId: sourceTarget.agentId,
    incarnation: initialSource.sessionId,
  });
  const successorControllerTarget = captureSessionTarget({
    storeScope: successorTarget.storePath,
    sessionKey: successorTarget.canonicalKey,
    agentId: successorTarget.agentId,
    incarnation: successorSessionId,
  });
  const stopFailure = (error: unknown) =>
    errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session recovery cannot safely stop/reclaim its cloud worker: ${formatErrorMessage(error)} Stop cloud worker or call sessions.reclaim, then retry recovery.`,
      { retryable: true },
    );
  const storageReady = createDeferredCore();
  // Retain source custody while queued; read only after the previous recovery publishes.
  const sourcePreparation = prepareRecoverySource({
    ...params,
    target: sourceTarget,
    storageReady: storageReady.promise,
  });
  void sourcePreparation.catch(() => {});
  const commitRecovery = async () => {
    storageReady.resolve();
    let release = () => {};
    try {
      using source = await sourcePreparation;
      const resolveCurrentSource = () => {
        params.commitGuard?.();
        const currentSource = source.current();
        const currentOwnershipError = resolvePluginSessionOwnershipError({
          action: "recover",
          entry: currentSource,
          key: sourceTarget.canonicalKey,
          pluginOwnerId: params.authorizedPluginId,
        });
        if (currentOwnershipError) {
          return { ok: false as const, error: currentOwnershipError };
        }
        if (
          !currentSource?.sessionId ||
          currentSource.sessionId !== initialSource.sessionId ||
          currentSource.lifecycleRevision !== initialSource.lifecycleRevision ||
          currentSource.mainRestartRecovery?.cycleId !== recovery.cycleId ||
          (!currentSource.mainRestartRecovery.tombstone?.recoveredSessionKey &&
            currentSource.mainRestartRecovery.revision !== recovery.revision)
        ) {
          return { ok: false as const, error: recoveryConflictError("source-changed") };
        }
        if (!currentSource.mainRestartRecovery?.tombstone?.recoveredSessionKey) {
          const creationError = authorizeGatewaySessionCreation({
            cfg: params.cfg,
            agentId: sourceTarget.agentId,
            ...(params.operatorRoleActor
              ? { actor: params.operatorRoleActor }
              : { profileId: params.requestingOperatorProfileId }),
          });
          if (creationError) {
            return { ok: false as const, error: creationError };
          }
        }
        if (
          isSessionControllerWorkActive(
            sourceTarget.storePath,
            [sourceTarget.canonicalKey, currentSource.sessionId],
            sourceTarget.agentId,
          )
        ) {
          return invalidSessionRequest(
            "Session recovery is unavailable while the source still has active work.",
          );
        }
        return { ok: true as const, source: currentSource };
      };
      const assertCurrent = () => {
        const current = resolveCurrentSource();
        if (!current.ok) {
          throw new Error(current.error.message);
        }
      };
      const prepared = await runSessionMutation({
        diagnosticLabel: "recovery-drain",
        target: sourceControllerTarget,
        run: async () => {
          await source.refresh();
          const current = resolveCurrentSource();
          if (!current.ok) {
            return current;
          }
          let stop: (() => Promise<void>) | undefined;
          try {
            if (!current.source.mainRestartRecovery?.tombstone?.recoveredSessionKey) {
              stop = (
                await prepareSessionWorkerPlacementStop({
                  action: "recover",
                  agentId: sourceTarget.agentId,
                  authorize: assertCurrent,
                  context: params.workerPlacementContext,
                  sessionId: initialSource.sessionId,
                  sessionKey: sourceTarget.canonicalKey,
                })
              ).stop;
            }
          } catch (error) {
            return { ok: false as const, error: stopFailure(error) };
          }
          // Reclaim may need both queues after this short exact-owner preflight.
          release = closeSessionControllerAdmission({
            target: sourceControllerTarget,
            reason: createAgentRunDirectAbortError(),
          });
          return { ...current, stop };
        },
      });
      if (!prepared.ok) {
        return prepared;
      }
      let assertPlacementCurrent: (() => void) | undefined;
      if (prepared.stop) {
        try {
          await prepared.stop();
          assertPlacementCurrent = await prepareSessionWorkerPlacementMutationCheckAsync({
            context: params.workerPlacementContext,
            sessionId: initialSource.sessionId,
          });
        } catch (error) {
          await source.refresh();
          const current = resolveCurrentSource();
          return current.ok ? { ok: false as const, error: stopFailure(error) } : current;
        }
      }
      return await runSessionMutation({
        diagnosticLabel: "recover",
        targets: [sourceControllerTarget, successorControllerTarget],
        prepare: async () => release(),
        run: async () => {
          await source.refresh();
          const settled = resolveCurrentSource();
          if (!settled.ok) {
            return settled;
          }
          const currentSource = settled.source;
          const commitGuard = () => {
            assertCurrent();
            assertPlacementCurrent?.();
          };
          commitGuard();
          // Owner attribution keeps the source isolation inherited by actorless recovery.
          const creation = params.actor
            ? {
                actor: params.actor,
                sandbox:
                  params.actor.id === GATEWAY_OWNER_PROFILE_ID
                    ? currentSource.sandbox
                    : resolveCreatorSandbox(params.cfg, params),
              }
            : inheritSessionCreationPolicy(currentSource);
          const entry = mergeSessionEntry(undefined, {
            ...inheritSessionSelection(currentSource),
            ...buildSessionCreationStamp({ via: "operator", ...creation }),
            delivery: normalizeSessionDeliveryState(),
            sessionId: successorSessionId,
            previousSessionId: currentSource.sessionId,
            spawnDepth: 0,
            ...(currentSource.agentHarnessId
              ? { agentHarnessId: currentSource.agentHarnessId }
              : {}),
            ...(currentSource.modelSelectionLocked === true
              ? { modelSelectionLocked: true as const }
              : {}),
            ...(currentSource.pluginOwnerId ? { pluginOwnerId: currentSource.pluginOwnerId } : {}),
            ...(currentSource.visibility ? { visibility: currentSource.visibility } : {}),
            ...(currentSource.communication
              ? { communication: { ...currentSource.communication } }
              : {}),
            ...(currentSource.spawnedCwd ? { spawnedCwd: currentSource.spawnedCwd } : {}),
            ...(currentSource.deviceFolder
              ? { deviceFolder: { ...currentSource.deviceFolder } }
              : {}),
            ...(currentSource.execHost ? { execHost: currentSource.execHost } : {}),
            ...(currentSource.execNode ? { execNode: currentSource.execNode } : {}),
            ...(currentSource.execCwd ? { execCwd: currentSource.execCwd } : {}),
          });
          const successorEntry = {
            ...entry,
            ...buildMainSessionRecoveryClearPatch(entry),
            sessionId: successorSessionId,
          };

          const result = await recoverSessionEntryFromRestartTombstone({
            agentId: sourceTarget.agentId,
            ...(params.actor ? { archivedBy: params.actor } : {}),
            commitGuard,
            expected: {
              cycleId: recovery.cycleId,
              lifecycleRevision: initialSource.lifecycleRevision,
              revision: recovery.revision,
              sessionId: initialSource.sessionId,
              ...(normalizeOptionalString(initialSource.pluginOwnerId)
                ? { pluginOwnerId: initialSource.pluginOwnerId }
                : {}),
            },
            sourceTarget,
            storePath: sourceTarget.storePath,
            successorEntry,
            successorTarget,
          });
          if (result.status === "conflict") {
            return { ok: false as const, error: recoveryConflictError(result.reason) };
          }
          return {
            ok: true as const,
            created: result.status === "created",
            successorEntry: result.successorEntry as InternalSessionEntry,
            successorKey: result.successorKey,
          };
        },
      });
    } catch (error) {
      if (
        error instanceof SessionRecoverySourceChangedError ||
        error instanceof SessionMutationFactsUnavailableError
      ) {
        return { ok: false as const, error: recoveryConflictError("source-changed") };
      }
      throw error;
    } finally {
      release();
    }
  };
  // Only recovery takes this queue: Move/reclaim can acquire their lifecycle fences.
  // Publish the successor before another recovery checks it; launch outside the queue.
  const committed = await runQueuedStoreWrite({
    queues: recoveryQueues,
    storePath: normalizeSessionIdentities(sourceTarget.storePath, [sourceTarget.canonicalKey])[0]!,
    label: "recoverGatewaySession",
    fn: commitRecovery,
  });
  if (!committed.ok) {
    return committed;
  }

  if (committed.created) {
    await recordSessionCreated(params.cfg, {
      sessionKey: committed.successorKey,
      entry: committed.successorEntry,
      agentId: sourceTarget.agentId,
    });
  }
  const continuation = await params.launchContinuation({
    agentId: sourceTarget.agentId,
    idempotencyKey: `restart-recovery-rollover:${committed.successorEntry.sessionId}`,
    sessionId: committed.successorEntry.sessionId,
    sessionKey: committed.successorKey,
    storePath: sourceTarget.storePath,
  });
  return {
    ok: true,
    agentId: sourceTarget.agentId,
    created: committed.created,
    sourceKey: sourceTarget.canonicalKey,
    successorEntry: committed.successorEntry,
    successorKey: committed.successorKey,
    continuation,
  };
}
