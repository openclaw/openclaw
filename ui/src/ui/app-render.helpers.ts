import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { refreshChat, refreshChatAvatar } from "./app-chat.ts";
import { syncUrlWithSessionKey } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import {
  isCronSessionKey,
  parseSessionKey,
  renderChatSessionSelect as renderChatSessionSelectBase,
  renderChatThinkingSelect,
  resolveSessionDisplayName,
  resolveSessionOptionGroups,
} from "./chat/session-controls.ts";
import { refreshSlashCommands } from "./chat/slash-commands.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import { ChatState, loadChatHistory } from "./controllers/chat.ts";
import { loadSessions } from "./controllers/sessions.ts";
import { icons } from "./icons.ts";
import { iconForTab, pathForTab, titleForTab, type Tab } from "./navigation.ts";
import { parseAgentSessionKey } from "./session-key.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import type { ThemeMode } from "./theme.ts";
import type { SessionsListResult } from "./types.ts";

export { isCronSessionKey, parseSessionKey, resolveSessionDisplayName, resolveSessionOptionGroups };

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

export function resolveAssistantAttachmentAuthToken(
  state: Pick<AppViewState, "hello" | "settings" | "password">,
) {
  return resolveControlUiAuthToken(state);
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

function resetChatStateForSessionSwitch(state: AppViewState, sessionKey: string) {
  const host = state as unknown as SessionSwitchHost;
  state.sessionKey = sessionKey;
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatMessages = [];
  state.chatToolMessages = [];
  state.chatStreamSegments = [];
  state.chatThinkingLevel = null;
  state.chatStream = null;
  state.chatSideResult = null;
  state.lastError = null;
  state.compactionStatus = null;
  state.fallbackStatus = null;
  state.chatAvatarUrl = null;
  state.chatAvatarSource = null;
  state.chatAvatarStatus = null;
  state.chatAvatarReason = null;
  state.chatQueue = [];
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
  const hiddenCronCount = hideCron
    ? countHiddenCronSessions(state.sessionKey, state.sessionsResult)
    : 0;
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
        ?disabled=${state.chatLoading || !state.connected}
        @click=${async () => {
          const app = state as unknown as ChatRefreshHost;
          app.chatManualRefreshInFlight = true;
          app.chatNewMessagesBelow = false;
          await app.updateComplete;
          app.resetToolStream();
          try {
            await refreshChat(state as unknown as Parameters<typeof refreshChat>[0], {
              scheduleScroll: false,
            });
            app.scrollToBottom({ smooth: true });
          } finally {
            requestAnimationFrame(() => {
              app.chatManualRefreshInFlight = false;
              app.chatNewMessagesBelow = false;
            });
          }
        }}
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
  const sessionGroups = resolveSessionOptionGroups(state, state.sessionKey, state.sessionsResult);
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
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
          const btn = e.currentTarget as HTMLElement;
          const dropdown = btn.nextElementSibling as HTMLElement;
          if (dropdown) {
            const isOpen = dropdown.classList.toggle("open");
            if (isOpen) {
              const close = () => {
                dropdown.classList.remove("open");
                document.removeEventListener("click", close);
              };
              setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
            }
          }
        }}
        title="Chat settings"
        aria-label="Chat settings"
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
        class="chat-controls-dropdown"
        @click=${(e: Event) => {
          e.stopPropagation();
        }}
      >
        <div class="chat-controls">
          <label class="field chat-controls__session">
            <select
              .value=${state.sessionKey}
              @change=${(e: Event) => {
                const next = (e.target as HTMLSelectElement).value;
                switchChatSession(state, next);
              }}
            >
              ${sessionGroups.map(
                (group) => html`
                  <optgroup label=${group.label}>
                    ${group.options.map(
                      (opt) => html`
                        <option
                          value=${opt.key}
                          title=${opt.title}
                          ?selected=${opt.key === state.sessionKey}
                        >
                          ${opt.label}
                        </option>
                      `,
                    )}
                  </optgroup>
                `,
              )}
            </select>
          </label>
          ${renderChatThinkingSelect(state)}
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
          </div>
        </div>
      </div>
    </div>
  `;
}

export function switchChatSession(state: AppViewState, nextSessionKey: string) {
  resetChatStateForSessionSwitch(state, nextSessionKey);
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

async function refreshSessionOptions(state: AppViewState) {
  await loadSessions(state as unknown as Parameters<typeof loadSessions>[0], {
    activeMinutes: 0,
    limit: 0,
    includeGlobal: true,
    includeUnknown: true,
  });
}

<<<<<<< HEAD
=======
function resolveActiveSessionRow(state: AppViewState) {
  return state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
}

function resolveModelOverrideValue(state: AppViewState): string {
  // Prefer the local cache — it reflects in-flight patches before sessionsResult refreshes.
  const cached = state.chatModelOverrides[state.sessionKey];
  if (cached) {
    return normalizeChatModelOverrideValue(cached, state.chatModelCatalog ?? []);
  }
  // cached === null means explicitly cleared to default.
  if (cached === null) {
    return "";
  }
  // No local override recorded yet — fall back to server data.
  // Include provider prefix so the value matches option keys (provider/model).
  const activeRow = resolveActiveSessionRow(state);
  if (activeRow && typeof activeRow.model === "string" && activeRow.model.trim()) {
    return resolveServerChatModelValue(activeRow.model, activeRow.modelProvider);
  }
  return "";
}

function resolveDefaultModelValue(state: AppViewState): string {
  const defaults = state.sessionsResult?.defaults;
  return resolveServerChatModelValue(defaults?.model, defaults?.modelProvider);
}

function buildChatModelOptions(
  catalog: ModelCatalogEntry[],
  currentOverride: string,
  defaultModel: string,
): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];
  const addOption = (value: string, label?: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push({ value: trimmed, label: label ?? trimmed });
  };

  for (const entry of catalog) {
    const option = buildChatModelOption(entry);
    addOption(option.value, option.label);
  }

  if (currentOverride) {
    addOption(currentOverride);
  }
  if (defaultModel) {
    addOption(defaultModel);
  }
  return options;
}

function renderChatModelSelect(state: AppViewState) {
  const currentOverride = resolveModelOverrideValue(state);
  const defaultModel = resolveDefaultModelValue(state);
  const options = buildChatModelOptions(
    state.chatModelCatalog ?? [],
    currentOverride,
    defaultModel,
  );
  const defaultDisplay = formatChatModelDisplay(defaultModel);
  const defaultLabel = defaultModel ? `Default (${defaultDisplay})` : "Default model";
  const busy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  const disabled =
    !state.connected || busy || (state.chatModelsLoading && options.length === 0) || !state.client;
  return html`
    <label class="field chat-controls__session chat-controls__model">
      <select
        data-chat-model-select="true"
        aria-label="Chat model"
        ?disabled=${disabled}
        @change=${async (e: Event) => {
          const next = (e.target as HTMLSelectElement).value.trim();
          await switchChatModel(state, next);
        }}
      >
        <option value="" ?selected=${currentOverride === ""}>${defaultLabel}</option>
        ${repeat(
          options,
          (entry) => entry.value,
          (entry) =>
            html`<option value=${entry.value} ?selected=${entry.value === currentOverride}>
              ${entry.label}
            </option>`,
        )}
      </select>
    </label>
  `;
}

async function switchChatModel(state: AppViewState, nextModel: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const currentOverride = resolveModelOverrideValue(state);
  if (currentOverride === nextModel) {
    return;
  }
  const targetSessionKey = state.sessionKey;
  const prevOverride = state.chatModelOverrides[targetSessionKey];
  state.lastError = null;
  // Write the override cache immediately so the picker stays in sync during the RPC round-trip.
  state.chatModelOverrides = {
    ...state.chatModelOverrides,
    [targetSessionKey]: createChatModelOverride(nextModel),
  };
  try {
    await state.client.request("sessions.patch", {
      key: targetSessionKey,
      model: nextModel || null,
    });
    await refreshSessionOptions(state);
  } catch (err) {
    // Roll back so the picker reflects the actual server model.
    state.chatModelOverrides = { ...state.chatModelOverrides, [targetSessionKey]: prevOverride };
    state.lastError = `Failed to set model: ${String(err)}`;
  }
}

/* ── Channel display labels ────────────────────────────── */
const CHANNEL_LABELS: Record<string, string> = {
  bluebubbles: "iMessage",
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  slack: "Slack",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  email: "Email",
  sms: "SMS",
};

const KNOWN_CHANNEL_KEYS = Object.keys(CHANNEL_LABELS);

/** Parsed type / context extracted from a session key. */
export type SessionKeyInfo = {
  /** Prefix for typed sessions (Subagent:/Cron:). Empty for others. */
  prefix: string;
  /** Human-readable fallback when no label / displayName is available. */
  fallbackName: string;
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse a session key to extract type information and a human-readable
 * fallback display name.  Exported for testing.
 */
export function parseSessionKey(key: string): SessionKeyInfo {
  const normalized = key.toLowerCase();

  // ── Main session ─────────────────────────────────
  if (key === "main" || key === "agent:main:main") {
    return { prefix: "", fallbackName: "Main Session" };
  }

  // ── Subagent ─────────────────────────────────────
  if (key.includes(":subagent:")) {
    return { prefix: "Subagent:", fallbackName: "Subagent:" };
  }

  // ── Cron job ─────────────────────────────────────
  if (normalized.startsWith("cron:") || key.includes(":cron:")) {
    return { prefix: "Cron:", fallbackName: "Cron Job:" };
  }

  // ── Direct chat  (agent:<x>:<channel>:direct:<id>) ──
  const directMatch = key.match(/^agent:[^:]+:([^:]+):direct:(.+)$/);
  if (directMatch) {
    const channel = directMatch[1];
    const identifier = directMatch[2];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} · ${identifier}` };
  }

  // ── Group chat  (agent:<x>:<channel>:group:<id>) ────
  const groupMatch = key.match(/^agent:[^:]+:([^:]+):group:(.+)$/);
  if (groupMatch) {
    const channel = groupMatch[1];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} Group` };
  }

  // ── Channel-prefixed legacy keys (e.g. "bluebubbles:g-…") ──
  for (const ch of KNOWN_CHANNEL_KEYS) {
    if (key === ch || key.startsWith(`${ch}:`)) {
      return { prefix: "", fallbackName: `${CHANNEL_LABELS[ch]} Session` };
    }
  }

  // ── Unknown — return key as-is ───────────────────
  return { prefix: "", fallbackName: key };
}

export function resolveSessionDisplayName(
  key: string,
  row?: SessionsListResult["sessions"][number],
): string {
  const label = row?.label?.trim() || "";
  const displayName = row?.displayName?.trim() || "";
  const { prefix, fallbackName } = parseSessionKey(key);

  const applyTypedPrefix = (name: string): string => {
    if (!prefix) {
      return name;
    }
    const prefixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*`, "i");
    return prefixPattern.test(name) ? name : `${prefix} ${name}`;
  };

  if (label && label !== key) {
    return applyTypedPrefix(label);
  }
  if (displayName && displayName !== key) {
    return applyTypedPrefix(displayName);
  }
  return fallbackName;
}

export function isCronSessionKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("cron:")) {
    return true;
  }
  if (!normalized.startsWith("agent:")) {
    return false;
  }
  const parts = normalized.split(":").filter(Boolean);
  if (parts.length < 3) {
    return false;
  }
  const rest = parts.slice(2).join(":");
  return rest.startsWith("cron:");
}

type SessionOptionEntry = {
  key: string;
  label: string;
  scopeLabel: string;
  title: string;
};

type SessionOptionGroup = {
  id: string;
  label: string;
  options: SessionOptionEntry[];
};

export function resolveSessionOptionGroups(
  state: AppViewState,
  sessionKey: string,
  sessions: SessionsListResult | null,
): SessionOptionGroup[] {
  const rows = sessions?.sessions ?? [];
  const hideCron = state.sessionsHideCron ?? true;
  const byKey = new Map<string, SessionsListResult["sessions"][number]>();
  for (const row of rows) {
    byKey.set(row.key, row);
  }

  const seenKeys = new Set<string>();
  const groups = new Map<string, SessionOptionGroup>();
  const ensureGroup = (groupId: string, label: string): SessionOptionGroup => {
    const existing = groups.get(groupId);
    if (existing) {
      return existing;
    }
    const created: SessionOptionGroup = {
      id: groupId,
      label,
      options: [],
    };
    groups.set(groupId, created);
    return created;
  };

  const addOption = (key: string) => {
    // Normalize to lowercase for dedup — parseAgentSessionKey lowercases internally,
    // so mixed-case variants of the same key must be treated as duplicates.
    const normalizedKey = key.toLowerCase();
    if (!key || seenKeys.has(normalizedKey)) {
      return;
    }
    seenKeys.add(normalizedKey);
    const row = byKey.get(key);
    const parsed = parseAgentSessionKey(key);
    const group = parsed
      ? ensureGroup(
          `agent:${parsed.agentId.toLowerCase()}`,
          resolveAgentGroupLabel(state, parsed.agentId),
        )
      : ensureGroup("other", "Other Sessions");
    const scopeLabel = parsed?.rest?.trim() || key;
    const label = resolveSessionScopedOptionLabel(key, row, parsed?.rest);
    group.options.push({
      key,
      label,
      scopeLabel,
      title: key,
    });
  };

  for (const row of rows) {
    if (row.key !== sessionKey && (row.kind === "global" || row.kind === "unknown")) {
      continue;
    }
    if (hideCron && row.key !== sessionKey && isCronSessionKey(row.key)) {
      continue;
    }
    addOption(row.key);
  }
  addOption(sessionKey);

  // Ensure every known agent appears in the dropdown even when it has no persisted
  // sessions yet.  Without this, agents disappear after a session switch because
  // the refreshed sessionsResult only contains rows for the active agent.
  const mainKey = resolveSidebarChatSessionKey(state);
  for (const agent of state.agentsList?.agents ?? []) {
    const agentId = agent.id.trim();
    if (agentId) {
      addOption(`agent:${agentId.toLowerCase()}:${mainKey}`);
    }
  }

  for (const group of groups.values()) {
    const counts = new Map<string, number>();
    for (const option of group.options) {
      counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
    }
    for (const option of group.options) {
      if ((counts.get(option.label) ?? 0) > 1 && option.scopeLabel !== option.label) {
        option.label = `${option.label} · ${option.scopeLabel}`;
      }
    }
  }

  return Array.from(groups.values());
}

>>>>>>> 29601b9e9a (fix(ui): include all known agents in webchat session dropdown)
/** Count sessions with a cron: key that would be hidden when hideCron=true. */
function countHiddenCronSessions(sessionKey: string, sessions: SessionsListResult | null): number {
  if (!sessions?.sessions) {
    return 0;
  }
  // Don't count the currently active session even if it's a cron.
  return sessions.sessions.filter((s) => isCronSessionKey(s.key) && s.key !== sessionKey).length;
}

type ThemeModeOption = { id: ThemeMode; label: string; short: string };
const THEME_MODE_OPTIONS: ThemeModeOption[] = [
  { id: "system", label: "System", short: "SYS" },
  { id: "light", label: "Light", short: "LIGHT" },
  { id: "dark", label: "Dark", short: "DARK" },
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
    <div class="topbar-theme-mode" role="group" aria-label="Color mode">
      ${THEME_MODE_OPTIONS.map(
        (opt) => html`
          <button
            type="button"
            class="topbar-theme-mode__btn ${opt.id === state.themeMode
              ? "topbar-theme-mode__btn--active"
              : ""}"
            title=${opt.label}
            aria-label="Color mode: ${opt.label}"
            aria-pressed=${opt.id === state.themeMode}
            @click=${(e: Event) => applyMode(opt.id, e)}
          >
            ${modeIcon(opt.id)}
          </button>
        `,
      )}
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
      aria-label="Gateway status: ${label}"
      title="Gateway status: ${label}"
    ></span>
  `;
}
