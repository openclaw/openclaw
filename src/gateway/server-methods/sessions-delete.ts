import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type PreservedSessionWorktree,
  type SessionsDeleteParams,
  type SessionsDeleteResult,
  validateSessionsDeleteParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAgentOperationAgentId } from "../../agents/agent-scope-config.js";
import { SessionResetCleanupError } from "../../auto-reply/reply/session-reset-cleanup.js";
import {
  deleteSessionEntryLifecycle,
  SESSION_LIFECYCLE_CHANGED_ERROR_REASON,
  type SessionEntry,
} from "../../config/sessions.js";
import { rollbackPluginOwnedSessionEntryLifecycle } from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { withSessionActorStorage } from "../../config/sessions/session-actor-storage-acquisition.js";
import type { SessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { assertCapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { isAgentHarnessSessionKey } from "../../sessions/agent-harness-session-key.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import {
  captureSessionTarget,
  runSessionMutation,
  SessionMutationPreemptTimeoutError,
} from "../../sessions/session-controller.lifecycle.js";
import { handleSessionStateSessionDeleted } from "../../sessions/session-state-events.js";
import { removeSessionWorktree } from "../../sessions/session-worktree-lifecycle.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { invalidSessionRequest } from "../session-request-error.js";
import {
  cleanupSessionBeforeMutation,
  emitGatewaySessionEndPluginHook,
  emitSessionUnboundLifecycleEvent,
} from "../session-reset-service.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { prepareSessionWorkerPlacementRetirement } from "../worker-environments/session-placement-lifecycle.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  prepareSessionLifecycleDrain,
  SessionLifecycleWorkspaceRecoveryError,
  type SessionLifecycleDrain,
} from "./sessions-lifecycle-drain.js";
import { isAgentMainSessionKey, requireSessionKey, sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

class SessionDeletionError extends Error {
  constructor(readonly error: ErrorShape) {
    super(error.message);
  }
}

type DeleteGatewaySessionOptions = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "sessionMutationAuthorization"
> & {
  params: SessionsDeleteParams;
  assertCurrent?: () => void;
  onDeleted?: (result: SessionsDeleteResult) => void;
};
type DeleteGatewaySessionResult =
  | { ok: true; result: SessionsDeleteResult }
  | { ok: false; error: ErrorShape };

/** Shared lifecycle owner for operator deletion and automatic Incognito expiry. */
export async function deleteGatewaySession(
  options: DeleteGatewaySessionOptions,
): Promise<DeleteGatewaySessionResult> {
  const assertCurrent = () => {
    options.assertCurrent?.();
    options.sessionMutationAuthorization?.assertCurrent();
  };
  const deleted = await withSessionActorStorage(
    { sessionKey: options.params.key.trim(), agentId: options.params.agentId },
    {
      lifetime: { assertCurrent, assertReadable: assertCurrent },
      authority: { assertCurrent, authorize() {} },
    },
    (memory) => deleteGatewaySessionInScope(options, memory),
  );
  return deleted ?? deleteGatewaySessionInScope(options);
}

async function deleteGatewaySessionInScope(
  {
    params: p,
    client,
    context,
    sessionMutationAuthorization,
    assertCurrent: assertCallerCurrent,
    onDeleted,
  }: DeleteGatewaySessionOptions,
  memory?: SessionActorStorageBinding,
): Promise<DeleteGatewaySessionResult> {
  assertCallerCurrent?.();
  const key = p.key.trim();
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p.agentId);
  if (!requestedAgent.ok) {
    return requestedAgent;
  }
  const requestedAgentId = requestedAgent.agentId;
  const actorIdentity =
    memory && resolveSessionStoreIdentity({ cfg, sessionKey: key, agentId: requestedAgentId });
  const actorOwner = memory;
  let durableSource: CapturedSessionEntryReadSource | undefined;
  let durableRead: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  try {
    const target =
      actorIdentity && actorOwner
        ? {
            agentId: actorOwner.agentId,
            canonicalKey: actorIdentity.canonicalKey,
            storeKeys: [actorIdentity.canonicalKey],
            storePath: actorOwner.path,
          }
        : await resolveGatewaySessionStoreTargetInWorker({
            cfg,
            key,
            agentId: requestedAgentId,
            projection: "full",
            onSelected: (selected) => {
              if (isIncognitoSessionKey(selected.canonicalKey)) {
                return;
              }
              durableSource = selected.capturedReadSource;
              const identity = readDatabasePathIdentitySync(
                selected.readSource?.path ?? selected.storePath,
              );
              durableRead = retainPreparedSessionEntryPredicate({
                databaseIdentity: identity.key,
                sessionKey: selected.canonicalKey,
                entry: selected.store[selected.canonicalKey],
                matches: (before, after) =>
                  (before === undefined) === (after === undefined) &&
                  (
                    [
                      "sessionId",
                      "lifecycleRevision",
                      "modelSelectionLocked",
                      "pluginOwnerId",
                      "agentHarnessId",
                    ] as const
                  ).every((field) => isDeepStrictEqual(before?.[field], after?.[field])) &&
                  (p.archivedOnly !== true || after?.archivedAt !== undefined),
              });
            },
            assertActive: () => {
              assertCallerCurrent?.();
              sessionMutationAuthorization?.assertCurrent();
            },
          });
    const { storePath } = target;
    const compatibilityDefaultAgentId = tryResolveAgentOperationAgentId(cfg);
    const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, key);
    const protectedGlobalAgentId =
      persistedStoreOwner.kind === "configured"
        ? persistedStoreOwner.agentId
        : compatibilityDefaultAgentId;
    const explicitlySelectedGlobalAgentId =
      normalizeOptionalString(p.agentId) ?? parseAgentSessionKey(key)?.agentId;
    const isSelectedNonDefaultGlobal =
      target.canonicalKey === "global" &&
      explicitlySelectedGlobalAgentId !== undefined &&
      normalizeAgentId(explicitlySelectedGlobalAgentId) !== protectedGlobalAgentId;
    const isMainSession =
      target.canonicalKey !== "global" && isAgentMainSessionKey(cfg, target.canonicalKey);
    if ((target.canonicalKey === "global" || isMainSession) && !isSelectedNonDefaultGlobal) {
      return invalidSessionRequest(`Cannot delete the main session (${target.canonicalKey}).`);
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;
    const assertExternalCurrent = () => {
      assertCallerCurrent?.();
      sessionMutationAuthorization?.assertCurrent();
      memory?.actor.assertCurrent();
      memory?.authority.assertCurrent();
    };
    const readMemoryEntry = () =>
      memory?.actor.storage!.readCurrent(
        { type: "session.entry.read", input: {} },
        memory.authority,
      );
    const initialDeleteEntry = memory ? readMemoryEntry() : durableRead?.readRetainedEntry();
    const expectedSessionId = p.expectedSessionId?.trim();
    const expectedLifecycleRevision = p.expectedLifecycleRevision?.trim();
    const sessionChangedError = () =>
      errorShape(ErrorCodes.INVALID_REQUEST, `Session ${key} changed before deletion. Retry.`, {
        details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
      });
    const resolveEntryError = (entry: SessionEntry | undefined) => {
      const deletablePluginOwnedSession =
        normalizeOptionalString(entry?.pluginOwnerId) !== undefined &&
        entry?.agentHarnessId === undefined &&
        !isAgentHarnessSessionKey(target.canonicalKey);
      if (isModelSelectionLocked(entry) && !deletablePluginOwnedSession) {
        return errorShape(
          ErrorCodes.INVALID_REQUEST,
          "This session cannot be deleted while model selection is locked.",
        );
      }
      // archivedOnly is the write-scope archive-then-delete contract, rechecked
      // under the fence so a racing unarchive cannot authorize active deletion.
      if (p.archivedOnly === true && entry?.archivedAt === undefined) {
        return errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Session ${key} is not archived. Archive it first, then delete it.`,
        );
      }
      if (
        (expectedSessionId && entry?.sessionId !== expectedSessionId) ||
        (expectedLifecycleRevision && entry?.lifecycleRevision !== expectedLifecycleRevision)
      ) {
        return sessionChangedError();
      }
      return resolvePluginSessionOwnershipError({
        action: "delete",
        entry,
        key: target.canonicalKey,
        pluginOwnerId: client?.internal?.pluginRuntimeOwnerId,
      });
    };
    const initialError = resolveEntryError(initialDeleteEntry);
    if (initialError) {
      return { ok: false, error: initialError };
    }
    if (isIncognitoSessionKey(target.canonicalKey) && !memory) {
      assertExternalCurrent();
      if (p.expectedSessionUpdatedAt !== undefined) {
        return { ok: false, error: sessionChangedError() };
      }
      const result: SessionsDeleteResult = {
        ok: true,
        key: target.canonicalKey,
        deleted: false,
        archived: [],
      };
      onDeleted?.(result);
      return { ok: true, result };
    }
    const assertRefreshable = () => {
      assertExternalCurrent();
      if (durableSource) {
        assertCapturedSessionEntryReadSource(durableSource);
      }
      const retained = durableRead;
      if (!retained?.canRefresh()) {
        throw new SessionDeletionError(sessionChangedError());
      }
      return retained;
    };
    const assertCurrent = () => {
      if (memory) {
        assertExternalCurrent();
        const entry = readMemoryEntry();
        const error = resolveEntryError(entry);
        if (error) {
          throw new SessionDeletionError(error);
        }
        return { ...target, entry, legacyKey: undefined };
      }
      const retained = assertRefreshable();
      if (!retained.isCurrent()) {
        throw new SessionDeletionError(sessionChangedError());
      }
      const current = { ...target, entry: retained.readRetainedEntry(), legacyKey: undefined };
      if (
        current.storePath !== storePath ||
        current.canonicalKey !== target.canonicalKey ||
        current.entry?.sessionId !== initialDeleteEntry?.sessionId ||
        current.entry?.lifecycleRevision !== initialDeleteEntry?.lifecycleRevision
      ) {
        throw new SessionDeletionError(sessionChangedError());
      }
      const error = resolveEntryError(current.entry);
      if (error) {
        throw new SessionDeletionError(error);
      }
      return current;
    };
    const refreshCurrent = async () => {
      if (memory) {
        return assertCurrent();
      }
      const retained = assertRefreshable();
      const pending = retained.prepareRead();
      if (pending) {
        await pending;
      }
      const revision = retained.captureRevision();
      return withSessionEntryReadOnlyInWorker(
        {
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          storePath: durableSource?.path ?? storePath,
          projection: "full",
        },
        assertRefreshable,
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          if (
            !isDeepStrictEqual(owner.source, durableSource) ||
            !retained.acknowledge(read.value, revision)
          ) {
            throw new SessionDeletionError(sessionChangedError());
          }
          return assertCurrent();
        },
      );
    };
    const deleteLifecycleIdentities = [
      target.canonicalKey,
      key,
      ...target.storeKeys,
      initialDeleteEntry?.sessionId,
      expectedSessionId,
    ];
    let drain: SessionLifecycleDrain | undefined;
    let worktreePreserved: PreservedSessionWorktree | undefined;
    let published = false;
    const publishDeletion = (deletion: Awaited<ReturnType<typeof deleteSessionEntryLifecycle>>) => {
      const response: SessionsDeleteResult = {
        ok: true,
        key: target.canonicalKey,
        deleted: deletion.deleted,
        archived: deletion.archivedTranscripts.map((entry) => entry.archivedPath),
        ...(worktreePreserved ? { worktreePreserved } : {}),
      };
      if (published) {
        return response;
      }
      published = true;
      onDeleted?.(response);
      if (deletion.deleted) {
        emitSessionsChanged(context, {
          sessionKey: target.canonicalKey,
          sessionId: deletion.deletedSessionId,
          agentId: target.agentId,
          reason: "delete",
        });
        // The storage owner published the exact removal; this notification refreshes the list.
        emitSessionsChanged(context, { reason: "delete" }, { preparedPublication: true });
      }
      return response;
    };
    const deleteCurrent = async () => {
      try {
        const current = assertCurrent();
        try {
          drain = await prepareSessionLifecycleDrain({
            action: "delete",
            authorize: memory ? assertExternalCurrent : assertCurrent,
            beforeCancel: async () => {
              // Compare before cancellation writes its own terminal metadata.
              if (
                p.expectedSessionUpdatedAt !== undefined &&
                (await refreshCurrent()).entry?.updatedAt !== p.expectedSessionUpdatedAt
              ) {
                throw new SessionDeletionError(sessionChangedError());
              }
            },
            context,
            storePath,
            sessionKeys: Array.from(new Set([key, target.canonicalKey, ...target.storeKeys])),
            sessionId: current.entry?.sessionId,
            session: {
              ok: true,
              value: {
                cfg,
                storePath,
                entry: current.entry,
                canonicalKey: target.canonicalKey,
                agentId: target.agentId,
              },
            },
            sessionKey: target.canonicalKey,
            agentId: target.agentId,
            defaultAgentId: compatibilityDefaultAgentId,
            lifecycleIdentities: deleteLifecycleIdentities.filter((identity): identity is string =>
              Boolean(identity),
            ),
          });
        } catch (error) {
          assertCurrent();
          if (error instanceof SessionDeletionError) {
            throw error;
          }
          if (error instanceof SessionLifecycleWorkspaceRecoveryError) {
            throw new SessionDeletionError(error.error);
          }
          throw new SessionDeletionError(
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `Session ${key} could not safely stop before deletion: ${formatErrorMessage(error)} Retry after active work or worker recovery finishes.`,
              { retryable: true },
            ),
          );
        }
        // Reclaim may wait for an earlier placement operation that needs this mutex.
        return await runSessionMutation({
          diagnosticLabel: "delete",
          target: captureSessionTarget({
            storeScope: storePath,
            sessionKey: target.canonicalKey,
            aliases: deleteLifecycleIdentities,
            incarnation: initialDeleteEntry?.sessionId,
            agentId: target.agentId,
          }),
          kind: "delete",
          policy: "wait",
          assertCurrent,
          prepare: async () => drain?.handoffToMutation(),
          finalize: async () => drain?.release(),
          run: async () => {
            const { entry, legacyKey, canonicalKey } = assertCurrent();
            const retirement = await prepareSessionWorkerPlacementRetirement({
              context,
              sessionId: entry?.sessionId,
            });
            const assertDeletionOwnersCurrent = () => {
              retirement.assertCurrent();
              if (drain?.hasAuthoritativeWork()) {
                throw new SessionDeletionError(
                  errorShape(ErrorCodes.UNAVAILABLE, `Session ${key} is still active; try again.`, {
                    retryable: true,
                  }),
                );
              }
            };
            const commitGuard = () => {
              assertCurrent();
              assertDeletionOwnersCurrent();
            };
            commitGuard();
            const mutationCleanupError = await cleanupSessionBeforeMutation({
              cfg,
              key,
              target,
              entry,
              legacyKey,
              canonicalKey,
              reason: "session-delete",
              assertCurrent: memory
                ? () => {
                    assertExternalCurrent();
                    commitGuard();
                  }
                : commitGuard,
            });
            if (mutationCleanupError) {
              throw new SessionDeletionError(mutationCleanupError);
            }
            // Policy publications omit cold snapshots; deletion compares the complete row.
            const postCleanupTarget = { entry: (await refreshCurrent()).entry, target };
            const postCleanupEntry = postCleanupTarget.entry;
            const deletedWorktreeId = normalizeOptionalString(postCleanupEntry?.worktree?.id);
            commitGuard();
            const pluginOwnerId = normalizeOptionalString(postCleanupEntry?.pluginOwnerId);
            const incognito =
              postCleanupEntry?.incognito === true || isIncognitoSessionKey(target.canonicalKey);
            const deletionParams = {
              agentId: target.agentId,
              archiveTranscript: incognito ? false : deleteTranscript,
              commitGuard: () => {
                // Storage checks the exact row; its history cleanup can invalidate projections.
                if (memory) {
                  assertCurrent();
                } else {
                  assertRefreshable();
                }
                assertDeletionOwnersCurrent();
              },
              deleteDeliveryArtifacts: true,
              deleteTranscriptWithoutArchive: incognito,
              expectedEntry: memory ? undefined : postCleanupEntry,
              expectedLifecycleRevision,
              expectedSessionId: initialDeleteEntry?.sessionId ?? null,
              expectedUpdatedAt: memory ? undefined : postCleanupEntry?.updatedAt,
              storePath,
              target: { canonicalKey: target.canonicalKey, storeKeys: target.storeKeys },
            };
            // Catalog and other plugin-owned sessions keep model selection locked,
            // so deletion must use the exact-row owner-validated lifecycle seam.
            const result =
              postCleanupEntry && pluginOwnerId && isModelSelectionLocked(postCleanupEntry)
                ? await rollbackPluginOwnedSessionEntryLifecycle({
                    ...deletionParams,
                    expectedEntry: postCleanupEntry,
                    expectedPluginOwnerId: pluginOwnerId,
                    target: {
                      canonicalKey: postCleanupTarget.target.canonicalKey,
                      storeKeys: postCleanupTarget.target.storeKeys,
                    },
                  })
                : await deleteSessionEntryLifecycle(deletionParams);
            if (result.expectedEntryMismatch) {
              throw new SessionDeletionError(sessionChangedError());
            }
            if (result.deleted) {
              // Retain cloud affinity on every precommit failure. The absent-session
              // reconciler covers a crash or artifact-publication failure after commit.
              await retirement.retire();
              emitGatewaySessionEndPluginHook({
                cfg,
                sessionKey: target.canonicalKey ?? key,
                sessionId: result.deletedSessionId,
                storePath,
                agentId: target.agentId,
                reason: "deleted",
                archivedTranscripts: result.archivedTranscripts,
              });
              await emitSessionUnboundLifecycleEvent({
                targetSessionKey: target.canonicalKey ?? key,
                reason: "session-delete",
                emitHooks: p.emitLifecycleHooks !== false,
              });
              // Hooks and unbinding retain their historical post-delete order. The
              // generation-scoped purge and checkout cleanup still finish before
              // this fence opens, so a same-key successor cannot be mistaken for it.
              const deletedSessionKey = target.canonicalKey ?? key;
              await handleSessionStateSessionDeleted(deletedSessionKey, requestedAgentId);
              // The absent session plus its retained registry binding survive a crash.
              // Keep this mutation and request lifetime through lossless cleanup, but
              // acknowledge archived cleanup once the visible deletion is committed.
              if (p.archivedOnly === true && !incognito) {
                publishDeletion(result);
              }
              worktreePreserved = await removeSessionWorktree({
                id: deletedWorktreeId,
                sessionKey: deletedSessionKey,
                reason: "session-delete",
              });
            }
            return result;
          },
        });
      } finally {
        drain?.release();
      }
    };
    let deletion: Awaited<ReturnType<typeof deleteCurrent>>;
    try {
      deletion = await deleteCurrent();
    } catch (error) {
      if (error instanceof SessionMutationPreemptTimeoutError) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${key} is still active; try again in a moment.`,
          ),
        };
      }
      if (error instanceof SessionResetCleanupError) {
        return { ok: false, error: sessionChangedError() };
      }
      if (!(error instanceof SessionDeletionError)) {
        throw error;
      }
      return { ok: false, error: error.error };
    }
    const response = publishDeletion(deletion);
    return { ok: true, result: response };
  } finally {
    durableRead?.release();
  }
}

export const sessionDeleteHandlers: GatewayRequestHandlers = {
  "sessions.delete": async (options) => {
    const { params, respond } = options;
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    if (!requireSessionKey(params.key, respond)) {
      return;
    }
    let replied = false;
    try {
      const result = await deleteGatewaySession({
        ...options,
        params,
        onDeleted: (response) => {
          respond(true, response, undefined);
          replied = true;
        },
      });
      if (!result.ok && !replied) {
        respond(false, undefined, result.error);
      }
    } catch (error) {
      if (!replied) {
        throw error;
      }
      // The deletion is durable; failed cleanup stays registered for maintenance.
      sessionLog.warn(`sessions.delete: post-reply cleanup failed: ${formatErrorMessage(error)}`);
    }
  },
};
