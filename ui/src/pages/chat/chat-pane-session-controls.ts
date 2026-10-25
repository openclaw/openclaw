import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import {
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
  type SessionPatch,
} from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { ChatPaneModelControl } from "./chat-pane-model-control.tsx";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import { switchChatModel, switchChatSetting } from "./chat-session.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  readChatModelCatalogState,
  refreshChatModelCatalogOnDemand,
} from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import type { ChatProps } from "./chat-view.tsx";
import { renderChatModelAccountControl } from "./components/chat-model-account-control.ts";
import type { ChatPermissionPickerProps } from "./components/chat-permission-picker.tsx";
import { activeQueuedMessageEdit } from "./queued-message-edit.ts";
import { readChatSessionSnapshot } from "./session-message-cache.ts";

registerModelControlsEnglish();

type SessionActionAccess = ReturnType<typeof readChatSessionActionAccess>;
type SessionAction = keyof SessionActionAccess;
type SessionActionCallbacks = Pick<
  ChatProps,
  "onAbort" | "onCompact" | "onForkMessage" | "onRewindMessage"
>;

type PendingPermissionChange = {
  expectedSessionId?: string;
  nextMode: ChatPermissionPickerProps["mode"];
  ownsSelection: () => boolean;
  retainWhileCurrent?: () => boolean;
};

type PermissionSelection = {
  pending: PendingPermissionChange | undefined;
  outcome: symbol | undefined;
};

const permissionSelections = new WeakMap<ChatPageHost, Map<string, PermissionSelection>>();

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

export function readChatPaneMutationAccess(
  snapshot: ApplicationGatewaySnapshot,
  sessionKey: string,
  session?: GatewaySessionRow,
) {
  const scopedPatchAccess = (patch: SessionPatch) =>
    readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, ...patch },
      sessionScope: true,
      session,
    });
  return {
    model: scopedPatchAccess({ model: null }),
    effort: scopedPatchAccess({ thinkingLevel: null }),
    contextWindow: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, contextWindow: null },
    }),
    permission: scopedPatchAccess({ permissionMode: "guarded" }),
    unarchive: scopedPatchAccess({ archived: false }),
    pendingInputDismiss: readSessionMethodAccess(snapshot, {
      method: "chat.pendingInputs.dismiss",
      requiredScope: "operator.sessions.write",
      session,
    }),
  };
}

export function canDismissChatPendingInputs(
  access: ReturnType<typeof readChatPaneMutationAccess>,
  session: Pick<GatewaySessionRow, "sharingRole"> | undefined,
  options: { nativeConversation: boolean; participationBlocked: boolean },
): boolean {
  return (
    access.pendingInputDismiss.allowed &&
    session?.sharingRole !== "viewer" &&
    options.nativeConversation &&
    !options.participationBlocked
  );
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
  onProviderSettings?: (provider: string) => void;
  onModelAccounts?: () => void;
}): {
  composerControls: Parameters<typeof ChatPaneModelControl>[0] & {
    component: typeof ChatPaneModelControl;
  };
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
    onProviderSettings,
    onModelAccounts,
  } = params;
  const sessionKey = state.sessionKey;
  const client = state.client;
  const accountSelection = state.chatAccountSelection;
  const connectionIsCurrent = captureChatConnectionOwner(state);
  const agentScope = scopedAgentParamsForSession(state, sessionKey);
  const affectedAgentId = scopedAgentListParamsForSession(state, sessionKey).agentId;
  const expectedSessionId = selectedSession?.sessionId?.trim();
  const permissionScopeKey = JSON.stringify([sessionKey, agentScope.agentId]);
  const selections = permissionSelections.get(state) ?? new Map<string, PermissionSelection>();
  permissionSelections.set(state, selections);
  const selection =
    selections.get(permissionScopeKey) ??
    projectChatFields<PermissionSelection>({ pending: undefined, outcome: undefined }, ["pending"]);
  selections.set(permissionScopeKey, selection);
  const ownsRoute = () =>
    connectionIsCurrent() &&
    state.sessionKey === sessionKey &&
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
  const pendingChange = selection.pending;
  const currentChange =
    pendingChange?.expectedSessionId === expectedSessionId &&
    pendingChange?.ownsSelection() &&
    (!pendingChange.retainWhileCurrent || pendingChange.retainWhileCurrent())
      ? pendingChange
      : undefined;
  const permissionPending = Boolean(
    (currentChange && !currentChange.retainWhileCurrent) || selectedSession?.permissionModePending,
  );
  const modelCatalogState = readChatModelCatalogState(state);
  const accessProgramAccess = readSessionMethodAccess(
    { client: state.client, hello: state.hello, phase: state.connected ? "connected" : "offline" },
    {
      method: "sessions.patch",
      params: { key: sessionKey, cyberAccessProgram: null },
      sessionScope: true,
      session: selectedSession,
    },
  );
  const thinkingLevelOverride = state.sessions.think(sessionKey, agentScope.agentId);
  const settingsPreview = state.sessions.settingsPreview(sessionKey, agentScope.agentId);
  const settingsSession =
    thinkingLevelOverride || settingsPreview
      ? {
          ...selectedSession,
          ...(thinkingLevelOverride ? { thinkingLevel: thinkingLevelOverride } : {}),
          ...settingsPreview,
        }
      : selectedSession;
  return {
    composerControls: {
      component: ChatPaneModelControl,
      model: {
        snapshot:
          state.connected && state.chatModelCatalogInitialized && selectedSession
            ? undefined
            : (readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey })
                ?.composer ?? undefined),
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
            ownsSelection: () => ownsSelection() && state.chatAccountSelection === accountSelection,
            onSelect: (account) =>
              modelAccess.allowed && canPatch({ model: `${accountModel}@${account.authProfileId}` })
                ? switchChatModel(state, `${accountModel}@${account.authProfileId}`, sessionKey)
                : Promise.resolve(false),
            onManage: onModelAccounts,
          }),
        activeRunId: state.chatRunId,
        agentDefaultModel,
        connected: state.connected,
        gatewayAvailable: Boolean(state.client),
        loading: state.chatLoading,
        modelCatalog: state.chatModelCatalog,
        modelCatalogState,
        modelOverrides: state.sessions.state.modelOverrides,
        thinkingSession: settingsSession,
        fastModeTarget: settingsSession,
        accessProgramMutationDisabledReason: accessProgramAccess.allowed
          ? undefined
          : accessProgramAccess.reason,
        requestedAccessProgram: settingsSession?.cyberAccessProgram,
        contextWindowTarget: settingsPreview
          ? { ...(selectedSession ?? state.sessionsResult?.defaults), ...settingsPreview }
          : undefined,
        modelSelectionLocked: selectedSession?.modelSelectionLocked === true,
        modelSelectionTarget: state.sessionsResult?.defaults.modelSelectionTarget,
        modelPickerOpen: state.chatModelPickerOpenSessionKey === state.sessionKey,
        modelSwitching: Boolean(state.chatModelSwitchPromises[state.sessionKey]),
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
        get stream() {
          return state.chatStream;
        },
        onModelSetup,
        onProviderSettings,
        onAccessProgramSelect: (next, targetSessionKey) =>
          canPatch({ cyberAccessProgram: next }, targetSessionKey)
            ? switchChatSetting(
                state,
                { kind: "cyberAccessProgram", value: next },
                targetSessionKey,
              )
            : Promise.resolve(false),
        onFastModeSelect: (next, targetSessionKey) =>
          effortAccess.allowed && canPatch({ fastMode: null }, targetSessionKey)
            ? switchChatSetting(state, { kind: "fastMode", value: next }, targetSessionKey)
            : Promise.resolve(false),
        onContextWindowSelect: (next, targetSessionKey) =>
          contextWindowAccess.allowed && canPatch({ contextWindow: next }, targetSessionKey)
            ? switchChatSetting(state, { kind: "contextWindow", value: next }, targetSessionKey)
            : Promise.resolve(false),
        onModelPickerOpen: () => refreshChatModelCatalogOnDemand(state),
        onModelPickerOpenChange: (open) => {
          state.chatModelPickerOpenSessionKey = open ? state.sessionKey : null;
          // The native picker already presents this transition.
        },
        onModelSelect: (next, targetSessionKey, agentRuntime) =>
          modelAccess.allowed && canPatch({ model: next, agentRuntime }, targetSessionKey)
            ? switchChatModel(state, next, targetSessionKey, agentRuntime, agentDefaultModel)
            : Promise.resolve(false),
        onThinkingSelect: (next, targetSessionKey) =>
          effortAccess.allowed && canPatch({ thinkingLevel: next }, targetSessionKey)
            ? switchChatSetting(state, { kind: "thinkingLevel", value: next }, targetSessionKey)
            : Promise.resolve(false),
      },
    },
    permissionPicker: {
      canSelectFull,
      defaultMode: agentDefaultPermissionMode,
      disabled: !permissionAccess.allowed,
      disabledReason: permissionAccess.allowed ? undefined : permissionAccess.reason,
      mode: currentChange ? currentChange.nextMode : selectedSession?.permissionMode,
      pending: permissionPending,
      onSelect: async (permissionMode) => {
        const activeChange = selection.pending;
        if (
          !permissionAccess.allowed ||
          !canPatch({ permissionMode }) ||
          selectedSession?.permissionModePending ||
          (activeChange && !activeChange.retainWhileCurrent && activeChange.ownsSelection())
        ) {
          return;
        }
        // Keep the selected mode visible while the exact runtime update settles.
        // The pending owner rejects duplicates; the shared settings tail serializes later work.
        let change: PendingPermissionChange = {
          expectedSessionId,
          nextMode: permissionMode ?? undefined,
          ownsSelection,
        };
        const outcomeOwner = Symbol(permissionScopeKey);
        selection.outcome = outcomeOwner;
        const ownsOutcome = () => selection.outcome === outcomeOwner;
        selection.pending = change;
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
            change = { ...change, retainWhileCurrent };
            selection.pending = change;
          }
          state.chatError = state.lastError = t("chat.permissionControls.updateFailed", {
            error: String(error),
          });
        } finally {
          if (ownsOutcome()) {
            selection.outcome = undefined;
          }
          if (selection.pending === change && change.retainWhileCurrent === undefined) {
            selection.pending = undefined;
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
  const ownsActionTarget = () => {
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
            if (ownsActionTarget() && requireCurrent("abort")) {
              params.onAbort();
            }
          },
    onCompact:
      !params.sessionParticipationBlocked &&
      !parseCatalogSessionKey(sessionKey) &&
      access.compact.allowed
        ? async () => {
            if (ownsActionTarget() && requireCurrent("compact")) {
              await state.handleSendChat("/compact");
            }
          }
        : undefined,
    onRewindMessage: access.rewind.allowed
      ? (entryId) => (requireCurrent("rewind") ? params.onRewind(entryId) : false)
      : undefined,
    onForkMessage: access.fork.allowed
      ? (entryId) => (requireCurrent("fork") ? params.onFork(entryId) : undefined)
      : undefined,
  };
}
