import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../i18n/index.ts";
import { refreshChat, refreshChatAvatar } from "./app-chat.ts";
import { syncUrlWithSessionKey } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import {
  isCronSessionKey,
  parseSessionKey,
  renderChatSessionSelect as renderChatSessionSelectBase,
  resolveSessionDisplayName,
  resolveSessionOptionGroups,
} from "./chat/session-controls.ts";
import { refreshSlashCommands } from "./chat/slash-commands.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import {
  ChatState,
  loadChatHistory,
  rememberChatHistorySnapshot,
  restoreChatHistorySnapshot,
} from "./controllers/chat.ts";
import { createSessionAndRefresh, loadSessions } from "./controllers/sessions.ts";
import { icons } from "./icons.ts";
import { iconForTab, pathForTab, titleForTab, type Tab } from "./navigation.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "./session-key.ts";
import {
  MAX_PINNED_SESSION_KEYS,
  MAX_PINNED_SESSION_SLOTS,
  MIN_PINNED_SESSION_SLOTS,
  normalizePinnedSessionKeys,
  normalizePinnedSessionSlotCount,
} from "./storage.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "./string-coerce.ts";
import type { ThemeMode } from "./theme.ts";
import type { SessionsListResult } from "./types.ts";
import type { ChatQueueItem } from "./ui-types.ts";

export { isCronSessionKey, parseSessionKey, resolveSessionDisplayName, resolveSessionOptionGroups };

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
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
  if (previousSessionKey) {
    rememberChatHistorySnapshot(state as unknown as ChatState, previousSessionKey);
  }
  state.sessionKey = sessionKey;
  (state as unknown as { currentSessionId?: string | null }).currentSessionId = null;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatToolMessages = [];
  state.chatStreamSegments = [];
  state.chatStream = null;
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
  if (!restoreChatHistorySnapshot(state as unknown as ChatState, sessionKey)) {
    state.chatMessages = [];
    state.chatThinkingLevel = null;
  }
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

function getPinnedSessionKeys(state: Pick<AppViewState, "settings">): string[] {
  return normalizePinnedSessionKeys(state.settings.pinnedSessionKeys);
}

function getPinnedSessionSlotCount(
  state: Pick<AppViewState, "settings">,
  opts?: { min?: number },
): number {
  const base = normalizePinnedSessionSlotCount(state.settings.pinnedSessionSlotCount);
  return Math.max(opts?.min ?? MIN_PINNED_SESSION_SLOTS, base);
}

function resolveSessionDefaults(state: Pick<AppViewState, "hello">): SessionDefaultsSnapshot {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  return snapshot?.sessionDefaults ?? {};
}

function resolvePinnedSessionPreferenceKey(state: Pick<AppViewState, "hello">): string {
  const defaults = resolveSessionDefaults(state);
  const mainSessionKey = normalizeOptionalString(defaults.mainSessionKey);
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = normalizeOptionalString(defaults.mainKey);
  if (mainKey) {
    return mainKey;
  }
  return "main";
}

function canonicalizePinnedSessionKey(
  state: Pick<AppViewState, "hello">,
  sessionKey: string,
): string {
  const key = normalizeOptionalString(sessionKey) ?? "";
  if (!key) {
    return key;
  }
  const defaults = resolveSessionDefaults(state);
  const mainSessionKey = normalizeOptionalString(defaults.mainSessionKey);
  if (!mainSessionKey) {
    return key;
  }
  const mainKey = normalizeOptionalString(defaults.mainKey) ?? "main";
  const defaultAgentId = normalizeAgentId(defaults.defaultAgentId ?? "main");
  if (
    key === "main" ||
    key === mainKey ||
    key === `agent:${defaultAgentId}:main` ||
    key === `agent:${defaultAgentId}:${mainKey}`
  ) {
    return mainSessionKey;
  }
  return key;
}

function canonicalizePinnedSessionKeys(
  state: Pick<AppViewState, "hello">,
  keys: string[],
): string[] {
  return normalizePinnedSessionKeys(keys.map((key) => canonicalizePinnedSessionKey(state, key)));
}

function persistPinnedSessionPreferences(
  state: Pick<AppViewState, "client" | "connected" | "hello"> & {
    sessionsError?: string | null;
  },
  settings: Pick<AppViewState, "settings">["settings"],
) {
  if (!state.client || !state.connected) {
    return;
  }
  void state.client
    .request("sessions.patch", {
      key: resolvePinnedSessionPreferenceKey(state),
      controlUiPinnedSessionKeys: canonicalizePinnedSessionKeys(
        state,
        normalizePinnedSessionKeys(settings.pinnedSessionKeys),
      ),
      controlUiPinnedSessionSlotCount: normalizePinnedSessionSlotCount(
        settings.pinnedSessionSlotCount,
      ),
    })
    .catch((err) => {
      if ("sessionsError" in state) {
        state.sessionsError = String(err);
      }
    });
}

function updatePinnedSessionKeys(state: AppViewState, nextKeys: string[]) {
  const nextSettings = {
    ...state.settings,
    pinnedSessionKeys: canonicalizePinnedSessionKeys(state, nextKeys),
  };
  state.applySettings(nextSettings);
  persistPinnedSessionPreferences(state, nextSettings);
}

function updatePinnedSessionSlotCount(state: AppViewState, nextCount: number) {
  const nextSettings = {
    ...state.settings,
    pinnedSessionSlotCount: normalizePinnedSessionSlotCount(nextCount),
  };
  state.applySettings(nextSettings);
  persistPinnedSessionPreferences(state, nextSettings);
}

export function addPinnedChatSlot(state: AppViewState) {
  updatePinnedSessionSlotCount(state, getPinnedSessionSlotCount(state) + 1);
}

export function removePinnedChatSlot(state: AppViewState) {
  updatePinnedSessionSlotCount(
    state,
    Math.max(getPinnedSessionKeys(state).length, getPinnedSessionSlotCount(state) - 1),
  );
}

export function pinChatSession(state: AppViewState, sessionKey: string) {
  const trimmedKey = canonicalizePinnedSessionKey(state, sessionKey);
  if (!trimmedKey) {
    return;
  }
  const current = getPinnedSessionKeys(state);
  if (current.includes(trimmedKey) || current.length >= MAX_PINNED_SESSION_KEYS) {
    return;
  }
  updatePinnedSessionKeys(state, [...current, trimmedKey].slice(0, MAX_PINNED_SESSION_KEYS));
}

export function unpinChatSession(state: AppViewState, sessionKey: string) {
  const trimmedKey = canonicalizePinnedSessionKey(state, sessionKey);
  if (!trimmedKey) {
    return;
  }
  const current = getPinnedSessionKeys(state);
  if (!current.includes(trimmedKey)) {
    return;
  }
  updatePinnedSessionKeys(
    state,
    current.filter((key) => key !== trimmedKey),
  );
}

export async function createBlankPinnedParallelSession(state: AppViewState) {
  if (
    !state.client ||
    !state.connected ||
    state.sidebarPinnedSessionCreating ||
    getPinnedSessionKeys(state).length >= MAX_PINNED_SESSION_KEYS
  ) {
    return null;
  }
  state.sidebarPinnedSessionCreating = true;
  try {
    const agentId = parseAgentSessionKey(state.sessionKey)?.agentId ?? "main";
    const nextKey = await createSessionAndRefresh(
      state as unknown as Parameters<typeof createSessionAndRefresh>[0],
      {
        agentId,
        label: "Parallel chat",
        parentSessionKey: state.sessionKey,
      },
      {
        activeMinutes: 0,
        limit: 0,
        includeGlobal: true,
        includeUnknown: true,
        showArchived: state.sessionsShowArchived,
      },
    );
    if (!nextKey) {
      return null;
    }
    const nextPinnedKeys = canonicalizePinnedSessionKeys(state, [
      ...getPinnedSessionKeys(state),
      nextKey,
    ]);
    const nextSettings = {
      ...state.settings,
      pinnedSessionKeys: nextPinnedKeys,
      pinnedSessionSlotCount: Math.max(getPinnedSessionSlotCount(state), nextPinnedKeys.length),
    };
    state.applySettings(nextSettings);
    persistPinnedSessionPreferences(state, nextSettings);
    navigateToPinnedChat(state, nextKey);
    startPinnedSessionRename(state, nextKey, "Parallel chat");
    void refreshSessionOptions(state);
    return nextKey;
  } catch (err) {
    state.sessionsError = String(err);
    return null;
  } finally {
    state.sidebarPinnedSessionCreating = false;
  }
}

function schedulePinnedSessionRenameFocus(key: string) {
  if (typeof document === "undefined") {
    return;
  }
  const target = encodeURIComponent(key);
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(`[data-pinned-rename-key="${target}"]`);
    input?.focus();
    input?.select();
  });
}

function startPinnedSessionRename(state: AppViewState, key: string, initialValue?: string) {
  state.sidebarPinnedSessionEditingKey = key;
  state.sidebarPinnedSessionRenameDraft = initialValue ?? "";
  schedulePinnedSessionRenameFocus(key);
}

function cancelPinnedSessionRename(state: AppViewState) {
  state.sidebarPinnedSessionEditingKey = null;
  state.sidebarPinnedSessionRenameDraft = "";
}

async function commitPinnedSessionRename(state: AppViewState, key: string) {
  if (!state.client || !state.connected) {
    cancelPinnedSessionRename(state);
    return;
  }
  const nextLabel = state.sidebarPinnedSessionRenameDraft?.trim() ?? "";
  cancelPinnedSessionRename(state);
  if (!nextLabel) {
    return;
  }
  try {
    await state.client.request("sessions.patch", { key, label: nextLabel });
    void refreshSessionOptions(state);
  } catch (err) {
    state.sessionsError = String(err);
  }
}

export function reorderPinnedChatSession(state: AppViewState, fromKey: string, toKey: string) {
  const keys = canonicalizePinnedSessionKeys(state, getPinnedSessionKeys(state));
  const fromIndex = keys.indexOf(canonicalizePinnedSessionKey(state, fromKey));
  const toIndex = keys.indexOf(canonicalizePinnedSessionKey(state, toKey));
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return;
  }
  const next = [...keys];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  updatePinnedSessionKeys(state, next);
}

type PinnedChatEntry = {
  key: string;
  label: string;
  editLabel: string;
  scopeLabel: string;
  active: boolean;
  missing: boolean;
  status: SessionsListResult["sessions"][number]["status"] | null;
};

function resolvePinnedChatEditLabel(
  key: string,
  row: SessionsListResult["sessions"][number],
  fallbackLabel: string,
): string {
  const label = normalizeOptionalString(row.label);
  if (label && label !== key) {
    return label;
  }
  const displayName = normalizeOptionalString(row.displayName);
  if (displayName && displayName !== key) {
    return displayName;
  }
  return fallbackLabel;
}

export function resolvePinnedChatEntries(state: AppViewState): PinnedChatEntry[] {
  const rows = state.sessionsResult?.sessions ?? [];
  const byKey = new Map<string, SessionsListResult["sessions"][number]>();
  for (const row of rows) {
    byKey.set(row.key, row);
  }

  const activeKey = canonicalizePinnedSessionKey(state, state.sessionKey);
  const entries = canonicalizePinnedSessionKeys(state, getPinnedSessionKeys(state)).map((key) => {
    const row = byKey.get(key);
    const scopeLabel = normalizeOptionalString(parseAgentSessionKey(key)?.rest) ?? key;
    const label = row ? resolveSessionDisplayName(key, row) : scopeLabel;
    const editLabel = row ? resolvePinnedChatEditLabel(key, row, label) : scopeLabel;
    return {
      key,
      label,
      editLabel,
      scopeLabel,
      active: key === activeKey,
      missing: !row,
      status: row?.status ?? null,
    };
  });

  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }
  for (const entry of entries) {
    if ((counts.get(entry.label) ?? 0) > 1 && entry.scopeLabel !== entry.label) {
      entry.label = `${entry.label} · ${entry.scopeLabel}`;
    }
  }
  return entries;
}

function resolvePinnedChatStatusTone(status: PinnedChatEntry["status"]): string {
  if (status === "running") {
    return "sidebar-pinned-chats__status--running";
  }
  if (status === "failed" || status === "killed" || status === "timeout") {
    return "sidebar-pinned-chats__status--error";
  }
  if (status === "done") {
    return "sidebar-pinned-chats__status--done";
  }
  return "";
}

function resolvePinnedChatStatusLabel(status: PinnedChatEntry["status"]): string {
  if (status === "running") {
    return "Running";
  }
  if (status === "failed") {
    return "Failed";
  }
  if (status === "killed") {
    return "Killed";
  }
  if (status === "timeout") {
    return "Timed out";
  }
  if (status === "done") {
    return "Done";
  }
  return "Idle";
}

function navigateToPinnedChat(state: AppViewState, sessionKey: string) {
  if (state.tab !== "chat") {
    state.setTab("chat");
  }
  switchChatSession(state, sessionKey);
}

export function renderSidebarPinnedChats(state: AppViewState) {
  if (state.settings.navCollapsed) {
    return nothing;
  }

  const entries = resolvePinnedChatEntries(state);
  const pinnedKeys = canonicalizePinnedSessionKeys(state, getPinnedSessionKeys(state));
  const currentPinned = pinnedKeys.includes(canonicalizePinnedSessionKey(state, state.sessionKey));
  const canPinCurrent =
    Boolean(normalizeOptionalString(state.sessionKey)) &&
    !currentPinned &&
    pinnedKeys.length < MAX_PINNED_SESSION_KEYS;
  const canCreateParallelSession =
    Boolean(state.client && state.connected) &&
    entries.length < MAX_PINNED_SESSION_KEYS &&
    !state.sidebarPinnedSessionCreating;
  const slotCount = Math.max(entries.length, getPinnedSessionSlotCount(state));
  const canAddSlot = slotCount < MAX_PINNED_SESSION_SLOTS;
  const emptySlots = Math.max(0, slotCount - entries.length);
  const canRemoveEmptySlot = slotCount > Math.max(MIN_PINNED_SESSION_SLOTS, entries.length);

  return html`
    <section class="sidebar-pinned-chats nav-section">
      <div class="sidebar-pinned-chats__header">
        <span class="sidebar-pinned-chats__label">Pinned chats</span>
        <div class="sidebar-pinned-chats__header-actions">
          <span class="sidebar-pinned-chats__count">${entries.length}/${slotCount}</span>
          <button
            class="sidebar-pinned-chats__action"
            type="button"
            title="Add pinned slot"
            aria-label="Add pinned slot"
            ?disabled=${!canAddSlot}
            @click=${() => addPinnedChatSlot(state)}
          >
            ${icons.plus}
          </button>
        </div>
      </div>
      <div class="sidebar-pinned-chats__items">
        ${repeat(
          entries,
          (entry) => entry.key,
          (entry) => {
            const isEditing = state.sidebarPinnedSessionEditingKey === entry.key;
            return html`
              <div
                class="sidebar-pinned-chats__row ${isEditing
                  ? "sidebar-pinned-chats__row--editing"
                  : ""}"
                ?draggable=${!isEditing}
                @dragstart=${(event: DragEvent) => {
                  if (isEditing) {
                    return;
                  }
                  event.dataTransfer?.setData("text/plain", entry.key);
                  if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = "move";
                  }
                }}
                @dragover=${(event: DragEvent) => {
                  if (isEditing) {
                    return;
                  }
                  event.preventDefault();
                  if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = "move";
                  }
                }}
                @drop=${(event: DragEvent) => {
                  if (isEditing) {
                    return;
                  }
                  event.preventDefault();
                  const fromKey = event.dataTransfer?.getData("text/plain")?.trim();
                  if (!fromKey) {
                    return;
                  }
                  reorderPinnedChatSession(state, fromKey, entry.key);
                }}
              >
                ${isEditing
                  ? html`
                      <input
                        class="sidebar-pinned-chats__rename-input"
                        data-pinned-rename-key=${encodeURIComponent(entry.key)}
                        .value=${state.sidebarPinnedSessionRenameDraft ?? ""}
                        @input=${(event: Event) => {
                          state.sidebarPinnedSessionRenameDraft = (
                            event.target as HTMLInputElement
                          ).value;
                        }}
                        @keydown=${(event: KeyboardEvent) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void commitPinnedSessionRename(state, entry.key);
                            return;
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            cancelPinnedSessionRename(state);
                          }
                        }}
                        @blur=${() => {
                          void commitPinnedSessionRename(state, entry.key);
                        }}
                      />
                      <span
                        class="sidebar-pinned-chats__status ${resolvePinnedChatStatusTone(
                          entry.status,
                        )}"
                        title=${resolvePinnedChatStatusLabel(entry.status)}
                        aria-label=${resolvePinnedChatStatusLabel(entry.status)}
                      ></span>
                      <button
                        class="sidebar-pinned-chats__remove"
                        type="button"
                        title="Save name"
                        aria-label="Save name"
                        @mousedown=${(event: MouseEvent) => event.preventDefault()}
                        @click=${() => {
                          void commitPinnedSessionRename(state, entry.key);
                        }}
                      >
                        ${icons.check}
                      </button>
                      <button
                        class="sidebar-pinned-chats__remove"
                        type="button"
                        title="Cancel rename"
                        aria-label="Cancel rename"
                        @mousedown=${(event: MouseEvent) => event.preventDefault()}
                        @click=${() => cancelPinnedSessionRename(state)}
                      >
                        ${icons.x}
                      </button>
                    `
                  : html`
                      <button
                        class="nav-item sidebar-pinned-chats__slot ${entry.active
                          ? "nav-item--active"
                          : ""} ${entry.missing ? "sidebar-pinned-chats__slot--missing" : ""}"
                        title=${`${entry.key} (drag to reorder)`}
                        @click=${() => navigateToPinnedChat(state, entry.key)}
                      >
                        <span class="nav-item__icon" aria-hidden="true"
                          >${icons.messageSquare}</span
                        >
                        <span class="nav-item__text">${entry.label}</span>
                      </button>
                      ${entry.missing
                        ? nothing
                        : html`
                            <button
                              class="sidebar-pinned-chats__remove"
                              type="button"
                              title="Rename chat"
                              aria-label="Rename chat"
                              @click=${(event: Event) => {
                                event.stopPropagation();
                                startPinnedSessionRename(state, entry.key, entry.editLabel);
                              }}
                            >
                              ${icons.edit}
                            </button>
                          `}
                      <span
                        class="sidebar-pinned-chats__status ${resolvePinnedChatStatusTone(
                          entry.status,
                        )}"
                        title=${resolvePinnedChatStatusLabel(entry.status)}
                        aria-label=${resolvePinnedChatStatusLabel(entry.status)}
                      ></span>
                      <button
                        class="sidebar-pinned-chats__remove"
                        type="button"
                        title="Unpin chat"
                        aria-label="Unpin chat"
                        @click=${(event: Event) => {
                          event.stopPropagation();
                          unpinChatSession(state, entry.key);
                        }}
                      >
                        ${icons.x}
                      </button>
                    `}
              </div>
            `;
          },
        )}
        ${Array.from({ length: emptySlots }, (_, index) => {
          const actionable = canPinCurrent && index === 0;
          return html`
            <div class="sidebar-pinned-chats__row">
              <button
                class="sidebar-pinned-chats__empty ${actionable
                  ? "sidebar-pinned-chats__empty--actionable"
                  : ""}"
                type="button"
                ?disabled=${!actionable}
                title=${actionable ? state.sessionKey : "Empty pinned slot"}
                @click=${() => {
                  if (!actionable) {
                    return;
                  }
                  pinChatSession(state, state.sessionKey);
                }}
              >
                <span class="nav-item__icon" aria-hidden="true"
                  >${actionable ? icons.plus : icons.bookmark}</span
                >
                <span class="nav-item__text"
                  >${actionable ? "Pin current chat" : "Empty pinned slot"}</span
                >
              </button>
              ${canRemoveEmptySlot
                ? html`
                    <button
                      class="sidebar-pinned-chats__action"
                      type="button"
                      title="New parallel session"
                      aria-label="New parallel session"
                      ?disabled=${!canCreateParallelSession}
                      @click=${() => {
                        void createBlankPinnedParallelSession(state);
                      }}
                    >
                      <span class="sidebar-pinned-chats__action-text">New</span>
                    </button>
                    <button
                      class="sidebar-pinned-chats__remove"
                      type="button"
                      title="Remove empty slot"
                      aria-label="Remove empty slot"
                      @click=${() => removePinnedChatSlot(state)}
                    >
                      ${icons.x}
                    </button>
                  `
                : html`
                    <button
                      class="sidebar-pinned-chats__action"
                      type="button"
                      title="New parallel session"
                      aria-label="New parallel session"
                      ?disabled=${!canCreateParallelSession}
                      @click=${() => {
                        void createBlankPinnedParallelSession(state);
                      }}
                    >
                      <span class="sidebar-pinned-chats__action-text">New</span>
                    </button>
                  `}
            </div>
          `;
        })}
      </div>
    </section>
  `;
}

function renderCronFilterIcon(hiddenCount: number) {
  return html`
    <span style="position: relative; display: inline-flex; align-items: center;">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      </svg>
      ${hiddenCount > 0
        ? html`<span
            style="
              position: absolute;
              top: -5px;
              right: -6px;
              background: var(--color-accent, #6366f1);
              color: #fff;
              border-radius: var(--radius-full);
              font-size: 9px;
              line-height: 1;
              padding: 1px 3px;
              pointer-events: none;
            "
            >${hiddenCount}</span
          >`
        : ""}
    </span>
  `;
}

export function renderChatSessionSelect(state: AppViewState) {
  return renderChatSessionSelectBase(state, switchChatSession);
}

export function renderChatControls(state: AppViewState) {
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron ? countHiddenCronSessions(state, state.sessionsResult) : 0;
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  const refreshLabel = t("chat.refreshTitle");
  const thinkingLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.thinkingToggle");
  const toolCallsLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.toolCallsToggle");
  const focusLabel = disableFocusToggle ? t("chat.onboardingDisabled") : t("chat.focusToggle");
  const cronLabel = hideCron
    ? hiddenCronCount > 0
      ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
      : t("chat.showCronSessions")
    : t("chat.hideCronSessions");
  const refreshDisabled =
    !state.connected ||
    state.chatLoading ||
    state.chatSending ||
    Boolean(state.chatRunId) ||
    state.chatStream !== null;
  const toolCallsIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `;
  const refreshIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
      <path d="M21 3v5h-5"></path>
    </svg>
  `;
  const focusIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
  return html`
    <div class="chat-controls">
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${refreshDisabled}
        @click=${() => handleChatManualRefresh(state as unknown as ChatRefreshHost)}
        title=${refreshLabel}
        aria-label=${refreshLabel}
        data-tooltip=${refreshLabel}
      >
        ${refreshIcon}
      </button>
      <span class="chat-controls__separator">|</span>
      <button
        class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatShowThinking: !state.settings.chatShowThinking,
          });
        }}
        aria-pressed=${showThinking}
        title=${thinkingLabel}
        aria-label=${thinkingLabel}
        data-tooltip=${thinkingLabel}
      >
        ${icons.brain}
      </button>
      <button
        class="btn btn--sm btn--icon ${showToolCalls ? "active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatShowToolCalls: !state.settings.chatShowToolCalls,
          });
        }}
        aria-pressed=${showToolCalls}
        title=${toolCallsLabel}
        aria-label=${toolCallsLabel}
        data-tooltip=${toolCallsLabel}
      >
        ${toolCallsIcon}
      </button>
      <button
        class="btn btn--sm btn--icon ${focusActive ? "active" : ""}"
        ?disabled=${disableFocusToggle}
        @click=${() => {
          if (disableFocusToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatFocusMode: !state.settings.chatFocusMode,
          });
        }}
        aria-pressed=${focusActive}
        title=${focusLabel}
        aria-label=${focusLabel}
        data-tooltip=${focusLabel}
      >
        ${focusIcon}
      </button>
      <button
        class="btn btn--sm btn--icon ${hideCron ? "active" : ""}"
        @click=${() => {
          state.sessionsHideCron = !hideCron;
        }}
        aria-pressed=${hideCron}
        title=${cronLabel}
        aria-label=${cronLabel}
        data-tooltip=${cronLabel}
      >
        ${renderCronFilterIcon(hiddenCronCount)}
      </button>
    </div>
  `;
}

/**
 * Mobile-only gear toggle + dropdown for chat controls.
 * Rendered in the topbar so it doesn't consume content-header space.
 * Hidden on desktop via CSS.
 */
export function renderChatMobileToggle(state: AppViewState) {
  const controlsDropdownId = "chat-mobile-controls-dropdown";
  const mobileControlsOpen = state.chatMobileControlsOpen;
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron ? countHiddenCronSessions(state, state.sessionsResult) : 0;
  const toolCallsIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `;
  const focusIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;

  return html`
    <div class="chat-mobile-controls-wrapper">
      <button
        class="btn btn--sm btn--icon chat-controls-mobile-toggle"
        @click=${(e: Event) => {
          e.stopPropagation();
          state.setChatMobileControlsOpen(!mobileControlsOpen, {
            trigger: e.currentTarget as HTMLElement,
          });
        }}
        title=${t("chat.settings")}
        aria-label=${t("chat.settings")}
        aria-expanded=${mobileControlsOpen}
        aria-controls=${controlsDropdownId}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3"></circle>
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          ></path>
        </svg>
      </button>
      <div
        id=${controlsDropdownId}
        class="chat-controls-dropdown ${mobileControlsOpen ? "open" : ""}"
        @click=${(e: Event) => {
          e.stopPropagation();
        }}
      >
        <div class="chat-controls">
          ${renderChatSessionSelectBase(state, switchChatSession)}
          <div class="chat-controls__thinking">
            <button
              class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
              ?disabled=${disableThinkingToggle}
              @click=${() => {
                if (!disableThinkingToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatShowThinking: !state.settings.chatShowThinking,
                  });
                }
              }}
              aria-pressed=${showThinking}
              title=${t("chat.thinkingToggle")}
            >
              ${icons.brain}
            </button>
            <button
              class="btn btn--sm btn--icon ${showToolCalls ? "active" : ""}"
              ?disabled=${disableThinkingToggle}
              @click=${() => {
                if (!disableThinkingToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatShowToolCalls: !state.settings.chatShowToolCalls,
                  });
                }
              }}
              aria-pressed=${showToolCalls}
              title=${t("chat.toolCallsToggle")}
            >
              ${toolCallsIcon}
            </button>
            <button
              class="btn btn--sm btn--icon ${focusActive ? "active" : ""}"
              ?disabled=${disableFocusToggle}
              @click=${() => {
                if (!disableFocusToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatFocusMode: !state.settings.chatFocusMode,
                  });
                }
              }}
              aria-pressed=${focusActive}
              title=${t("chat.focusToggle")}
            >
              ${focusIcon}
            </button>
            <button
              class="btn btn--sm btn--icon ${hideCron ? "active" : ""}"
              @click=${() => {
                state.sessionsHideCron = !hideCron;
              }}
              aria-pressed=${hideCron}
              title=${hideCron
                ? hiddenCronCount > 0
                  ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
                  : t("chat.showCronSessions")
                : t("chat.hideCronSessions")}
            >
              ${renderCronFilterIcon(hiddenCronCount)}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function switchChatSession(state: AppViewState, nextSessionKey: string) {
  const previousSessionKey = state.sessionKey;
  const nextSessionRow = state.sessionsResult?.sessions.find((row) => row.key === nextSessionKey);
  const nextSessionLabel = resolveSessionDisplayName(nextSessionKey, nextSessionRow);
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

/** Count cron sessions hidden by the active agent-scoped chat filter. */
function countHiddenCronSessions(state: AppViewState, sessions: SessionsListResult | null): number {
  if (!sessions?.sessions) {
    return 0;
  }
  const activeAgentId = normalizeAgentId(
    parseAgentSessionKey(state.sessionKey)?.agentId ?? state.agentsList?.defaultId ?? "main",
  );
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const isTiedToActiveAgent = (key: string) => {
    const parsed = parseAgentSessionKey(key);
    if (parsed) {
      return normalizeAgentId(parsed.agentId) === activeAgentId;
    }
    return activeAgentId === defaultAgentId;
  };

  return sessions.sessions.filter(
    (s) => isCronSessionKey(s.key) && s.key !== state.sessionKey && isTiedToActiveAgent(s.key),
  ).length;
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
