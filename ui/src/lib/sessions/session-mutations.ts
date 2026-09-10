import type {
  SessionOwner,
  SessionsAssignOwnerParams,
  SessionsAssignOwnerResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { deriveSessionUnread } from "../../../../src/shared/session-unread.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import {
  requestSessionCreate,
  resolveSessionCreateParams,
  type SessionCreateParams,
  type SessionCreateOutcome,
} from "./create.ts";
import type { SessionPatch, SessionPatchOptions, SessionPatchResult } from "./patch.ts";
import { createSessionArchiveState } from "./session-archive-state.ts";
import type {
  SessionCapability,
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionCreateReconciliation,
  SessionResetOptions,
  SessionResetResult,
  SessionState,
} from "./session-capability.ts";
import { areUiSessionKeysEquivalent } from "./session-key.ts";
import {
  createOptimisticRowPatches,
  resolvePendingConversation,
  pendingRowIdentity,
  type PendingRowHost,
  type PendingRowTarget,
  type SessionPatchRowFact,
  type SessionPinFields,
} from "./session-pending-rows.ts";
import type { SessionPermissionClaim } from "./session-permission-projection.ts";
import { requestSessionPatch, requestSessionReset } from "./session-requests.ts";
import type { SessionRefreshOutcome } from "./session-roster-refresh.ts";

type SessionMutationsHost = PendingRowHost & {
  connection: SessionConnectionOwner;
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  copyRow: (row: GatewaySessionRow, patch: Partial<GatewaySessionRow>) => GatewaySessionRow;
  capturePatchFields: (
    target: Pick<PendingRowTarget, "key" | "agentId" | "sessionId">,
  ) => (fact: SessionPatchRowFact) => void;
  refreshReplacement: SessionCapability["refreshReplacement"];
  refreshReplacementResult: (
    agentId?: string | null,
    isErrorCurrent?: () => boolean,
  ) => Promise<SessionRefreshOutcome>;
  publishedRow: (key: string) => GatewaySessionRow | undefined;
  notifyCreated: (key: string, entry?: SessionCreateOutcome["entry"], agentId?: string) => void;
  clearThink: (key: string, agentId?: string | null) => void;
  claimPermissionProjection: (
    key: string,
    agentId?: string | null,
    expectedSessionId?: string,
  ) => SessionPermissionClaim;
  retirePullRequestSummary: (key: string) => void;
};

export function createSessionMutations(host: SessionMutationsHost) {
  const pendingModelPatches = new Map<
    string,
    {
      token: symbol;
      previous: { value: string | null | undefined; created: boolean };
      revision: number;
    }
  >();
  const archiveState = createSessionArchiveState(host.publishedRow, () =>
    host.publish({ ...host.readState() }),
  );
  const preparedWorkSessionKeys = new Set<string>();
  const pendingCreatedModelOverrides = new Set<string>();

  const setModelOverride = (key: string, value: string | null | undefined, created = false) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }
    // Register before publishing: a synchronous subscriber may claim the same value.
    if (created) {
      pendingCreatedModelOverrides.add(normalizedKey);
    } else {
      pendingCreatedModelOverrides.delete(normalizedKey);
    }
    // Equal-value writes still transfer ownership while a patch is pending.
    const pendingModelPatch = pendingModelPatches.get(normalizedKey);
    if (pendingModelPatch) {
      pendingModelPatch.revision += 1;
    }
    const state = host.readState();
    const modelOverrides = { ...state.modelOverrides };
    if (value === undefined) {
      if (!Object.hasOwn(state.modelOverrides, normalizedKey)) {
        return;
      }
      delete modelOverrides[normalizedKey];
    } else {
      const normalizedValue = value === null ? null : value.trim();
      if (
        modelOverrides[normalizedKey] === normalizedValue &&
        Object.hasOwn(modelOverrides, normalizedKey)
      ) {
        return;
      }
      modelOverrides[normalizedKey] = normalizedValue;
    }
    host.publish({ ...state, modelOverrides });
  };

  const patchRowLocal = (
    key: string,
    patch: Partial<GatewaySessionRow>,
    expectedSessionId?: string,
  ) => {
    const state = host.readState();
    const normalizedKey = key.trim();
    if (!state.result || !normalizedKey) {
      return;
    }
    let changed = false;
    const sessions = state.result.sessions.map((row) => {
      if (
        !areUiSessionKeysEquivalent(row.key, normalizedKey) ||
        (expectedSessionId !== undefined && row.sessionId !== expectedSessionId)
      ) {
        return row;
      }
      changed = true;
      return host.copyRow(row, patch);
    });
    if (changed) {
      host.publish({ ...state, result: { ...state.result, sessions } });
    }
  };

  // The Gateway derives `pinned` from `pinnedAt` and both row comparators order
  // by `pinnedAt` inside each pin group, so an optimistic write has to move the
  // pair or the row lands in a slot the Gateway would never produce.
  const pinRowFields = (pinned: boolean, pinnedAt: number | undefined): SessionPinFields =>
    pinned
      ? { pinned: true, pinnedAt: pinnedAt ?? Date.now() }
      : { pinned: false, pinnedAt: undefined };

  const optimisticPins = createOptimisticRowPatches(host, {
    read: (row): SessionPinFields => ({ pinned: row.pinned === true, pinnedAt: row.pinnedAt }),
    // Once the Gateway agrees on `pinned`, its own timestamp wins again.
    write: (row, next) => ((row.pinned === true) === next.pinned ? row : host.copyRow(row, next)),
    observe: (previous, row, names) => ({
      pinned: names.includes("pinned") ? row.pinned === true : previous.pinned,
      pinnedAt: names.includes("pinnedAt") ? row.pinnedAt : previous.pinnedAt,
    }),
  });
  const optimisticUnread = createOptimisticRowPatches(host, {
    read: (row) => row.unread,
    write: (row, unread) => (row.unread === unread ? row : host.copyRow(row, { unread })),
    observe: (previous, row, names) => (names.includes("unread") ? row.unread : previous),
  });
  const applyPendingRow = (
    row: GatewaySessionRow,
    sourceAgentId?: string | null,
  ): GatewaySessionRow =>
    optimisticUnread.applyRow(optimisticPins.applyRow(row, sourceAgentId), sourceAgentId);

  const retireModelOverride = (key: string) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return;
    }
    pendingModelPatches.delete(normalizedKey);
    setModelOverride(normalizedKey, undefined);
  };

  const reconcileConfirmedPreviousConnection = async (
    scope: SessionConnectionScope,
    agentId?: string | null,
  ): Promise<boolean> => {
    const replacement = host.connection.capture();
    if (!replacement || replacement.client !== scope.client) {
      return false;
    }
    let refreshError: string | undefined;
    try {
      await host.refreshReplacement(agentId);
      refreshError = host.readState().error ?? undefined;
    } catch (error) {
      refreshError = formatUiError(error);
    }
    if (!host.connection.isCurrent(replacement)) {
      return false;
    }
    host.publish(
      {
        ...host.readState(),
        error: refreshError
          ? t("connection.sessionOperationCompletedPreviousConnectionWithRefreshError", {
              error: refreshError,
            })
          : t("connection.sessionOperationCompletedPreviousConnection"),
      },
      "operation",
    );
    return true;
  };

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
        setModelOverride(result.key, requestParams.model, true);
      } else if (preparedWorkSessionKeys.has(result.key)) {
        host.publish({ ...host.readState() });
      }
      const reconciliation = host.refreshReplacement(params.agentId);
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
    const normalizedKey = key.trim();
    const patchSnapshot = host.snapshot();
    const pendingConversation =
      patchParams.pinned !== undefined || patchParams.unread === false
        ? resolvePendingConversation(patchSnapshot, normalizedKey, options.agentId)
        : null;
    const pendingSessionId = pendingConversation
      ? options.expectedSessionId !== undefined
        ? options.expectedSessionId.trim()
        : host
            .findRow(
              (row, sourceAgentId) =>
                pendingRowIdentity(patchSnapshot, row, sourceAgentId) ===
                pendingConversation.identity,
            )
            ?.sessionId?.trim()
      : undefined;
    // Queued intents keep their observed incarnation even if selection changes before dispatch.
    const pendingTarget: PendingRowTarget | null =
      pendingConversation && pendingSessionId
        ? { ...pendingConversation, sessionId: pendingSessionId }
        : null;
    let rowPatchConfirmed = false;
    const archivedPresentationRow =
      patchParams.archived === true ? host.publishedRow(normalizedKey) : undefined;
    let modelPatchStarted = false;
    let modelPatchRevision = 0;
    const modelPatchToken = Symbol("session-model-patch");
    let permissionProjection: SessionPermissionClaim | undefined;
    const ownsModelOverride = () => options.ownsModelOverride?.() !== false;
    const startModelPatch = () => {
      if (!managesModelOverride || modelPatchStarted || !ownsModelOverride()) {
        return;
      }
      const pendingModelPatch = pendingModelPatches.get(normalizedKey);
      modelPatchStarted = true;
      pendingModelPatches.set(normalizedKey, {
        token: modelPatchToken,
        previous: pendingModelPatch?.previous ?? {
          value: host.readState().modelOverrides[normalizedKey],
          created: pendingCreatedModelOverrides.has(normalizedKey),
        },
        revision: 0,
      });
      setModelOverride(key, patchParams.model);
      modelPatchRevision = pendingModelPatches.get(normalizedKey)?.revision ?? 0;
    };
    const nextPinned = patchParams.pinned === true;
    let pinPatchToken: symbol | null = null;
    // Sidebar rows read `pinned` straight off the snapshot, so a pin/unpin has
    // no visible outcome until this flip; the Gateway patch and its list
    // refresh confirm it afterwards.
    const startPinPatch = () => {
      if (patchParams.pinned === undefined || pinPatchToken || !pendingTarget) {
        return;
      }
      pinPatchToken = optimisticPins.start(pendingTarget, (row) =>
        pinRowFields(nextPinned, row.pinnedAt),
      );
    };
    let unreadPatchToken: symbol | null = null;
    const startUnreadPatch = () => {
      // Mark-unread needs the Gateway-issued marker before an active pane can
      // distinguish the explicit reminder from new activity. Reads are safe
      // to project immediately because their observed marker remains attached.
      if (patchParams.unread !== false || unreadPatchToken || !pendingTarget) {
        return;
      }
      unreadPatchToken = optimisticUnread.start(pendingTarget, () => false);
    };
    const startOptimisticPatch = () => {
      startModelPatch();
      startPinPatch();
      startUnreadPatch();
    };
    if (!options.waitFor) {
      startOptimisticPatch();
    }
    const settleModelOverride = (completed: boolean) => {
      const pendingModelPatch = pendingModelPatches.get(normalizedKey);
      if (modelPatchStarted && pendingModelPatch?.token === modelPatchToken) {
        pendingModelPatches.delete(normalizedKey);
        // Success and rollback may settle only this operation's untouched claim.
        if (pendingModelPatch.revision !== modelPatchRevision) {
          return;
        }
        if (host.connection.isCurrent(scope) && ownsModelOverride()) {
          if (completed && !options.deferListRefresh) {
            // The refreshed row already carries the Gateway-confirmed selection.
            // Keeping an overlay would hide subsequent external model changes.
            setModelOverride(key, undefined);
          } else {
            const previous = pendingModelPatch.previous;
            // A failed patch restores a create preview only until its canonical row arrives.
            const created =
              !completed &&
              previous.created &&
              host.publishedRow(normalizedKey)?.modelOverrideSource === undefined;
            setModelOverride(
              key,
              completed
                ? patchParams.model
                : previous.created && !created
                  ? undefined
                  : previous.value,
              created,
            );
          }
        } else {
          // The shared key now belongs to another agent/connection. Remove only
          // this operation's untouched optimistic value; preserve newer claims.
          setModelOverride(key, undefined);
        }
      }
    };
    const settlePinPatch = (completed: boolean) => {
      if (pinPatchToken && pendingTarget) {
        optimisticPins.settle(
          pendingTarget,
          pinPatchToken,
          completed && rowPatchConfirmed,
          host.connection.isCurrent(scope),
        );
      }
    };
    const settleUnreadPatch = (completed: boolean) => {
      if (unreadPatchToken && pendingTarget) {
        optimisticUnread.settle(
          pendingTarget,
          unreadPatchToken,
          completed && rowPatchConfirmed,
          host.connection.isCurrent(scope),
        );
      }
    };
    const settleOptimisticPatch = (completed: boolean) => {
      settleModelOverride(completed);
      settlePinPatch(completed);
      settleUnreadPatch(completed);
    };
    try {
      if (options.waitFor) {
        await options.waitFor;
        if (!host.connection.isCurrent(scope)) {
          settleOptimisticPatch(false);
          return null;
        }
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
      const result = await requestSessionPatch(scope.client, key, patchParams, options);
      if (!host.connection.isCurrent(scope)) {
        settleOptimisticPatch(false);
        return (await reconcileConfirmedPreviousConnection(scope, options.agentId)) ? result : null;
      }
      rowPatchConfirmed =
        pendingTarget !== null &&
        result.entry.sessionId === pendingTarget.sessionId &&
        resolvePendingConversation(patchSnapshot, result.key, pendingTarget.agentId)?.identity ===
          pendingTarget.identity;
      if (pendingTarget && rowPatchConfirmed && confirmFields) {
        const { entry } = result;
        const pin = { pinned: entry.pinnedAt !== undefined, pinnedAt: entry.pinnedAt };
        const read = {
          unread: deriveSessionUnread(entry),
          lastReadAt: entry.lastReadAt,
          markedUnreadAt: entry.markedUnreadAt,
        };
        confirmFields({
          key: pendingTarget.key,
          agentId: pendingTarget.agentId,
          sessionId: pendingTarget.sessionId,
          updatedAt: entry.updatedAt ?? null,
          fields:
            patchParams.pinned === undefined
              ? read
              : patchParams.unread === false
                ? { ...pin, ...read }
                : pin,
        });
      }
      if (Object.hasOwn(patchParams, "thinkingLevel")) {
        host.clearThink(normalizedKey, options.agentId);
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
        if (confirmation === "confirmed") {
          patchRowLocal(
            key,
            {
              permissionMode: result.entry?.permissionMode,
              ...(result.entry?.updatedAt === undefined
                ? {}
                : { updatedAt: result.entry.updatedAt }),
            },
            result.entry?.sessionId,
          );
        }
      }
      if (archivedPresentationRow) {
        const archivedAt = result.entry?.archivedAt ?? Date.now();
        const archivedSessionId = result.entry?.sessionId ?? archivedPresentationRow.sessionId;
        archiveState.observe(normalizedKey, true, {
          ...archivedPresentationRow,
          archivedAt,
          archiveReason: result.entry?.archiveReason,
          sessionId: archivedSessionId,
        });
        const state = host.readState();
        if (state.result) {
          const archivedRow = host.copyRow(archivedPresentationRow, {
            archived: true,
            archivedAt,
            archiveReason: result.entry?.archiveReason,
            updatedAt: result.entry?.updatedAt ?? archivedPresentationRow.updatedAt,
            pinned: false,
            pinnedAt: undefined,
          });
          const existingIndex = state.result.sessions.findIndex((row) => row.key === normalizedKey);
          const sessions = [...state.result.sessions];
          if (existingIndex === -1) {
            sessions.push(archivedRow);
          } else {
            sessions[existingIndex] = archivedRow;
          }
          host.publish({
            ...state,
            result: { ...state.result, count: sessions.length, sessions },
          });
        }
      } else if (patchParams.archived === false) {
        archiveState.clear(normalizedKey);
      }
      // Commit and list reconciliation are separate outcomes. Callers must not
      // turn a failed refresh into an apparent rollback of the committed patch.
      let refreshOutcome: SessionRefreshOutcome = { status: "refreshed" };
      if (!options.deferListRefresh) {
        if (Object.hasOwn(patchParams, "permissionMode")) {
          refreshOutcome = await host.refreshReplacementResult(
            options.agentId,
            permissionProjection?.isCurrent,
          );
        } else {
          await host.refreshReplacement(options.agentId);
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
      settleOptimisticPatch(false);
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      if (ownsModelOverride()) {
        host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
      }
      throw error;
    }
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
    try {
      const result = await scope.client.request<SessionsAssignOwnerResult>("sessions.assignOwner", {
        key,
        owner,
        ...(options.agentId ? { agentId: options.agentId } : {}),
      });
      if (!host.connection.isCurrent(scope)) {
        return null;
      }
      patchRowLocal(result.key, { owner: result.owner });
      return result.owner;
    } catch (error) {
      if (host.connection.isCurrent(scope)) {
        host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
      }
      return null;
    }
  };

  return {
    create,
    createResult,
    reconcileConfirmedPreviousConnection,
    retireDeletedSession(this: void, key: string) {
      host.retirePullRequestSummary(key);
      archiveState.clear(key);
      preparedWorkSessionKeys.delete(key.trim());
      setModelOverride(key, undefined);
    },
    patch,
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
      optimisticPins.observe(row, names, sourceAgentId);
      optimisticUnread.observe(row, names, sourceAgentId);
    },
    applyPendingRows(
      result: SessionsListResult | null,
      sourceAgentId?: string | null,
    ): SessionsListResult | null {
      if (!result || (!optimisticPins.hasPending() && !optimisticUnread.hasPending())) {
        return result;
      }
      let changed = false;
      const sessions = result.sessions.map((row) => {
        const next = applyPendingRow(row, sourceAgentId);
        changed ||= next !== row;
        return next;
      });
      return changed ? { ...result, sessions } : result;
    },
    applyConfirmedArchives: archiveState.apply,
    observeArchiveState: archiveState.observe,
    reset,
    retireModelOverride,
    archiveVisibility: archiveState.visibility,
    setArchivePending: archiveState.setPending,
    isPreparedWorkSession: (key: string) => preparedWorkSessionKeys.has(key.trim()),
    settlePrepared(result: SessionsListResult | null) {
      for (const row of result?.sessions ?? []) {
        if (row.modelOverrideSource !== undefined && pendingCreatedModelOverrides.has(row.key)) {
          setModelOverride(row.key, undefined);
        }
        if (row.worktree || row.execNode) {
          preparedWorkSessionKeys.delete(row.key);
        }
      }
    },
    retireConnection() {
      pendingCreatedModelOverrides.clear();
      pendingModelPatches.clear();
      // Row intents live inside `result`, which the replacement connection
      // rehydrates wholesale; only the model-override side map outlives that
      // replacement, so it is the one that needs an explicit rollback below.
      optimisticPins.clear();
      optimisticUnread.clear();
      archiveState.clearAll();
      preparedWorkSessionKeys.clear();
      const state = host.readState();
      host.publish({ ...state, modelOverrides: {} });
    },
    dispose() {
      pendingCreatedModelOverrides.clear();
      pendingModelPatches.clear();
      optimisticPins.clear();
      optimisticUnread.clear();
      archiveState.clearAll();
      preparedWorkSessionKeys.clear();
    },
  };
}
