import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import { normalizeThinkLevel } from "../../../../src/auto-reply/thinking.shared.js";
import type {
  CyberAccessProgram,
  GatewaySessionRow,
  ModelCatalogResult,
  SessionsListResult,
} from "../../api/types.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import {
  buildCatalogDisplayLookup,
  buildQualifiedChatModelValue,
  formatCatalogChatModelDisplayFromLookup,
} from "../../lib/chat/model-ref.ts";
import {
  normalizeChatFastModeInput,
  resolveChatModelOverrideValue,
  resolveChatModelSelectValues,
} from "../../lib/chat/model-select-state.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  isSessionRuntimePinned,
  resolveModelRuntimeEntry,
} from "../../lib/model-runtime-choice.ts";
import { readSessionMethodScopeAccess } from "../../lib/session-method-access.ts";
import type {
  SessionCapability,
  SessionArchivedFilter,
  SessionListOptions,
  SessionRefreshTarget,
  SessionScopeHost,
} from "../../lib/sessions/index.ts";
import {
  scopedAgentParamsForSession,
  scopedAgentListParamsForRefreshTarget,
  scopedAgentListParamsForSession,
} from "../../lib/sessions/navigation.ts";
import type { SessionPatch, SessionPatchResult } from "../../lib/sessions/patch.ts";
import {
  areUiSessionKeysEquivalent,
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedGlobalAgentId,
  uiSessionRowMatchesSelectedChat,
} from "../../lib/sessions/session-key.ts";
import { DEFAULT_SESSION_LIST_QUERY } from "../../lib/sessions/session-requests.ts";
import { setChatError } from "./chat-history-state.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";

registerModelControlsEnglish();

type ChatSessionListHost = {
  sessionsArchivedFilter?: SessionArchivedFilter;
};

type ChatSessionRefreshHost = ChatSessionListHost &
  SessionScopeHost & {
    sessionKey: string;
    sessions: Pick<SessionCapability, "refresh">;
  };

export type ChatModelSettingsHost = ChatSessionRefreshHost & {
  client: unknown;
  connected: boolean;
  connectionEpoch?: number;
  lastError?: string | null;
  chatError?: string | null;
  chatModelCatalog: Parameters<typeof resolveChatModelOverrideValue>[0]["chatModelCatalog"];
  chatModelSwitchPromises?: Record<string, Promise<boolean>>;
  chatMessages?: unknown[];
  chatModelSelectionPolicy?: ModelCatalogResult["modelSelectionPolicy"];
  sessions: SessionCapability;
  sessionsResult?: SessionsListResult | null;
  sessionsResultAgentId?: string | null;
};

const modelSelectionOwners = new WeakMap<object, AbortController>();

export function cancelChatModelRecovery(host: object): void {
  modelSelectionOwners.get(host)?.abort();
  modelSelectionOwners.delete(host);
}

export function retireChatModelSelectionOwnership(
  host: Pick<
    ChatModelSettingsHost,
    "agentsList" | "chatModelSwitchPromises" | "hello" | "sessionKey" | "sessions"
  >,
): void {
  cancelChatModelRecovery(host);
  const pendingKeys = Object.keys(host.chatModelSwitchPromises ?? {});
  const ownedKeys = new Set([host.sessionKey, ...pendingKeys]);
  if (isUiSelectedGlobalSessionKey(host, host.sessionKey)) {
    ownedKeys.add("global");
  }
  const hasPendingSwitch = pendingKeys.length > 0;
  const modelOverrides = host.sessions.state?.modelOverrides ?? {};
  const hasModelOverride = [...ownedKeys].some((key) => Object.hasOwn(modelOverrides, key));
  if (!hasPendingSwitch && !hasModelOverride) {
    return;
  }
  host.chatModelSwitchPromises = {};
  for (const key of ownedKeys) {
    host.sessions.retireModelOverride(key);
  }
}

function buildChatSessionListOptions(state: ChatSessionListHost): SessionListOptions {
  return {
    ...DEFAULT_SESSION_LIST_QUERY,
    includeGlobal: true,
    includeUnknown: true,
    configuredAgentsOnly: true,
    includeDerivedTitles: true,
    archivedFilter: state.sessionsArchivedFilter ?? "active",
  };
}

export function refreshCurrentChatSessionList(host: ChatSessionRefreshHost): Promise<void> {
  return host.sessions.refresh({
    ...buildChatSessionListOptions(host),
    ...scopedAgentListParamsForSession(host, host.sessionKey),
    force: true,
  });
}

export function refreshChatSessionListForTarget(
  host: ChatSessionListHost &
    SessionScopeHost & {
      sessions: Pick<SessionCapability, "refresh">;
    },
  target: SessionRefreshTarget,
): Promise<void> {
  return host.sessions.refresh({
    ...buildChatSessionListOptions(host),
    ...scopedAgentListParamsForRefreshTarget(host, target),
    force: true,
  });
}

export function readChatSettingsTargetRow(host: ChatModelSettingsHost, sessionKey: string) {
  return host.sessionsResult?.sessions.find((row) =>
    uiSessionRowMatchesSelectedChat(
      host,
      row.key,
      sessionKey,
      row.agentId ?? host.sessionsResultAgentId,
    ),
  );
}

function captureChatSettingsTarget(host: ChatModelSettingsHost, sessionKey: string) {
  const activeRow = readChatSettingsTargetRow(host, sessionKey);
  const sessions = host.sessions;
  const scope = sessions.captureConnectionScope();
  const client = host.client;
  const agentId = scopedAgentListParamsForSession(host, sessionKey).agentId;
  const sessionId = activeRow?.sessionId;
  const rowAgentId = agentId ?? activeRow?.agentId ?? host.sessionsResultAgentId;
  const matchesOwner = (row: GatewaySessionRow) =>
    uiSessionRowMatchesSelectedChat(host, row.key, sessionKey, row.agentId ?? rowAgentId);
  const isRouteCurrent = () =>
    Boolean(
      scope &&
      host.connected &&
      host.client === client &&
      host.sessions === sessions &&
      sessions.isConnectionScopeCurrent(scope) &&
      areUiSessionKeysEquivalent(host.sessionKey, sessionKey) &&
      scopedAgentListParamsForSession(host, sessionKey).agentId === agentId,
    );
  const isCurrent = () =>
    isRouteCurrent() &&
    (activeRow
      ? host.sessionsResult?.sessions.some(
          (row) => matchesOwner(row) && row.sessionId === sessionId,
        ) === true
      : !host.sessionsResult?.sessions.some(
          (row) => matchesOwner(row) && row.sessionId !== undefined,
        ));
  return {
    sessionId,
    settings: { ...activeRow, ...sessions.settingsPreview(sessionKey, agentId) },
    agentParams: scopedAgentParamsForSession(host, sessionKey),
    isCurrent,
    row: (receipt?: SessionPatchResult | null) => {
      if (
        receipt
          ? !isRouteCurrent() ||
            !uiSessionRowMatchesSelectedChat(host, receipt.key, sessionKey, rowAgentId)
          : !isCurrent()
      ) {
        return undefined;
      }
      // A matching ACK can identify an initially unbound row; dispatch keeps its original target.
      return host.sessionsResult?.sessions.find(
        (row) => matchesOwner(row) && row.sessionId === (sessionId ?? receipt?.entry.sessionId),
      );
    },
  };
}

async function applyChatSetting(
  host: ChatModelSettingsHost,
  sessionKey: string,
  captured: ReturnType<typeof captureChatSettingsTarget>,
  patch: Pick<SessionPatch, "thinkingLevel" | "fastMode" | "contextWindow" | "cyberAccessProgram">,
  settingName: "thinking level" | "speed" | "context window" | "access program",
): Promise<boolean> {
  const canDispatch = (receipt?: SessionPatchResult | null) =>
    (captured.isCurrent() || Boolean(captured.row(receipt))) &&
    readSessionMethodScopeAccess(host.hello?.auth, {
      method: "sessions.patch",
      params: { key: sessionKey, ...patch },
      sessionScope: true,
      session: captured.row(receipt),
    }).allowed;
  setChatError(host, null);
  try {
    if (!canDispatch()) {
      return false;
    }
    const receipt = await patchChatSessionSettings(host, sessionKey, patch, {
      ...captured.agentParams,
      expectedSessionId: captured.sessionId,
      canDispatch,
      onRejected: (error, acknowledgement) => {
        if (captured.isCurrent() || captured.row(acknowledgement)) {
          setChatError(host, `Failed to set ${settingName}: ${formatUiError(error)}`);
        }
      },
    });
    return receipt !== null;
  } catch {
    return false;
  }
}

export function switchChatSetting(
  host: ChatModelSettingsHost,
  selection:
    | { kind: "cyberAccessProgram"; value: CyberAccessProgram | null }
    | { kind: "fastMode"; value: "" | "on" | "off" | "auto" | "ultrafast" }
    | { kind: "thinkingLevel" | "contextWindow"; value: string },
  targetSessionKey = host.sessionKey,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return Promise.resolve(false);
  }
  const captured = captureChatSettingsTarget(host, targetSessionKey);
  if (selection.kind === "cyberAccessProgram") {
    if ((captured.settings.cyberAccessProgram ?? null) === selection.value) {
      return Promise.resolve(true);
    }
    return applyChatSetting(
      host,
      targetSessionKey,
      captured,
      { cyberAccessProgram: selection.value },
      "access program",
    );
  }
  if (selection.kind === "fastMode") {
    const next = normalizeChatFastModeInput(selection.value);
    if (captured.settings.fastMode === next) {
      return Promise.resolve(true);
    }
    return applyChatSetting(host, targetSessionKey, captured, { fastMode: next ?? null }, "speed");
  }
  if (selection.kind === "contextWindow") {
    const next = selection.value.trim() || undefined;
    if ((captured.settings.contextWindow ?? "") === (next ?? "")) {
      return Promise.resolve(true);
    }
    return applyChatSetting(
      host,
      targetSessionKey,
      captured,
      { contextWindow: next ?? null },
      "context window",
    );
  }
  const previousThinkingLevel = captured.settings.thinkingLevel;
  const normalizedNext =
    (normalizeThinkLevel(selection.value) ?? selection.value.trim()) || undefined;
  const normalizedPrev =
    typeof previousThinkingLevel === "string" && previousThinkingLevel.trim()
      ? (normalizeThinkLevel(previousThinkingLevel) ?? previousThinkingLevel.trim())
      : undefined;
  if ((normalizedPrev ?? "") === (normalizedNext ?? "")) {
    return Promise.resolve(true);
  }
  return applyChatSetting(
    host,
    targetSessionKey,
    captured,
    { thinkingLevel: normalizedNext ?? null },
    "thinking level",
  );
}

export type ChatModelSelection = ReturnType<typeof claimChatModelSelection>;

export function claimChatModelSelection(host: ChatModelSettingsHost, targetSessionKey: string) {
  modelSelectionOwners.get(host)?.abort();
  const owner = new AbortController();
  modelSelectionOwners.set(host, owner);
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  const sessions = host.sessions;
  const selectedSessionKey = host.sessionKey;
  const agentScope = scopedAgentParamsForSession(host, targetSessionKey);
  const activeRow = readChatSettingsTargetRow(host, targetSessionKey);
  let expectedSessionId = activeRow?.sessionId;
  const ownsSelection = (sessionId = expectedSessionId) =>
    !owner.signal.aborted &&
    modelSelectionOwners.get(host) === owner &&
    host.connected &&
    host.client === client &&
    host.connectionEpoch === connectionEpoch &&
    host.sessions === sessions &&
    host.sessionKey === selectedSessionKey &&
    scopedAgentParamsForSession(host, targetSessionKey).agentId === agentScope.agentId &&
    readChatSettingsTargetRow(host, targetSessionKey)?.sessionId === sessionId;
  return {
    owner,
    ownsSelection,
    agentScope,
    get expectedSessionId() {
      return expectedSessionId;
    },
    activeRow,
    adoptCreatedSession(sessionId: string) {
      if (expectedSessionId !== undefined || !ownsSelection(sessionId)) {
        return false;
      }
      expectedSessionId = sessionId;
      return true;
    },
  };
}

export async function switchChatModel(
  host: ChatModelSettingsHost,
  nextModel: string,
  targetSessionKey = host.sessionKey,
  agentRuntime?: string | null,
  agentDefaultModel?: string,
): Promise<boolean> {
  if (!host.client || !host.connected) {
    return false;
  }
  const activeRow = readChatSettingsTargetRow(host, targetSessionKey);
  if (activeRow?.modelSelectionLocked === true) {
    return false;
  }
  // A newer intent retires even a confirmation for a previous selection.
  const selection = claimChatModelSelection(host, targetSessionKey);
  const { ownsSelection, agentScope } = selection;
  const { currentOverride, defaultModel } = resolveChatModelSelectValues({
    activeSession: activeRow,
    agentDefaultModel,
    modelSelectionPolicy: host.chatModelSelectionPolicy,
    chatModelCatalog: host.chatModelCatalog,
    modelOverrides: host.sessions.state.modelOverrides,
    sessionKey: targetSessionKey,
    sessionsResult: host.sessionsResult ?? null,
  });
  const runtimeSelection =
    activeRow?.runtimeSelectionLocked && agentRuntime === null ? undefined : agentRuntime;
  const runtimeUnchanged =
    runtimeSelection === undefined ||
    (!activeRow?.runtimeSelectionLocked &&
      (runtimeSelection === null
        ? !isSessionRuntimePinned(activeRow?.agentRuntime)
        : isSessionRuntimePinned(activeRow?.agentRuntime) &&
          activeRow?.agentRuntime?.id === runtimeSelection));
  if (currentOverride === nextModel && runtimeUnchanged) {
    return true;
  }
  const modelOwnerAgentId = scopedAgentParamsForSession(host, targetSessionKey).agentId;
  const ownsModelOverride = () =>
    !isUiSelectedGlobalSessionKey(host, targetSessionKey) ||
    resolveUiSelectedGlobalAgentId(host) === modelOwnerAgentId;
  const patch: SessionPatch = {
    model: nextModel || null,
    ...(runtimeSelection !== undefined ? { agentRuntime: runtimeSelection } : {}),
  };
  const canDispatch = () =>
    ownsSelection() &&
    readSessionMethodScopeAccess(host.hello?.auth, {
      method: "sessions.patch",
      params: { key: targetSessionKey, ...patch },
      sessionScope: true,
      session: readChatSettingsTargetRow(host, targetSessionKey),
    }).allowed;
  if (!canDispatch()) {
    return false;
  }
  setChatError(host, null);
  const switchPromiseRef: { current?: Promise<boolean> } = {};
  const switchPromise: Promise<boolean> = (async () => {
    try {
      const nextValue = splitTrailingAuthProfile(nextModel).model || defaultModel;
      const currentValue = splitTrailingAuthProfile(currentOverride).model || defaultModel;
      const nextEntry = host.chatModelCatalog.find(
        (entry) => buildQualifiedChatModelValue(entry.id, entry.provider) === nextValue,
      );
      const nextRuntime = resolveModelRuntimeEntry(
        nextEntry,
        runtimeSelection === undefined && isSessionRuntimePinned(activeRow?.agentRuntime)
          ? activeRow?.agentRuntime?.id
          : runtimeSelection,
      );
      const hasHistory = host.chatMessages?.some((message) => {
        const role = asOptionalRecord(message)?.role;
        return role === "user" || role === "assistant";
      });
      if (nextValue && nextValue !== currentValue && nextRuntime?.local !== true && hasHistory) {
        const { showConfirmDialog } = await import("../../components/confirm-dialog.ts");
        const displayLookup = buildCatalogDisplayLookup(host.chatModelCatalog);
        const currentEntry = host.chatModelCatalog.find(
          (entry) => buildQualifiedChatModelValue(entry.id, entry.provider) === currentValue,
        );
        const confirmed = await showConfirmDialog({
          title: t("chat.modelControls.switchTitle", {
            new:
              nextEntry?.name.trim() ||
              formatCatalogChatModelDisplayFromLookup(nextValue, displayLookup),
          }),
          message: t("chat.modelControls.switchWarning", {
            current:
              currentEntry?.name.trim() ||
              formatCatalogChatModelDisplayFromLookup(currentValue, displayLookup),
          }),
          confirmLabel: t("chat.modelControls.switchConfirm"),
          skipPreference: {
            label: t("chat.modelControls.dontAskAgain"),
            skipped: loadSettings().chatModelChangeConfirm === false,
            remember: () => {
              patchSettings({ chatModelChangeConfirm: false });
            },
          },
          signal: selection.owner.signal,
          canConfirm: canDispatch,
        });
        if (!confirmed || !canDispatch()) {
          return false;
        }
      }
      const patched = await patchChatSessionSettings(host, targetSessionKey, patch, {
        ...agentScope,
        expectedSessionId: selection.expectedSessionId,
        ownsModelOverride,
        canDispatch,
      });
      return patched !== null;
    } catch (err) {
      if (!ownsSelection()) {
        return false;
      }
      try {
        const { recoverChatModelSwitch } = await import("./chat-model-recovery.runtime.ts");
        return await recoverChatModelSwitch(
          host,
          err,
          targetSessionKey,
          nextModel,
          runtimeSelection,
          selection,
        );
      } catch (error) {
        if (ownsSelection()) {
          setChatError(host, `Failed to set model: ${formatUiError(error)}`);
        }
        return false;
      }
    } finally {
      if (host.chatModelSwitchPromises?.[targetSessionKey] === switchPromiseRef.current) {
        const nextSwitches = { ...host.chatModelSwitchPromises };
        delete nextSwitches[targetSessionKey];
        host.chatModelSwitchPromises = nextSwitches;
      }
    }
  })();
  switchPromiseRef.current = switchPromise;
  host.chatModelSwitchPromises = {
    ...host.chatModelSwitchPromises,
    [targetSessionKey]: switchPromise,
  };
  return switchPromise;
}
