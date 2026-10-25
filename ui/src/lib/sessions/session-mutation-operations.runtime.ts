import type {
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { SESSION_ARCHIVE_REQUEST_OPTIONS } from "../../../../src/shared/session-archive-timeout.ts";
import { formatUiError } from "../format-error.ts";
import { showToast } from "../toast.ts";
import {
  requestSessionCreate,
  type SessionCreateParams,
  type SessionCreateRequestOptions,
} from "./create.ts";
import type {
  SessionPatch,
  SessionPatchOptions,
  SessionPatchResult,
  SessionPatchRoute,
} from "./patch.ts";
import { projectSessionArchiveFields } from "./session-archive-state.ts";
import { resolveSessionCreateParams } from "./session-create-params.ts";
import { releaseSessionPatchPreview, type SessionPatchPreview } from "./session-deferred-patch.ts";
import type { Deletion, SessionDeletionOperationsHost } from "./session-deletions.ts";
import type { createSessionModelOverrides } from "./session-model-overrides.ts";
import { registerSessionMutationOperations } from "./session-mutation-operations.ts";
import {
  createSessionMutationRefresh,
  isRejectedSessionMutation,
} from "./session-mutation-refresh.ts";
import type { SessionMutationsHost } from "./session-mutations-host.ts";
import { projectSessionPatchRowFields } from "./session-patch-row-facts.ts";
import {
  type PendingRowTarget,
  type SessionPinFields,
  resolvePendingConversation,
} from "./session-pending-rows.ts";
import type { SessionPermissionClaim } from "./session-permission-projection.ts";
import { requestSessionPatch } from "./session-requests.ts";
import type { createSessionRowLocalPatch } from "./session-row-local-patch.ts";
import type {
  SessionConnectionScope,
  SessionRefreshOutcome,
  SessionCreateReconciliation,
  SessionRequestClient,
} from "./session-types.ts";

export function reconcileConfirmedSessionConnection(
  host: SessionMutationsHost,
  scope: SessionConnectionScope,
  agentId?: string | null,
): Promise<boolean> {
  return createSessionMutationRefresh(host).reconcileConfirmedPreviousConnection(scope, agentId);
}

export async function runSessionPatch(
  host: SessionMutationsHost,
  scope: SessionConnectionScope,
  key: string,
  patchParams: SessionPatch,
  options: SessionPatchOptions,
  owner: {
    hasSettingsPatch: boolean;
    patchSnapshot: ReturnType<SessionMutationsHost["snapshot"]>;
    pendingTarget: () => PendingRowTarget | null;
    startOptimisticPatch: () => void;
    settleOptimisticPatch: (completed: boolean, rowPatchConfirmed: boolean) => void;
    adoptPredecessorReceipt: () => void;
    unsubscribeReceipt: (() => void) | undefined;
    settingsTargetWasReplaced: () => boolean;
    canDispatchSettings: () => boolean;
    ownsSettingsPatch: () => boolean;
    releaseUncertainCategory: () => void;
    patchRowLocal: ReturnType<typeof createSessionRowLocalPatch>;
  },
): Promise<SessionPatchResult | null> {
  const {
    hasSettingsPatch,
    patchSnapshot,
    startOptimisticPatch,
    adoptPredecessorReceipt,
    unsubscribeReceipt,
    settingsTargetWasReplaced,
    canDispatchSettings,
    patchRowLocal,
  } = owner;
  const { reconcileConfirmedPreviousConnection, refreshCategory, reportUncertainCategory } =
    createSessionMutationRefresh(host);
  let rowPatchConfirmed = false;
  let writeConfirmed = false;
  let permissionProjection: SessionPermissionClaim | undefined;
  const settleOptimisticPatch = (completed: boolean) =>
    owner.settleOptimisticPatch(completed, rowPatchConfirmed);
  try {
    if (options.waitFor) {
      await options.waitFor;
      if (!host.connection.isCurrent(scope)) {
        settleOptimisticPatch(false);
        return null;
      }
      adoptPredecessorReceipt();
      if (settingsTargetWasReplaced()) {
        settleOptimisticPatch(false);
        return null;
      }
    }
    let pendingTarget = owner.pendingTarget();
    if (options.canDispatch?.() === false) {
      settleOptimisticPatch(false);
      return null;
    }
    if (!host.connection.isCurrent(scope) || !canDispatchSettings()) {
      settleOptimisticPatch(false);
      return null;
    }
    startOptimisticPatch();
    if (Object.hasOwn(patchParams, "permissionMode")) {
      permissionProjection = host.claimPermissionProjection(
        key,
        options.agentId,
        options.expectedSessionId,
      );
    }
    const confirmFields = pendingTarget ? host.capturePatchFields(pendingTarget) : undefined;
    const result = await requestSessionPatch(
      scope.client,
      key,
      patchParams,
      hasSettingsPatch && pendingTarget
        ? { ...options, expectedSessionId: pendingTarget.sessionId }
        : options,
    );
    writeConfirmed = true;
    if (!host.connection.isCurrent(scope)) {
      settleOptimisticPatch(false);
      return (await reconcileConfirmedPreviousConnection(scope, options.agentId)) ? result : null;
    }
    options.onConfirmed?.(result);
    // The receipt can bind a previously unbound settings target synchronously.
    pendingTarget = owner.pendingTarget();
    rowPatchConfirmed =
      pendingTarget !== null &&
      result.entry.sessionId === pendingTarget.sessionId &&
      resolvePendingConversation(patchSnapshot, result.key, pendingTarget.agentId)?.identity ===
        pendingTarget.identity;
    if (pendingTarget && rowPatchConfirmed) {
      const confirm = confirmFields ?? host.capturePatchFields(pendingTarget);
      const readCutoff = host.readRevision();
      for (const fields of projectSessionPatchRowFields(patchParams, result)) {
        confirm({
          key: pendingTarget.key,
          agentId: pendingTarget.agentId,
          sessionId: pendingTarget.sessionId,
          updatedAt: result.entry.updatedAt ?? null,
          readCutoff,
          fields,
        });
      }
    }
    if (permissionProjection) {
      const confirmation = permissionProjection.confirm({
        sessionId: result.entry?.sessionId,
        permissionMode: result.entry?.permissionMode,
        updatedAt: result.entry?.updatedAt,
      });
      if (confirmation === "superseded") {
        settleOptimisticPatch(true);
        return result;
      }
      // The successful RPC is the first durable acknowledgement; events may
      // drop and the follow-up list may fail, so record its fenced fact now.
      const confirmedTarget = resolvePendingConversation(patchSnapshot, key, options.agentId);
      if (confirmation === "confirmed" && confirmedTarget && result.entry?.sessionId) {
        patchRowLocal(
          key,
          {
            permissionMode: result.entry?.permissionMode,
            ...(result.entry?.updatedAt === undefined ? {} : { updatedAt: result.entry.updatedAt }),
          },
          { agentId: confirmedTarget.agentId, sessionId: result.entry.sessionId },
        );
      }
    }
    // Placement is settled by its durable receipt, not a roster round trip.
    // The existing refresh owner still reconciles membership in the background.
    if (
      patchParams.category !== undefined &&
      Object.keys(patchParams).every((name) => name === "category" || name === "pinned")
    ) {
      settleOptimisticPatch(true);
      if (!options.deferListRefresh) {
        refreshCategory(scope, options.agentId);
      }
      return result;
    }
    // Commit and list reconciliation are separate outcomes. Callers must not
    // turn a failed refresh into an apparent rollback of the committed patch.
    let refreshOutcome: SessionRefreshOutcome = { status: "refreshed" };
    // Read receipts settle their row fields; events still invalidate roster membership.
    const confirmedRead =
      rowPatchConfirmed && patchParams.unread === false && Object.keys(patchParams).length === 1;
    if (!options.deferListRefresh && !confirmedRead) {
      if (Object.hasOwn(patchParams, "permissionMode")) {
        refreshOutcome = await host.reconcileMutation(
          options.agentId,
          permissionProjection?.isCurrent,
        );
      } else {
        await host.reconcileMutation(options.agentId);
      }
      if (!host.connection.isCurrent(scope)) {
        settleOptimisticPatch(false);
        return (await reconcileConfirmedPreviousConnection(scope, options.agentId)) ? result : null;
      }
      if (permissionProjection?.isCurrent() === false) {
        settleOptimisticPatch(true);
        return result;
      }
    }
    settleOptimisticPatch(true);
    return refreshOutcome.status === "failed"
      ? { ...result, listRefreshError: refreshOutcome.error }
      : result;
  } catch (error) {
    // Transport loss is not evidence of rollback. Release the tentative value
    // without restoring its predecessor, then reconcile the original owner.
    const uncertainCategory =
      patchParams.category !== undefined && !writeConfirmed && !isRejectedSessionMutation(error);
    if (uncertainCategory) {
      owner.releaseUncertainCategory();
    }
    try {
      if (
        !writeConfirmed &&
        host.connection.isCurrent(scope) &&
        !settingsTargetWasReplaced() &&
        owner.ownsSettingsPatch()
      ) {
        options.onRejected?.(error);
      }
    } finally {
      settleOptimisticPatch(writeConfirmed);
    }
    if (!host.connection.isCurrent(scope)) {
      return null;
    }
    if (uncertainCategory) {
      throw reportUncertainCategory(error, options.agentId);
    }
    if (options.ownsModelOverride?.() !== false && !settingsTargetWasReplaced()) {
      host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
    }
    throw error;
  } finally {
    unsubscribeReceipt?.();
  }
}

export async function runSessionDeferredPatch(
  host: SessionMutationsHost,
  patch: SessionPatchRoute,
  preview: SessionPatchPreview,
  patchParams: SessionPatch,
  options: SessionPatchOptions,
): Promise<void> {
  const { target } = preview;
  try {
    const result = await patch(target.key, patchParams, {
      ...options,
      agentId: target.agentId,
      expectedSessionId: target.sessionId,
      // The initiating dialog or batch has completed; replay owns refresh.
      deferListRefresh: false,
    });
    const error = host.readState().error;
    if (result === null && error) {
      showToast({ message: error });
    }
  } catch (error) {
    showToast({ message: formatUiError(error) });
  } finally {
    releaseSessionPatchPreview(preview);
    options.onDeferredSettled?.();
  }
}

export function runDeferredSessionDelete(
  record: Deletion,
  scope: SessionConnectionScope,
  host: SessionDeletionOperationsHost,
): Promise<void> {
  return import("./session-delete-operation.ts").then(
    ({ runDeferredSessionDelete: run }) => run(record, scope, host),
    (error: unknown) => {
      if (host.owns(record)) {
        host.rollback(record);
        host.reportError(formatUiError(error));
      }
    },
  );
}

export async function createSessionResult(
  host: SessionMutationsHost,
  scope: SessionConnectionScope,
  params: SessionCreateParams,
  options: SessionCreateRequestOptions & { reconciliation?: SessionCreateReconciliation },
  owner: {
    preparedWorkSessionKeys: Set<string>;
    modelOverrides: Pick<ReturnType<typeof createSessionModelOverrides>, "set">;
    reportError: (scope: SessionConnectionScope, error: unknown) => void;
  },
) {
  if (!host.connection.isCurrent(scope) || options.signal?.aborted) {
    return null;
  }
  const { currentSessionKey, ...requestParams } = params;
  const result = await requestSessionCreate(
    scope.client,
    {
      ...requestParams,
      ...resolveSessionCreateParams(currentSessionKey, params.agentId),
    },
    options,
  );
  if (!host.connection.isCurrent(scope)) {
    return (await reconcileConfirmedSessionConnection(host, scope, params.agentId)) ? result : null;
  }
  // Creation precedes canonical rows; claim placement before any event or
  // list publication can assign this key an ordinary roster position.
  host.notifyCreated(result.key, result.entry, requestParams.agentId);
  if (requestParams.worktree === true || Boolean(requestParams.execNode?.trim())) {
    owner.preparedWorkSessionKeys.add(result.key.trim());
  }
  if (requestParams.model?.trim()) {
    owner.modelOverrides.set(result.key, requestParams.model, true);
  } else if (owner.preparedWorkSessionKeys.has(result.key)) {
    host.publish({ ...host.readState() });
  }
  const reconciliation = host.reconcileMutation(params.agentId, undefined, true);
  if (options.reconciliation === "background") {
    void reconciliation.catch((error: unknown) => owner.reportError(scope, error));
  } else {
    await reconciliation;
    if (!host.connection.isCurrent(scope)) {
      return (await reconcileConfirmedSessionConnection(host, scope, params.agentId))
        ? result
        : null;
    }
  }
  return result;
}

export async function patchSessionBatch(
  host: SessionMutationsHost,
  scope: SessionConnectionScope,
  snapshot: ReturnType<SessionMutationsHost["snapshot"]>,
  targets: SessionsPatchManyParams["targets"],
  patchParams: SessionsPatchManyParams["patch"],
): Promise<SessionsPatchManyResult | null> {
  if (!host.connection.isCurrent(scope)) {
    return null;
  }
  const { archived, pinned } = patchParams;
  // Batch outcomes confirm pin intent without returning the Gateway's pin timestamp.
  const pin: SessionPinFields | { pinned: true } | undefined =
    pinned === true
      ? { pinned: true }
      : pinned === false
        ? { pinned: false, pinnedAt: undefined }
        : undefined;
  const fields =
    archived === undefined
      ? pin
      : { ...projectSessionArchiveFields(archived), ...(archived ? undefined : pin) };
  const confirmations = fields
    ? targets.map((target) => {
        const identity = resolvePendingConversation(snapshot, target.key, target.agentId);
        const sessionId = target.expectedSessionId?.trim();
        if (!identity || !sessionId) {
          return null;
        }
        const owned = { ...identity, sessionId };
        return { owned, confirm: host.capturePatchFields(owned) };
      })
    : [];
  const result = await requestSessionPatchMany(scope.client, { targets, patch: patchParams });
  if (!host.connection.isCurrent(scope)) {
    return result;
  }
  if (fields) {
    const readCutoff = host.readRevision();
    result.outcomes.forEach((outcome, index) => {
      const confirmation = confirmations[index];
      if (outcome.ok && confirmation) {
        confirmation.confirm({
          key: confirmation.owned.key,
          agentId: confirmation.owned.agentId,
          sessionId: confirmation.owned.sessionId,
          updatedAt: null,
          readCutoff,
          fields,
        });
      }
    });
  }
  return result;
}

export function requestSessionPatchMany(
  client: SessionRequestClient,
  params: SessionsPatchManyParams,
): Promise<SessionsPatchManyResult> {
  return params.patch.archived === true
    ? client.request<SessionsPatchManyResult>(
        "sessions.patchMany",
        params,
        SESSION_ARCHIVE_REQUEST_OPTIONS,
      )
    : client.request<SessionsPatchManyResult>("sessions.patchMany", params);
}

registerSessionMutationOperations({
  reconcileConfirmedSessionConnection,
  runSessionPatch,
  runSessionDeferredPatch,
  runDeferredSessionDelete,
  patchSessionBatch,
  createSessionResult,
});
