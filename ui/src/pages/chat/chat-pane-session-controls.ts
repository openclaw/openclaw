import { html } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { hasOperatorReadAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import { resolveModelCatalogState } from "../../lib/model-catalog-store.ts";
import {
  readSessionMethodAccess,
  readSessionMethodScopeAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import {
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
  type SessionPatch,
} from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import {
  switchChatContextWindow,
  switchChatFastMode,
  switchChatModel,
  switchChatThinkingLevel,
} from "./chat-session.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { refreshChatModelCatalogOnDemand } from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import type { ChatProps } from "./chat-view.ts";
import { renderChatModelAccountControl } from "./components/chat-model-account-control.ts";
import { renderChatModelControls } from "./components/chat-model-controls.ts";
import type { ChatPermissionPickerProps } from "./components/chat-permission-picker.ts";
import { getChatModelObservedRunId, getChatRunOwnerSessionKey } from "./history-merge.ts";
import { activeQueuedMessageEdit } from "./queued-message-edit.ts";

registerModelControlsEnglish();

type SessionActionAccess = ReturnType<typeof readChatSessionActionAccess>;
type SessionAction = keyof SessionActionAccess;
type SessionActionCallbacks = Pick<
  ChatProps,
  "onAbort" | "onClearHistory" | "onForkMessage" | "onRewindMessage"
>;

type PendingPermissionChange = {
  expectedSessionId?: string;
  nextMode: ChatPermissionPickerProps["mode"];
  ownsSelection: () => boolean;
  pending: boolean;
  retainWhileCurrent?: () => boolean;
};

const pendingPermissionChanges = new WeakMap<ChatPageHost, Map<string, PendingPermissionChange>>();
const permissionOutcomeOwners = new WeakMap<ChatPageHost, Map<string, symbol>>();

export function createChatPaneQueuedEditProps(
  state: ChatPageHost,
  sessionParticipationBlocked: boolean,
): NonNullable<ChatProps["queuedEdit"]> {
  const edit = activeQueuedMessageEdit(state);
  return {
    editingId: edit?.id ?? null,
    editingText: edit?.draftText,
    editingMentions: edit?.mentions,
    source: edit?.source,
    onEdit: sessionParticipationBlocked ? undefined : state.editQueuedChatMessage,
    onEditChange: sessionParticipationBlocked ? undefined : state.updateQueuedChatMessageEdit,
    onEditSubmit: sessionParticipationBlocked ? undefined : state.submitQueuedChatMessageEdit,
    onCancel: state.cancelQueuedChatMessageEdit,
  };
}

export function readChatPaneComposerAccess(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello">,
  session: GatewaySessionRow | undefined,
  catalog: boolean,
) {
  const auth = snapshot.hello?.auth ?? null;
  const canSend =
    hasOperatorWriteAccess(auth) ||
    (!catalog &&
      readSessionMethodScopeAccess(auth, {
        method: "chat.send",
        requiredScope: "operator.write",
        sessionScope: true,
        session,
      }).allowed);
  return { canCompose: hasOperatorReadAccess(auth) || canSend, canSend };
}

export function readChatPaneMutationAccess(
  snapshot: ApplicationGatewaySnapshot,
  sessionKey: string,
  session?: GatewaySessionRow,
) {
  return {
    model: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, model: null },
      sessionScope: true,
      session,
    }),
    effort: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, thinkingLevel: null },
      sessionScope: true,
      session,
    }),
    contextWindow: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, contextWindow: null },
    }),
    permission: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, permissionMode: "guarded" },
      sessionScope: true,
      session,
    }),
    unarchive: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, archived: false },
      sessionScope: true,
      session,
    }),
  };
}

export function renderChatPaneComposerControls(params: {
  state: ChatPageHost;
  selectedSession: GatewaySessionRow | undefined;
  agentDefaultModel: string | undefined;
  agentDefaultPermissionMode?: ChatPermissionPickerProps["defaultMode"];
  modelAccess: SessionMethodAccess;
  effortAccess: SessionMethodAccess;
  contextWindowAccess: SessionMethodAccess;
  permissionAccess: SessionMethodAccess;
  canSelectFull: boolean;
  onModelSetup: () => void;
  onModelAccounts?: () => void;
}): {
  composerControls: NonNullable<ChatProps["composerControls"]>;
  permissionPicker: ChatPermissionPickerProps;
} {
  const {
    state,
    selectedSession,
    agentDefaultModel,
    agentDefaultPermissionMode,
    modelAccess,
    effortAccess,
    contextWindowAccess,
    permissionAccess,
    canSelectFull,
    onModelSetup,
    onModelAccounts,
  } = params;
  const sessionKey = state.sessionKey;
  const client = state.client;
  const accountSelection = state.chatAccountSelection;
  const connectionEpoch = state.connectionEpoch;
  const agentScope = scopedAgentParamsForSession(state, sessionKey);
  const affectedAgentId = scopedAgentListParamsForSession(state, sessionKey).agentId;
  const expectedSessionId = selectedSession?.sessionId?.trim();
  const permissionScopeKey = JSON.stringify([sessionKey, agentScope.agentId]);
  const permissionChanges =
    pendingPermissionChanges.get(state) ?? new Map<string, PendingPermissionChange>();
  pendingPermissionChanges.set(state, permissionChanges);
  const ownsRoute = () =>
    state.connected &&
    state.sessionKey === sessionKey &&
    state.client === client &&
    state.connectionEpoch === connectionEpoch &&
    scopedAgentParamsForSession(state, sessionKey).agentId === agentScope.agentId;
  const ownsSelection = () => {
    const currentSession = selectedChatSessionRow(state);
    return (
      ownsRoute() &&
      Boolean(currentSession) === Boolean(selectedSession) &&
      currentSession?.sessionId === expectedSessionId
    );
  };
  const canPatch = (patch: SessionPatch, targetSessionKey = sessionKey) =>
    areUiSessionKeysEquivalent(targetSessionKey, sessionKey) &&
    ownsSelection() &&
    readSessionMethodAccess(
      {
        client: state.client,
        hello: state.hello,
        phase: state.connected ? "connected" : "offline",
      },
      {
        method: "sessions.patch",
        params: { key: sessionKey, ...patch },
        sessionScope: true,
        session: selectedChatSessionRow(state),
      },
    ).allowed;
  let pendingChange = permissionChanges.get(permissionScopeKey);
  if (pendingChange && pendingChange.expectedSessionId !== expectedSessionId) {
    permissionChanges.delete(permissionScopeKey);
    pendingChange = undefined;
  }
  if (pendingChange?.retainWhileCurrent && !pendingChange.retainWhileCurrent()) {
    permissionChanges.delete(permissionScopeKey);
    pendingChange = undefined;
  }
  const currentChange = pendingChange?.ownsSelection() ? pendingChange : undefined;
  const permissionPending = Boolean(
    currentChange?.pending || selectedSession?.permissionModePending,
  );
  const modelCatalogState = resolveModelCatalogState(
    {
      models: state.chatModelCatalog,
      refreshFailed: state.chatModelCatalogRefreshFailed,
      pendingProviders: state.chatModelCatalogPendingProviders,
      modelSelectionPolicy: state.chatModelSelectionPolicy,
    },
    {
      connected: state.connected,
      loading: state.chatModelsLoading,
      error: state.chatModelCatalogError,
      retired: state.chatModelCatalogRetired,
      initialized: state.chatModelCatalogInitialized,
    },
  );
  const thinkingLevelOverride = state.sessions.think(sessionKey, agentScope.agentId);
  const thinkingSession = thinkingLevelOverride
    ? { ...selectedSession, thinkingLevel: thinkingLevelOverride }
    : selectedSession;
  return {
    composerControls: html`
      <div class="chat-composer-model-control">
        ${renderChatModelControls({
          modelAuthStatusResult: state.modelAuthStatusResult,
          accountSelection,
          renderAccountSection: (accountModel) =>
            renderChatModelAccountControl({
              owner: state,
              client,
              selection: accountSelection,
              modelAuthStatusResult: state.modelAuthStatusResult,
              model: accountModel,
              disabled:
                !modelAccess.allowed ||
                !state.connected ||
                !accountModel ||
                selectedSession?.modelSelectionLocked === true ||
                state.chatLoading ||
                state.chatSending ||
                Boolean(state.chatRunId) ||
                state.chatStream !== null ||
                Boolean(state.chatModelSwitchPromises[sessionKey]),
              ownsSelection: () =>
                ownsSelection() && state.chatAccountSelection === accountSelection,
              onSelect: (account) =>
                modelAccess.allowed &&
                canPatch({ model: `${accountModel}@${account.authProfileId}` })
                  ? switchChatModel(state, `${accountModel}@${account.authProfileId}`, sessionKey)
                  : Promise.resolve(false),
              onManage: onModelAccounts,
              onRequestUpdate: () => state.requestUpdate?.(),
            }),
          activeRunId: state.chatRunId,
          activeRunSessionKey: getChatRunOwnerSessionKey(state),
          modelObservedRunId: getChatModelObservedRunId(state, selectedSession),
          agentDefaultModel,
          connected: state.connected,
          gatewayAvailable: Boolean(state.client),
          loading: state.chatLoading,
          modelCatalog: state.chatModelCatalog,
          modelCatalogState,
          modelOverrides: state.sessions.state.modelOverrides,
          thinkingSession,
          modelSelectionLocked: selectedSession?.modelSelectionLocked === true,
          modelSelectionTarget: state.sessionsResult?.defaults.modelSelectionTarget,
          modelPickerOpen: state.chatModelPickerOpenSessionKey === state.sessionKey,
          modelSwitching: Boolean(state.chatModelSwitchPromises[state.sessionKey]),
          modelsLoading: state.chatModelsLoading,
          modelMutationDisabledReason: modelAccess.allowed ? undefined : modelAccess.reason,
          effortMutationDisabledReason: effortAccess.allowed ? undefined : effortAccess.reason,
          contextWindowMutationDisabledReason: contextWindowAccess.allowed
            ? undefined
            : contextWindowAccess.reason,
          sending:
            state.chatSending &&
            state.chatSendingScopeKey ===
              storedChatOutboxScopeKey({
                sessionKey,
                ...(agentScope.agentId ? { agentId: agentScope.agentId } : {}),
              }),
          sessionKey: state.sessionKey,
          selectedSession,
          sessionsResult: state.sessionsResult,
          stream: state.chatStream,
          onRequestUpdate: () => state.requestUpdate?.(),
          onModelSetup,
          onFastModeSelect: (next, targetSessionKey) =>
            effortAccess.allowed && canPatch({ fastMode: null }, targetSessionKey)
              ? switchChatFastMode(state, next, targetSessionKey)
              : Promise.resolve(false),
          onContextWindowSelect: (next, targetSessionKey) =>
            contextWindowAccess.allowed && canPatch({ contextWindow: next }, targetSessionKey)
              ? switchChatContextWindow(state, next, targetSessionKey)
              : Promise.resolve(false),
          onModelPickerOpen: () => refreshChatModelCatalogOnDemand(state),
          onModelPickerOpenChange: (open) => {
            state.chatModelPickerOpenSessionKey = open ? state.sessionKey : null;
            // Closing also needs a render; catalog refresh only invalidates on open.
            state.requestUpdate?.();
          },
          onModelSelect: (next, targetSessionKey, agentRuntime) =>
            modelAccess.allowed && canPatch({ model: next, agentRuntime }, targetSessionKey)
              ? switchChatModel(state, next, targetSessionKey, agentRuntime)
              : Promise.resolve(false),
          onThinkingSelect: (next, targetSessionKey) =>
            effortAccess.allowed && canPatch({ thinkingLevel: next }, targetSessionKey)
              ? switchChatThinkingLevel(state, next, targetSessionKey)
              : Promise.resolve(false),
        })}
      </div>
    `,
    permissionPicker: {
      canSelectFull,
      defaultMode: agentDefaultPermissionMode,
      disabled: !permissionAccess.allowed,
      disabledReason: permissionAccess.allowed ? undefined : permissionAccess.reason,
      mode: currentChange ? currentChange.nextMode : selectedSession?.permissionMode,
      pending: permissionPending,
      onSelect: async (permissionMode) => {
        const activeChange = permissionChanges.get(permissionScopeKey);
        if (
          !permissionAccess.allowed ||
          !canPatch({ permissionMode }) ||
          selectedSession?.permissionModePending ||
          (activeChange?.pending && activeChange.ownsSelection())
        ) {
          return;
        }
        // Keep the selected mode visible while the exact runtime update settles.
        // The pending owner rejects duplicates; the shared settings tail serializes later work.
        const change: PendingPermissionChange = {
          expectedSessionId,
          nextMode: permissionMode ?? undefined,
          ownsSelection,
          pending: true,
        };
        const outcomeOwner = Symbol(permissionScopeKey);
        const outcomeOwners = permissionOutcomeOwners.get(state) ?? new Map<string, symbol>();
        permissionOutcomeOwners.set(state, outcomeOwners);
        outcomeOwners.set(permissionScopeKey, outcomeOwner);
        const ownsOutcome = () => outcomeOwners.get(permissionScopeKey) === outcomeOwner;
        permissionChanges.set(permissionScopeKey, change);
        state.requestUpdate?.();
        try {
          state.chatError = state.lastError = null;
          const patched = await patchChatSessionSettings(
            state,
            sessionKey,
            { permissionMode },
            { ...agentScope, expectedSessionId, canDispatch: () => canPatch({ permissionMode }) },
          );
          if (!ownsSelection()) {
            return;
          }
          if (!patched) {
            throw new Error("Session capability is unavailable");
          }
          if (patched.listRefreshError && ownsOutcome()) {
            state.chatError = state.lastError = t("chat.permissionControls.refreshFailed", {
              error: patched.listRefreshError,
            });
          }
        } catch (error) {
          if (!ownsRoute() || !ownsOutcome()) {
            return;
          }
          const retainWhileCurrent = state.sessions.capturePermissionObservation(
            sessionKey,
            affectedAgentId,
          );
          const outcome = await state.sessions.reconcileMutation(affectedAgentId);
          if (!ownsSelection() || !ownsOutcome()) {
            return;
          }
          if (outcome.status !== "refreshed") {
            change.pending = false;
            change.retainWhileCurrent = retainWhileCurrent;
          }
          state.chatError = state.lastError = t("chat.permissionControls.updateFailed", {
            error: String(error),
          });
        } finally {
          if (ownsOutcome()) {
            outcomeOwners.delete(permissionScopeKey);
          }
          if (
            permissionChanges.get(permissionScopeKey) === change &&
            change.retainWhileCurrent === undefined
          ) {
            permissionChanges.delete(permissionScopeKey);
          }
          if (ownsRoute()) {
            state.requestUpdate?.();
          }
        }
      },
    },
  };
}

export function createChatPaneSessionActionCallbacks(params: {
  getSnapshot: () => ApplicationGatewaySnapshot;
  state: ChatPageHost;
  sessionParticipationBlocked: boolean;
  onDenied: (reason: string) => void;
  onAbort: () => void;
  onRewind: (entryId: string) => Promise<boolean>;
  onFork: (entryId: string) => Promise<void>;
  onReset: () => void;
}): SessionActionCallbacks {
  const { state } = params;
  const client = state.client;
  const recoveryScope = params.getSnapshot().hello?.auth?.recoveryScope ?? client?.recoveryScope;
  const sessionKey = state.sessionKey;
  const selectedSession = selectedChatSessionRow(state);
  const sessionId = selectedSession?.sessionId;
  const agentId = scopedAgentParamsForSession(state, sessionKey).agentId;
  const runId = state.chatRunId ?? null;
  const activeRunIds = runId ? undefined : selectedSession?.activeRunIds?.slice();
  const sessionAbortable = state.chatRunSessionAbortable === true;
  const ownsAbortTarget = () => {
    const currentSession = selectedChatSessionRow(state);
    const snapshot = params.getSnapshot();
    const currentRecoveryScope =
      snapshot.hello?.auth?.recoveryScope ??
      (snapshot.phase !== "connected" || client?.recoveryScopeReady
        ? client?.recoveryScope
        : undefined);
    return (
      state.client === client &&
      snapshot.client === client &&
      recoveryScope === currentRecoveryScope &&
      state.sessionKey === sessionKey &&
      scopedAgentParamsForSession(state, sessionKey).agentId === agentId &&
      (state.chatRunId ?? null) === runId &&
      (state.chatRunSessionAbortable === true) === sessionAbortable &&
      (!sessionId || !currentSession?.sessionId || currentSession.sessionId === sessionId) &&
      (!activeRunIds ||
        (currentSession?.activeRunIds?.length === activeRunIds.length &&
          activeRunIds.every((id) => currentSession?.activeRunIds?.includes(id))))
    );
  };
  const readAccess = () => {
    const snapshot = params.getSnapshot();
    const hasLocalRun = Boolean(state.chatRunId);
    const access = readChatSessionActionAccess(snapshot, hasLocalRun, {
      session: selectedChatSessionRow(state),
      sessionAbortable: state.chatRunSessionAbortable === true,
    });
    // Offline Stop captures intent only. The pane retires runs on client
    // replacement; replay checks the original client and current write access.
    if (
      snapshot.client &&
      hasLocalRun &&
      recoveryScope &&
      !access.abort.allowed &&
      access.abort.cause === "disconnected"
    ) {
      access.abort = { allowed: true, requiredScope: "operator.write" };
    }
    return access;
  };
  const access = readAccess();
  const requireCurrent = (action: SessionAction): boolean => {
    const current = readAccess()[action];
    if (current.allowed) {
      return true;
    }
    params.onDenied(current.reason);
    return false;
  };
  return {
    onAbort:
      params.sessionParticipationBlocked || !access.abort.allowed
        ? undefined
        : () => {
            if (ownsAbortTarget() && requireCurrent("abort")) {
              params.onAbort();
            }
          },
    onRewindMessage: access.rewind.allowed
      ? (entryId) => (requireCurrent("rewind") ? params.onRewind(entryId) : false)
      : undefined,
    onForkMessage: access.fork.allowed
      ? (entryId) => (requireCurrent("fork") ? params.onFork(entryId) : undefined)
      : undefined,
    onClearHistory: access.reset.allowed
      ? () => {
          if (requireCurrent("reset")) {
            params.onReset();
          }
        }
      : undefined,
  };
}
