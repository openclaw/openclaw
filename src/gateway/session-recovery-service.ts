import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsRecoverResult,
} from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent.js";
import { buildMainSessionRecoveryClearPatch } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import {
  inspectMainRestartRecoveryRolloverEligibility,
  isMainSessionRecoveryReconciliationCandidate,
} from "../agents/main-session-recovery/main-session-recovery-state.js";
import { markOrphanedMainSessionForRecovery } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import { recoverSessionEntryFromRestartTombstone } from "../config/sessions/session-accessor.js";
import {
  buildSessionCreationStamp,
  inheritSessionCreationPolicy,
  type SessionCreatedActor,
} from "../config/sessions/session-entry-provenance.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { inheritSessionSelection } from "../config/sessions/session-entry-selection.js";
import { mergeSessionEntry, type InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { recordSessionCreated } from "../sessions/session-created.js";
import {
  closeSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { normalizeSessionIdentities } from "../sessions/session-lifecycle-identity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "./operator-role-policy.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import { buildDashboardSessionKey } from "./session-create-key.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { invalidSessionRequest } from "./session-request-error.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "./session-sharing-preparation.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";
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

class SessionRecoverySourceChangedError extends Error {
  constructor(options?: ErrorOptions) {
    super("Session changed before recovery; refresh and retry.", options);
    this.name = "SessionRecoverySourceChangedError";
  }
}

/** Keep full recovery metadata tied to the existing sharing/source publication lifetime. */
async function prepareRecoverySource(params: {
  cfg: OpenClawConfig;
  target: GatewaySessionStoreTarget;
  commitGuard?: () => void;
  storageReady?: Promise<void>;
}) {
  const { target } = params;
  const facts = await prepareSessionMutationFacts({
    cfg: params.cfg,
    sessionKey: target.canonicalKey,
    agentId: target.agentId,
    allowMissing: true,
    storageReady: params.storageReady,
  });
  let generation = 0;
  let selectedGeneration = -1;
  let selected: InternalSessionEntry | undefined;
  const sourcePaths = new Set([path.resolve(target.storePath)]);
  const readFacts = () => {
    try {
      const current = facts.readCurrent(params.cfg);
      if (
        facts.storageTarget.agentId !== target.agentId ||
        facts.storageTarget.canonicalKey !== target.canonicalKey ||
        path.resolve(facts.storageTarget.storePath) !== path.resolve(target.storePath)
      ) {
        throw new SessionRecoverySourceChangedError();
      }
      return current;
    } catch (error) {
      if (error instanceof SessionMutationFactsUnavailableError) {
        throw new SessionRecoverySourceChangedError({ cause: error });
      }
      throw error;
    }
  };
  try {
    const source = readFacts();
    if (source.sourcePath) {
      sourcePaths.add(path.resolve(source.sourcePath));
    }
  } catch (error) {
    facts.release();
    throw error;
  }
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (
      !("all" in change) &&
      change.scope !== "acp" &&
      change.storePath &&
      sourcePaths.has(path.resolve(change.storePath)) &&
      target.storeKeys.includes(change.sessionKey)
    ) {
      generation += 1;
    }
  });
  const assertCurrent = () => {
    params.commitGuard?.();
    readFacts();
    if (selectedGeneration !== generation) {
      throw new SessionRecoverySourceChangedError();
    }
  };
  return {
    current() {
      assertCurrent();
      return selected;
    },
    async refresh() {
      params.commitGuard?.();
      const before = generation;
      const current = readFacts();
      if (!current.target) {
        selected = undefined;
        selectedGeneration = before;
        assertCurrent();
        return undefined;
      }
      const read = await withSessionEntryReadOnlyInWorker(
        {
          agentId: target.agentId,
          sessionKey: current.target.storeKey,
          storePath: current.sourcePath ?? target.storePath,
        },
        () => params.commitGuard?.(),
        async (result, owner) => {
          owner.assertCurrent();
          if (!result.ok) {
            throw result.error;
          }
          return result.value;
        },
      );
      selected = read;
      selectedGeneration = before;
      assertCurrent();
      return selected;
    },
    [Symbol.dispose]() {
      unsubscribe();
      facts.release();
    },
  };
}

/** Reconcile dead recovery ownership before a new send can replace its delivery claim. */
export async function reconcileOrphanedGatewaySessionRecovery(params: {
  cfg: OpenClawConfig;
  target: GatewaySessionStoreTarget;
  entry: InternalSessionEntry;
  authorizedPluginId?: string;
  commitGuard?: () => void;
  workerPlacementContext: SessionWorkerPlacementContext;
}): Promise<InternalSessionEntry | undefined> {
  const { entry: initialSource, target } = params;
  const identities = [...target.storeKeys, initialSource.sessionId];
  if (
    !isMainSessionRecoveryReconciliationCandidate(initialSource) ||
    isSessionWorkAdmissionActive(target.storePath, identities)
  ) {
    return undefined;
  }
  using source = await prepareRecoverySource(params);
  return await runExclusiveSessionLifecycleMutation("recovery-mark", {
    scope: target.storePath,
    identities,
    run: async () => {
      if (isSessionWorkAdmissionActive(target.storePath, identities)) {
        return undefined;
      }
      await source.refresh();
      const assertPlacementCurrent = await prepareSessionWorkerPlacementMutationCheckAsync({
        context: params.workerPlacementContext,
        sessionId: initialSource.sessionId,
      });
      const assertCurrent = () => {
        params.commitGuard?.();
        assertPlacementCurrent();
        const current = source.current();
        const ownershipError = resolvePluginSessionOwnershipError({
          action: "recover",
          entry: current,
          key: target.canonicalKey,
          pluginOwnerId: params.authorizedPluginId,
        });
        if (ownershipError) {
          throw new Error(ownershipError.message);
        }
        if (
          current?.sessionId !== initialSource.sessionId ||
          current.status !== initialSource.status ||
          current.abortedLastRun !== initialSource.abortedLastRun ||
          current.lifecycleRevision !== initialSource.lifecycleRevision ||
          current.activeWriterRunId !== initialSource.activeWriterRunId ||
          current.mainRestartRecovery?.cycleId !== initialSource.mainRestartRecovery?.cycleId ||
          current.mainRestartRecovery?.revision !== initialSource.mainRestartRecovery?.revision ||
          isSessionWorkAdmissionActive(target.storePath, identities)
        ) {
          throw new Error("Session changed before recovery; refresh and retry.");
        }
      };
      const result = await markOrphanedMainSessionForRecovery({
        target: { ...target, sessionKey: target.canonicalKey },
        expectedSessionId: initialSource.sessionId,
        expectedLifecycleRevision: initialSource.lifecycleRevision,
        cfg: params.cfg,
        assertCommitAllowed: assertCurrent,
      });
      return result.marked > 0 ? await source.refresh() : undefined;
    },
  });
}

/** Owns explicit restart recovery from authorization through continuation launch. */
export async function recoverGatewaySession(params: {
  actor?: SessionCreatedActor;
  agentId?: string;
  authorizedPluginId?: string;
  cfg: OpenClawConfig;
  commitGuard?: () => void;
  key: string;
  requestingOperatorProfileId?: string;
  operatorRoleActor?: GatewayOperatorRoleActor;
  workerPlacementContext: SessionWorkerPlacementContext;
  launchContinuation: (params: {
    agentId: string;
    idempotencyKey: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
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
  const initialEligibility = inspectMainRestartRecoveryRolloverEligibility(initialSource);
  if (!initialEligibility.eligible && initialEligibility.reason !== "already_recovered") {
    return invalidSessionRequest("Session recovery requires a restart-tombstoned session.");
  }
  const recovery = initialSource.mainRestartRecovery;
  if (!recovery?.tombstone) {
    return invalidSessionRequest("Session is not recoverable.");
  }
  const generatedSuccessorKey = buildDashboardSessionKey(sourceTarget.agentId);
  const successorTarget = await resolveGatewaySessionStoreTargetInWorker({
    cfg: params.cfg,
    key: generatedSuccessorKey,
    agentId: sourceTarget.agentId,
    assertActive: params.commitGuard,
  });
  const successorSessionId = randomUUID();

  const sourceIdentities = [
    ...sourceTarget.storeKeys,
    sourceTarget.canonicalKey,
    initialSource.sessionId,
  ];
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
          isEmbeddedAgentRunActive(currentSource.sessionId) ||
          isSessionWorkAdmissionActive(sourceTarget.storePath, [
            sourceTarget.canonicalKey,
            currentSource.sessionId,
          ])
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
      const prepared = await runExclusiveSessionLifecycleMutation("recovery-drain", {
        scope: sourceTarget.storePath,
        identities: sourceIdentities,
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
          release = closeSessionWorkAdmissions({
            scope: sourceTarget.storePath,
            identities: sourceIdentities,
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
      return await runExclusiveSessionLifecycleMutation("recover", {
        targets: [
          { scope: sourceTarget.storePath, identities: sourceIdentities },
          {
            scope: successorTarget.storePath,
            identities: [successorTarget.canonicalKey, successorSessionId],
          },
        ],
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
