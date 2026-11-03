import type {
  SessionOwner,
  SessionsAssignOwnerParams,
  SessionsAssignOwnerResult,
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import type { SessionCreateParams, SessionCreateRequestOptions } from "./create.ts";
import type {
  SessionPatch,
  SessionPatchOptions,
  SessionPatchResult,
  SessionPatchRoute,
} from "./patch.ts";
import { mapSessionResultRows } from "./reconcile.ts";
import { createSessionArchiveState } from "./session-archive-state.ts";
import { createOptimisticArchivePatches, deferSessionPatch } from "./session-deferred-patch.ts";
import { createHiddenRunReads } from "./session-hidden-run-reads.ts";
import { createSessionModelOverrides } from "./session-model-overrides.ts";
import { withSessionMutationOperations } from "./session-mutation-operations.ts";
import type { SessionMutationsHost } from "./session-mutations-host.ts";
import {
  capturePendingRowReplacement,
  createOptimisticRowField,
  createOptimisticPinPatches,
  createOptimisticSettingsPatches,
  resolvePendingConversation,
  resolvePendingRowTarget,
  resolvePredecessorRowTarget,
  pendingRowIdentity,
} from "./session-pending-rows.ts";
import { requestSessionReset } from "./session-requests.ts";
import { createSessionRowLocalPatch } from "./session-row-local-patch.ts";
import type {
  SessionConnectionScope,
  SessionArchiveVisibility,
  SessionCreateReconciliation,
  SessionResetOptions,
  SessionResetResult,
} from "./session-types.ts";

export function createSessionMutations(host: SessionMutationsHost) {
  const reportError = (scope: SessionConnectionScope, error: unknown) => {
    if (host.connection.isCurrent(scope)) {
      host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
    }
  };
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
  const metadataFields = {
    label: createOptimisticRowField(host, "label"),
    icon: createOptimisticRowField(host, "icon"),
    color: createOptimisticRowField(host, "color"),
    category: optimisticCategories,
  };
  const optimisticUnread = createOptimisticRowField(host, "unread");
  const acknowledgeHiddenRuns = createHiddenRunReads(host, optimisticUnread);
  const optimisticArchive = createOptimisticArchivePatches(host);
  const settingsPatches = createOptimisticSettingsPatches(host);
  const rowPatches: Array<
    Pick<
      ReturnType<typeof createOptimisticRowField>,
      "hasPending" | "applyRow" | "observe" | "clear"
    >
  > = [
    optimisticPins,
    optimisticUnread,
    optimisticArchive,
    ...Object.values(metadataFields),
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

  const reconcileConfirmedPreviousConnection = async (
    scope: SessionConnectionScope,
    agentId?: string | null,
  ) =>
    withSessionMutationOperations((runtime) =>
      runtime.reconcileConfirmedSessionConnection(host, scope, agentId),
    );

  const createResult = async (
    params: SessionCreateParams = {},
    options: SessionCreateRequestOptions & { reconciliation?: SessionCreateReconciliation } = {},
  ) => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    try {
      return await withSessionMutationOperations((runtime) =>
        runtime.createSessionResult(host, scope, params, options, {
          preparedWorkSessionKeys,
          modelOverrides,
          reportError,
        }),
      );
    } catch (error) {
      if (options.signal?.aborted || !host.connection.isCurrent(scope)) {
        return null;
      }
      reportError(scope, error);
      throw error;
    }
  };

  const create = async (
    params: SessionCreateParams = {},
    options?: SessionCreateRequestOptions,
  ) => {
    try {
      return (await createResult(params, options))?.key ?? null;
    } catch {
      // Key-only callers consume the owner's published error; result callers retain its cause.
      return null;
    }
  };

  const patchNow = (
    key: string,
    patchParams: SessionPatch,
    options: SessionPatchOptions = {},
  ): Promise<SessionPatchResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return Promise.resolve(null);
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
      patchParams.label !== undefined ||
      patchParams.icon !== undefined ||
      patchParams.color !== undefined ||
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
    const modelPatch = modelOverrides.preparePatch(key, patchParams, options, scope);
    const nextPinned = patchParams.pinned === true;
    let pinPatchToken: symbol | null = null;
    let unreadPatchToken: symbol | null = null;
    let categoryPatchToken: symbol | null = null;
    const displayClaims: Array<readonly [typeof optimisticCategories, symbol | null]> = [];
    const startOptimisticPatch = () => {
      if (displayClaims.length === 0 && pendingTarget) {
        for (const field of ["label", "icon", "color"] as const) {
          if (patchParams[field] !== undefined) {
            const owner = metadataFields[field];
            displayClaims.push([
              owner,
              owner.prepare(() => patchParams[field]?.trim() || undefined)(pendingTarget),
            ]);
          }
        }
      }
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
    const settleOptimisticPatch = (completed: boolean, rowPatchConfirmed: boolean) => {
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
            ...displayClaims,
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
          settingsPatchClaims.push([pendingTarget, startSettingsPatch?.(pendingTarget) ?? []]);
        }
      }
    };
    const ownsSettingsPatch = () =>
      settingsPatchClaims.some(
        ([target, tokens]) =>
          target && tokens.some(([owner, token]) => token && owner.owns(target, token)),
      );
    // Receipt admission must not wait for either the predecessor or a cold chunk.
    const unsubscribeReceipt = options.waitFor
      ? options.predecessorReceipt?.subscribe(adoptPredecessorReceipt)
      : undefined;
    if (options.waitFor) {
      adoptPredecessorReceipt();
    }
    const execution = withSessionMutationOperations(
      (runtime) =>
        runtime.runSessionPatch(host, scope, key, patchParams, options, {
          hasSettingsPatch,
          patchSnapshot,
          pendingTarget: () => pendingTarget,
          startOptimisticPatch,
          settleOptimisticPatch,
          adoptPredecessorReceipt,
          unsubscribeReceipt,
          settingsTargetWasReplaced,
          canDispatchSettings,
          ownsSettingsPatch,
          releaseUncertainCategory() {
            if (categoryPatchToken && pendingTarget) {
              optimisticCategories.settle(pendingTarget, categoryPatchToken, false, false);
              categoryPatchToken = null;
              if (pinPatchToken) {
                optimisticPins.settle(pendingTarget, pinPatchToken, false, false);
                pinPatchToken = null;
              }
            }
          },
          patchRowLocal,
        }),
      async (error) => {
        try {
          if (
            host.connection.isCurrent(scope) &&
            !settingsTargetWasReplaced() &&
            ownsSettingsPatch()
          ) {
            options.onRejected?.(error);
          }
        } finally {
          settleOptimisticPatch(false, false);
          unsubscribeReceipt?.();
        }
        if (!host.connection.isCurrent(scope)) {
          return null;
        }
        if (options.ownsModelOverride?.() !== false && !settingsTargetWasReplaced()) {
          reportError(scope, error);
        }
        throw error;
      },
    );
    return Promise.resolve(execution);
  };

  const patch: SessionPatchRoute = async (key, patchParams, options = {}) =>
    deferSessionPatch(
      host,
      metadataFields,
      optimisticArchive,
      patchNow,
      key,
      patchParams,
      options,
    ) ?? patchNow(key, patchParams, options);

  const patchMany = async (
    targets: SessionsPatchManyParams["targets"],
    patchParams: SessionsPatchManyParams["patch"],
  ): Promise<SessionsPatchManyResult | null> => {
    const scope = host.connection.capture();
    if (!scope) {
      return null;
    }
    const snapshot = host.snapshot();
    return withSessionMutationOperations((runtime) =>
      runtime.patchSessionBatch(host, scope, snapshot, targets, patchParams),
    );
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
      reportError(scope, error);
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
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      reportError(scope, error);
      throw error;
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
    patchNow,
    settingsPreview(this: void, key: string, agentId?: string) {
      const conversation = resolvePendingConversation(host.snapshot(), key, agentId);
      return conversation ? settingsPatches.read(conversation.identity) : undefined;
    },
    patchMany,
    acknowledgeHiddenRuns,
    assignOwner,
    patchRowLocal,
    /** Confirmed archive facts precede in-flight row intents on every presentation. */
    applyRow: (row: GatewaySessionRow, sourceAgentId?: string | null) =>
      applyPendingRow(archiveState.applyRow(row), sourceAgentId),
    observePendingFields(
      row: GatewaySessionRow,
      names: readonly string[],
      sourceAgentId?: string | null,
    ) {
      if (!hasPendingRowPatches()) {
        return;
      }
      const snapshot = host.snapshot();
      const identity = pendingRowIdentity(snapshot, row, sourceAgentId);
      const current = host.findRow(
        (candidate, agentId) =>
          candidate.sessionId === row.sessionId &&
          pendingRowIdentity(snapshot, candidate, agentId) === identity,
      );
      if (
        current?.updatedAt != null &&
        row.updatedAt != null &&
        row.updatedAt < current.updatedAt
      ) {
        return;
      }
      for (const owner of rowPatches) {
        owner.observe(row, names, identity);
      }
    },
    applyRows(
      result: SessionsListResult | null,
      sourceAgentId?: string | null,
    ): SessionsListResult | null {
      const archived = archiveState.apply(result);
      if (!archived || !hasPendingRowPatches()) {
        return archived;
      }
      return mapSessionResultRows(archived, (row) => applyPendingRow(row, sourceAgentId));
    },
    observeArchiveState: archiveState.observe,
    observeArchiveRead: archiveState.observeRead,
    confirmArchiveState: archiveState.confirm,
    reset,
    retireModelOverride: modelOverrides.retire,
    archiveVisibility(this: void, key: string): SessionArchiveVisibility | undefined {
      const target = resolvePendingConversation(host.snapshot(), key);
      const pending = target ? optimisticArchive.read(target.identity) : undefined;
      return pending
        ? pending.next.archived
          ? "archived"
          : undefined
        : archiveState.visibility(key);
    },
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
    retireConnection(retainDeferredIntents = false) {
      modelOverrides.clear();
      for (const owner of rowPatches) {
        if (
          !retainDeferredIntents ||
          (owner !== optimisticArchive &&
            !Object.values(metadataFields).some((metadata) => metadata === owner))
        ) {
          owner.clear();
        }
      }
      archiveState.clearAll();
      preparedWorkSessionKeys.clear();
      // Same-owner reconnect keeps queued row changes over the retained presentation.
      const state = host.readState();
      host.publish({ ...state, modelOverrides: {} });
    },
    dispose,
  };
}
