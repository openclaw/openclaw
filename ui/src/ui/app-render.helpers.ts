import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { refreshChat, refreshChatAvatar } from "./app-chat.ts";
import { syncUrlWithSessionKey } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import { resolveSessionDisplayName } from "./chat/session-display.ts";
import { refreshSlashCommands } from "./chat/slash-commands.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import { ChatState, loadChatHistory } from "./controllers/chat.ts";
import { createSessionAndRefresh, loadSessions } from "./controllers/sessions.ts";
import { icons } from "./icons.ts";
import { iconForTab, pathForTab, titleForTab, type Tab } from "./navigation.ts";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "./session-key.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "./string-coerce.ts";
import type { ThemeMode } from "./theme.ts";
import type { ChatQueueItem } from "./ui-types.ts";

export {
  isCronSessionKey,
  parseSessionKey,
  resolveSessionDisplayName,
  resolveSessionOptionGroups,
} from "./chat/session-display.ts";

type SessionDefaultsSnapshot = {
  mainSessionKey?: string;
  mainKey?: string;
};

type SessionSwitchHost = AppViewState & {
  chatStreamStartedAt: number | null;
  chatSideResultTerminalRuns: Set<string>;
  resetChatInputHistoryNavigation(): void;
  resetToolStream(): void;
  resetChatScroll(): void;
};

type ChatRefreshHost = AppViewState & {
  chatManualRefreshInFlight: boolean;
  chatNewMessagesBelow: boolean;
  resetToolStream(): void;
  scrollToBottom(opts?: { smooth?: boolean }): void;
  updateComplete?: Promise<unknown>;
};

export async function handleChatManualRefresh(state: ChatRefreshHost): Promise<void> {
  state.chatManualRefreshInFlight = true;
  state.chatNewMessagesBelow = false;
  await state.updateComplete;
  state.resetToolStream();
  try {
    await refreshChat(state as unknown as Parameters<typeof refreshChat>[0], {
      awaitHistory: true,
      scheduleScroll: false,
    });
    state.scrollToBottom({ smooth: true });
  } finally {
    requestAnimationFrame(() => {
      state.chatManualRefreshInFlight = false;
      state.chatNewMessagesBelow = false;
    });
  }
}

export function resolveAssistantAttachmentAuthToken(
  state: Pick<AppViewState, "hello" | "settings" | "password">,
) {
  return resolveControlUiAuthToken(state);
}

export function resolveDashboardHeaderContext(
  state: Pick<AppViewState, "agentsList" | "sessionKey">,
): { agentLabel: string } {
  const agentId = resolveAgentIdFromSessionKey(state.sessionKey);
  const agent = state.agentsList?.agents.find(
    (entry) => normalizeLowercaseStringOrEmpty(entry.id) === agentId,
  );
  const agentLabel =
    normalizeOptionalString(agent?.identity?.name) ??
    normalizeOptionalString(agent?.name) ??
    agentId;
  return { agentLabel };
}

function resolveSidebarChatSessionKey(state: AppViewState): string {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const mainSessionKey = normalizeOptionalString(snapshot?.sessionDefaults?.mainSessionKey);
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = normalizeOptionalString(snapshot?.sessionDefaults?.mainKey);
  if (mainKey) {
    return mainKey;
  }
  return "main";
}

function saveChatQueueForSession(state: AppViewState, sessionKey: string) {
  const queueBySession = (state.chatQueueBySession ??= {});
  if (state.chatQueue.length > 0) {
    queueBySession[sessionKey] = [...state.chatQueue];
    state.chatQueueBySession = { ...queueBySession };
    return;
  }
  if (Object.prototype.hasOwnProperty.call(queueBySession, sessionKey)) {
    delete queueBySession[sessionKey];
    state.chatQueueBySession = { ...queueBySession };
  }
}

function restoreChatQueueForSession(state: AppViewState, sessionKey: string): ChatQueueItem[] {
  return [...(state.chatQueueBySession?.[sessionKey] ?? [])];
}

function resetChatStateForSessionSwitch(state: AppViewState, sessionKey: string) {
  const host = state as unknown as SessionSwitchHost;
  const previousSessionKey = state.sessionKey;
  saveChatQueueForSession(state, previousSessionKey);
  state.sessionKey = sessionKey;
  (state as unknown as { currentSessionId?: string | null }).currentSessionId = null;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatMessages = [];
  state.chatToolMessages = [];
  state.chatStreamSegments = [];
  state.chatThinkingLevel = null;
  state.chatStream = null;
  state.chatRunStatus = null;
  state.chatSideResult = null;
  state.lastError = null;
  state.compactionStatus = null;
  state.fallbackStatus = null;
  state.chatAvatarUrl = null;
  state.chatAvatarSource = null;
  state.chatAvatarStatus = null;
  state.chatAvatarReason = null;
  state.chatQueue = restoreChatQueueForSession(state, sessionKey);
  host.resetChatInputHistoryNavigation();
  host.chatStreamStartedAt = null;
  state.chatRunId = null;
  host.chatSideResultTerminalRuns.clear();
  host.resetToolStream();
  host.resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
}

function canSwitchToNewChatSession(state: AppViewState): boolean {
  return (
    !state.chatLoading &&
    !state.chatSending &&
    !state.chatRunId &&
    state.chatStream === null &&
    state.chatQueue.length === 0
  );
}

const NEW_CHAT_ACTIVE_RUN_MESSAGE =
  "Start a new session after the active run or queued messages finish.";
const NEW_CHAT_SESSIONS_LOADING_MESSAGE =
  "Session list is still refreshing. Try New Chat again in a moment.";
const NEW_CHAT_CREATE_FAILED_MESSAGE =
  "New Chat could not create a new session. Try again in a moment.";

export function renderTab(state: AppViewState, tab: Tab, opts?: { collapsed?: boolean }) {
  const href = pathForTab(tab, state.basePath);
  const isActive = state.tab === tab;
  const collapsed = opts?.collapsed ?? state.settings.navCollapsed;
  return html`
    <a
      href=${href}
      class="nav-item ${isActive ? "nav-item--active" : ""}"
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        if (tab === "chat") {
          if (!state.sessionKey) {
            const mainSessionKey = resolveSidebarChatSessionKey(state);
            resetChatStateForSessionSwitch(state, mainSessionKey);
          }
          if (state.tab !== "chat") {
            void state.loadAssistantIdentity();
          }
        }
        state.setTab(tab);
      }}
      title=${titleForTab(tab)}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      ${!collapsed ? html`<span class="nav-item__text">${titleForTab(tab)}</span>` : nothing}
    </a>
  `;
}

export function switchChatSession(state: AppViewState, nextSessionKey: string) {
  const previousSessionKey = state.sessionKey;
  const nextSessionRow = state.sessionsResult?.sessions.find((row) => row.key === nextSessionKey);
  const nextSessionLabel = resolveSessionDisplayName(nextSessionKey, nextSessionRow);
  state.chatTargetRunId = null;
  state.chatTargetAuditTs = null;
  state.chatTargetStatus = null;
  resetChatStateForSessionSwitch(state, nextSessionKey);
  if (previousSessionKey !== nextSessionKey) {
    state.announceSessionSwitch?.(nextSessionKey, nextSessionLabel);
  }
  void state.loadAssistantIdentity();
  void refreshChatAvatar(state);
  void refreshSlashCommands({
    client: state.client,
    agentId: parseAgentSessionKey(nextSessionKey)?.agentId,
  });
  syncUrlWithSessionKey(
    state as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
    nextSessionKey,
    true,
  );
  void loadChatHistory(state as unknown as ChatState);
  void refreshSessionOptions(state);
}

export function dismissChatError(state: AppViewState) {
  state.lastError = null;
  state.lastErrorCode = null;
  if (state.realtimeTalkStatus === "error") {
    const talkHost = state as unknown as {
      realtimeTalkSession?: { stop(): void } | null;
    };
    talkHost.realtimeTalkSession?.stop();
    talkHost.realtimeTalkSession = null;
    state.realtimeTalkActive = false;
    state.realtimeTalkStatus = "idle";
    state.realtimeTalkDetail = null;
    state.realtimeTalkTranscript = null;
  }
}

export async function createChatSession(state: AppViewState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (!canSwitchToNewChatSession(state)) {
    state.lastError = NEW_CHAT_ACTIVE_RUN_MESSAGE;
    return;
  }
  if (state.sessionsLoading) {
    state.lastError = NEW_CHAT_SESSIONS_LOADING_MESSAGE;
    return;
  }

  state.lastError = null;
  const previousSessionKey = state.sessionKey;
  const parentSessionKey = state.sessionsResult?.sessions.some(
    (row) => row.key === previousSessionKey,
  )
    ? previousSessionKey
    : undefined;
  const nextSessionKey = await createSessionAndRefresh(
    state as unknown as Parameters<typeof createSessionAndRefresh>[0],
    {
      agentId: resolveAgentIdFromSessionKey(previousSessionKey),
      parentSessionKey,
      emitCommandHooks: parentSessionKey !== undefined ? true : undefined,
    },
    {
      activeMinutes: 0,
      limit: 0,
      includeGlobal: true,
      includeUnknown: true,
      showArchived: state.sessionsShowArchived,
    },
  );
  if (
    !nextSessionKey ||
    state.sessionKey !== previousSessionKey ||
    !canSwitchToNewChatSession(state)
  ) {
    if (!nextSessionKey) {
      state.lastError =
        state.sessionsError ??
        (state.sessionsLoading
          ? NEW_CHAT_SESSIONS_LOADING_MESSAGE
          : NEW_CHAT_CREATE_FAILED_MESSAGE);
    }
    return;
  }

  const preservedDraft = state.chatMessage;
  const preservedAttachments = state.chatAttachments;
  switchChatSession(state, nextSessionKey);
  state.chatMessage = preservedDraft;
  state.chatAttachments = preservedAttachments;
}

async function refreshSessionOptions(state: AppViewState) {
  await loadSessions(state as unknown as Parameters<typeof loadSessions>[0], {
    activeMinutes: 0,
    limit: 0,
    includeGlobal: true,
    includeUnknown: true,
    showArchived: state.sessionsShowArchived,
  });
}

type ThemeModeOption = { id: ThemeMode; labelKey: string; short: string };
const THEME_MODE_OPTIONS: ThemeModeOption[] = [
  { id: "system", labelKey: "common.system", short: "SYS" },
  { id: "light", labelKey: "common.light", short: "LIGHT" },
  { id: "dark", labelKey: "common.dark", short: "DARK" },
];

export function renderTopbarThemeModeToggle(state: AppViewState) {
  const modeIcon = (mode: ThemeMode) => {
    if (mode === "system") {
      return icons.monitor;
    }
    if (mode === "light") {
      return icons.sun;
    }
    return icons.moon;
  };

  const applyMode = (mode: ThemeMode, e: Event) => {
    if (mode === state.themeMode) {
      return;
    }
    state.setThemeMode(mode, { element: e.currentTarget as HTMLElement });
  };

  return html`
    <div class="topbar-theme-mode" role="group" aria-label=${t("common.colorMode")}>
      ${THEME_MODE_OPTIONS.map((opt) => {
        const label = t(opt.labelKey);
        return html`
          <button
            type="button"
            class="topbar-theme-mode__btn ${opt.id === state.themeMode
              ? "topbar-theme-mode__btn--active"
              : ""}"
            title=${label}
            aria-label=${t("common.colorModeOption", { mode: label })}
            aria-pressed=${opt.id === state.themeMode}
            @click=${(e: Event) => applyMode(opt.id, e)}
          >
            ${modeIcon(opt.id)}
          </button>
        `;
      })}
    </div>
  `;
}

export function renderSidebarConnectionStatus(state: AppViewState) {
  const label = state.connected ? t("common.online") : t("common.offline");
  const toneClass = state.connected
    ? "sidebar-connection-status--online"
    : "sidebar-connection-status--offline";

  return html`
    <span
      class="sidebar-version__status ${toneClass}"
      role="img"
      aria-live="polite"
      aria-label=${t("chat.gatewayStatus", { status: label })}
      title=${t("chat.gatewayStatus", { status: label })}
    ></span>
  `;
}
