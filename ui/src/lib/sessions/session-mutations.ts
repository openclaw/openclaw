import type {
  SessionOwner,
  SessionsAssignOwnerParams,
  SessionsAssignOwnerResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import {
  requestSessionCreate,
  resolveSessionCreateParams,
  type SessionCreateParams,
} from "./create.ts";
import type { SessionPatch, SessionPatchOptions, SessionPatchResult } from "./patch.ts";
import { projectSessionResultRows } from "./reconcile.ts";
import { createSessionArchiveState, projectSessionArchiveFields } from "./session-archive-state.ts";
import type {
  SessionCapability,
  SessionCreateReconciliation,
  SessionRefreshOutcome,
  SessionResetOptions,
  SessionResetResult,
} from "./session-capability.ts";
import { createSessionModelOverrides } from "./session-model-overrides.ts";
import {
  createSessionMutationRefresh,
  isRejectedSessionMutation,
} from "./session-mutation-refresh.ts";
import type { SessionMutationsHost } from "./session-mutations-host.ts";
import { projectSessionPatchRowFields } from "./session-patch-row-facts.ts";
import {
  capturePendingRowReplacement,
  createOptimisticRowField,
  createOptimisticPinPatches,
  createOptimisticSettingsPatches,
  resolvePendingConversation,
  resolvePendingRowTarget,
  resolvePredecessorRowTarget,
  pendingRowIdentity,
  type SessionPinFields,
} from "./session-pending-rows.ts";
import type { SessionPermissionClaim } from "./session-permission-projection.ts";
import {
  requestSessionPatch,
  requestSessionPatchMany,
  requestSessionReset,
} from "./session-requests.ts";
import { createSessionRowLocalPatch } from "./session-row-local-patch.ts";

export function createSessionMutations(host: SessionMutationsHost) {
  const modelOverrides = createSessionModelOverrides(host);
  const archiveState = createSessionArchiveState(
    host.publishedRow,
    () => host.publish({ ...host.readState() }),
    host.archiveFields,
  );
  const preparedWorkSessionKeys = new Set<string>();
  const patchRowLocal = createSessionRowLocalPatch(host);

  const optimisticPins = createOptimisticPinPatches(host);
  const optimisticCategories = createOptimisticRowField(host, "category");
  const optimisticUnread = createOptimisticRowField(host, "unread");
  const settingsPatches = createOptimisticSettingsPatches(host);
  const rowPatches = [
    optimisticPins,
    optimisticUnread,
    optimisticCategories,
    ...settingsPatches.owners,
  ];
  const hasPendingRowPatches = () => rowPatches.some((owner) => owner.hasPending());
  const applyPendingRow = (
    row: GatewaySessionRow,
    sourceAgentId?: string | null,
  ): GatewaySessionRow => {
    if (!hasPendingRowPatches()) {
      return row;
    }
    // Field projections preserve identity and publish only after the row is complete.
    const identity = pendingRowIdentity(host.snapshot(), row, sourceAgentId);
    return rowPatches.reduce((current, owner) => owner.applyRow(current, identity), row);
  };

  const { reconcileConfirmedPreviousConnection, refreshCategory, reportUncertainCategory } =
    createSessionMutationRefresh(host);

  const createResult = async (
    params: SessionCreateParams = {},
    options: { reconciliation?: SessionCreateReconciliation } = {},
  ) => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    try {
      const { currentSessionKey, ...requestParams } = params;
      const result = await requestSessionCreate(scope.client, {
        ...requestParams,
        ...resolveSessionCreateParams(currentSessionKey, params.agentId),
      });
      if (!host.connection.isCurrent(scope)) {
        return (await reconcileConfirmedPreviousConnection(scope, params.agentId)) ? result : null;
      }
      // Creation precedes canonical rows; claim placement before any event or
      // list publication can assign this key an ordinary roster position.
      host.notifyCreated(result.key, result.entry, requestParams.agentId);
      if (requestParams.worktree === true || Boolean(requestParams.execNode?.trim())) {
        preparedWorkSessionKeys.add(result.key.trim());
      }
      if (requestParams.model?.trim()) {
        modelOverrides.set(result.key, requestParams.model, true);
      } else if (preparedWorkSessionKeys.has(result.key)) {
        host.publish({ ...host.readState() });
      }
      const reconciliation = host.reconcileMutation(params.agentId);
      if (options.reconciliation === "background") {
        void reconciliation.catch((error: unknown) => {
          if (host.connection.isCurrent(scope)) {
            host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
          }
        });
      } else {
        await reconciliation;
        if (!host.connection.isCurrent(scope)) {
          return (await reconcileConfirmedPreviousConnection(scope, params.agentId))
            ? result
            : null;
        }
      }
      return result;
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
      }
      return null;
    }
  };

  const create = async (params: SessionCreateParams = {}) =>
    (await createResult(params))?.key ?? null;

  const patch = async (
    key: string,
    patchParams: SessionPatch,
    options: SessionPatchOptions = {},
  ): Promise<SessionPatchResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const managesModelOverride = Object.hasOwn(patchParams, "model");
    const canDispatchSettings = () =>
      !settingsTargetWasReplaced() && options.canDispatch?.() !== false;
    const startSettingsPatch = settingsPatches.prepare(patchParams, canDispatchSettings);
    const hasSettingsPatch = managesModelOverride || startSettingsPatch !== null;
    const normalizedKey = key.trim();
    const patchSnapshot = host.snapshot();
    const pendingConversation =
      hasSettingsPatch ||
      patchParams.category !== undefined ||
      patchParams.pinned !== undefined ||
      patchParams.unread === false ||
      patchParams.archived !== undefined ||
      patchParams.boardFace !== undefined ||
      patchParams.boardPresentation !== undefined
        ? resolvePendingConversation(patchSnapshot, normalizedKey, options.agentId)
        : null;
    let pendingTarget = resolvePendingRowTarget(
      host,
      patchSnapshot,
      pendingConversation,
      options.expectedSessionId,
    );
    const managesThinkingClaim = Object.hasOwn(patchParams, "thinkingLevel");
    let resumeThinkingClaim = managesThinkingClaim
      ? host.suspendThink(normalizedKey, options.agentId)
      : undefined;
    const settingsTargetWasReplaced = capturePendingRowReplacement(
      host,
      patchSnapshot,
      hasSettingsPatch ? pendingConversation : null,
      () => pendingTarget,
    );
    const settingsPatchTarget = pendingTarget ?? pendingConversation;
    const settingsPatchClaims = [
      [settingsPatchTarget, startSettingsPatch?.(settingsPatchTarget) ?? []] as const,
    ];
    let rowPatchConfirmed = false;
    let writeConfirmed = false;
    let permissionProjection: SessionPermissionClaim | undefined;
    const ownsModelOverride = () => options.ownsModelOverride?.() !== false;
    const modelPatch = modelOverrides.preparePatch(key, patchParams, options, scope);
    const nextPinned = patchParams.pinned === true;
    let pinPatchToken: symbol | null = null;
    let unreadPatchToken: symbol | null = null;
    let categoryPatchToken: symbol | null = null;
    const startOptimisticPatch = () => {
      if (patchParams.category !== undefined && !categoryPatchToken && pendingTarget) {
        categoryPatchToken = optimisticCategories.prepare(
          () => patchParams.category?.trim() || undefined,
        )(pendingTarget);
      }
      modelPatch.start();
      // Sidebar rows read `pinned` straight off the snapshot, so a pin/unpin has
      // no visible outcome until this flip; the Gateway patch and its list
      // refresh confirm it afterwards.
      if (patchParams.pinned !== undefined && !pinPatchToken && pendingTarget) {
        pinPatchToken = optimisticPins.start(pendingTarget, nextPinned);
      }
      // Mark-unread needs the Gateway-issued marker before an active pane can
      // distinguish the explicit reminder from new activity. Reads are safe
      // to project immediately because their observed marker remains attached.
      if (patchParams.unread === false && !unreadPatchToken && pendingTarget) {
        unreadPatchToken = optimisticUnread.prepare(() => false)(pendingTarget);
      }
    };
    if (!options.waitFor) {
      startOptimisticPatch();
    }
    const settleOptimisticPatch = (completed: boolean) => {
      modelPatch.settle(completed);
      if (managesThinkingClaim) {
        if (completed) {
          host.clearThink(normalizedKey, options.agentId);
        } else {
          resumeThinkingClaim?.();
        }
        resumeThinkingClaim = undefined;
      }
      for (const [target, tokens] of [
        [
          pendingTarget,
          [
            [optimisticPins, pinPatchToken],
            [optimisticUnread, unreadPatchToken],
            [optimisticCategories, categoryPatchToken],
          ],
        ],
        ...settingsPatchClaims,
      ] as const) {
        if (!target) {
          continue;
        }
        for (const [owner, token] of tokens) {
          if (token) {
            owner.settle(
              target,
              token,
              completed && rowPatchConfirmed,
              host.connection.isCurrent(scope),
            );
          }
        }
      }
    };
    const adoptPredecessorReceipt = () => {
      if (!host.connection.isCurrent(scope) || !hasSettingsPatch) {
        return;
      }
      const target = resolvePredecessorRowTarget(
        patchSnapshot,
        pendingConversation,
        pendingTarget,
        options,
      );
      if (target) {
        pendingTarget = target;
        if (canDispatchSettings()) {
          // The ACK can identify a row before any roster can bind its preview.
          settingsPatchClaims.push([pendingTarget, startSettingsPatch?.(pendingTarget) ?? []]);
        }
      }
    };
    let unsubscribeReceipt: (() => void) | undefined;
    try {
      if (options.waitFor) {
        unsubscribeReceipt = options.predecessorReceipt?.subscribe(adoptPredecessorReceipt);
        adoptPredecessorReceipt();
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
      if (options.canDispatch?.() === false) {
        settleOptimisticPatch(false);
        return null;
      }
      startOptimisticPatch();
      if (!host.connection.isCurrent(scope) || !canDispatchSettings()) {
        settleOptimisticPatch(false);
        return null;
      }
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
      rowPatchConfirmed =
        pendingTarget !== null &&
        result.entry.sessionId === pendingTarget.sessionId &&
        resolvePendingConversation(patchSnapshot, result.key, pendingTarget.agentId)?.identity ===
          pendingTarget.identity;
      if (pendingTarget && rowPatchConfirmed && confirmFields) {
        const readCutoff = host.readRevision();
        for (const fields of projectSessionPatchRowFields(patchParams, result)) {
          confirmFields({
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
              ...(result.entry?.updatedAt === undefined
                ? {}
                : { updatedAt: result.entry.updatedAt }),
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
      if (!options.deferListRefresh) {
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
          return (await reconcileConfirmedPreviousConnection(scope, options.agentId))
            ? result
            : null;
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
      if (uncertainCategory && categoryPatchToken && pendingTarget) {
        optimisticCategories.settle(pendingTarget, categoryPatchToken, false, false);
        categoryPatchToken = null;
        if (pinPatchToken) {
          optimisticPins.settle(pendingTarget, pinPatchToken, false, false);
          pinPatchToken = null;
        }
      }
      try {
        if (
          !writeConfirmed &&
          host.connection.isCurrent(scope) &&
          !settingsTargetWasReplaced() &&
          settingsPatchClaims.some(
            ([target, tokens]) =>
              target && tokens.some(([owner, token]) => token && owner.owns(target, token)),
          )
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
      if (ownsModelOverride() && !settingsTargetWasReplaced()) {
        host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
      }
      throw error;
    } finally {
      unsubscribeReceipt?.();
    }
  };

  const patchMany: SessionCapability["patchMany"] = async (targets, patchParams) => {
    const scope = host.connection.capture();
    if (!scope) {
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
    const snapshot = host.snapshot();
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
  };

  const reset = async (
    key: string,
    options: SessionResetOptions = {},
  ): Promise<SessionResetResult> => {
    const scope = host.connection.capture();
    if (!scope) {
      return "not-started";
    }
    try {
      await requestSessionReset(scope.client, key, options);
      return host.connection.isCurrent(scope) ? "completed" : "uncertain";
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
      }
      // Reset can commit before awaited lifecycle work rejects; never infer safe retry.
      return "uncertain";
    }
  };

  const assignOwner = async (
    key: string,
    owner: SessionsAssignOwnerParams["owner"],
    options: { agentId?: string | null } = {},
  ): Promise<SessionOwner | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const snapshot = host.snapshot();
    const conversation = resolvePendingConversation(snapshot, key, options.agentId);
    const row =
      conversation &&
      host.findRow(
        (candidate, agentId) =>
          pendingRowIdentity(snapshot, candidate, agentId) === conversation.identity,
      );
    const target =
      conversation && row?.sessionId
        ? { agentId: conversation.agentId, sessionId: row.sessionId }
        : undefined;
    try {
      const result = await scope.client.request<SessionsAssignOwnerResult>("sessions.assignOwner", {
        key,
        owner,
        ...(options.agentId ? { agentId: options.agentId } : {}),
      });
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      if (target) {
        patchRowLocal(result.key, { owner: result.owner }, target);
      }
      return result.owner;
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
      }
      return null;
    }
  };

  const dispose = () => {
    modelOverrides.clear();
    for (const owner of rowPatches) {
      owner.clear();
    }
    archiveState.clearAll();
    preparedWorkSessionKeys.clear();
  };

  return {
    create,
    createResult,
    reconcileConfirmedPreviousConnection,
    retireDeletedSession(this: void, key: string) {
      host.retirePullRequestSummary(key);
      archiveState.clear(key);
      preparedWorkSessionKeys.delete(key.trim());
      modelOverrides.set(key, undefined);
    },
    patch,
    settingsPreview(this: void, key: string, agentId?: string) {
      const conversation = resolvePendingConversation(host.snapshot(), key, agentId);
      return conversation ? settingsPatches.read(conversation.identity) : undefined;
    },
    patchMany,
    assignOwner,
    patchRowLocal,
    /**
     * Re-asserts in-flight row intents over Gateway events and list refreshes,
     * which carry the pre-mutation value until the patch lands.
     */
    applyPendingRow,
    observePendingFields(
      row: GatewaySessionRow,
      names: readonly string[],
      sourceAgentId?: string | null,
    ) {
      if (!hasPendingRowPatches()) {
        return;
      }
      const identity = pendingRowIdentity(host.snapshot(), row, sourceAgentId);
      for (const owner of rowPatches) {
        owner.observe(row, names, identity);
      }
    },
    applyPendingRows(
      result: SessionsListResult | null,
      sourceAgentId?: string | null,
    ): SessionsListResult | null {
      if (!result || !hasPendingRowPatches()) {
        return result;
      }
      return projectSessionResultRows(
        result,
        result.sessions.map((row) => applyPendingRow(row, sourceAgentId)),
      );
    },
    applyConfirmedArchives: archiveState.apply,
    applyConfirmedArchiveRow: archiveState.applyRow,
    observeArchiveState: archiveState.observe,
    confirmArchiveState: archiveState.confirm,
    reset,
    retireModelOverride: modelOverrides.retire,
    archiveVisibility: archiveState.visibility,
    beginArchive: archiveState.beginPending,
    isPreparedWorkSession: (key: string) => preparedWorkSessionKeys.has(key.trim()),
    settlePrepared(result: SessionsListResult | null) {
      for (const row of result?.sessions ?? []) {
        modelOverrides.settleCreated(row);
        if (row.worktree || row.execNode) {
          preparedWorkSessionKeys.delete(row.key);
        }
      }
    },
    retireConnection() {
      dispose();
      // Row intents live inside `result`, which the replacement connection
      // rehydrates wholesale; only the model-override side map outlives that
      // replacement, so it is the one that needs an explicit rollback below.
      const state = host.readState();
      host.publish({ ...state, modelOverrides: {} });
    },
    dispose,
  };
}
