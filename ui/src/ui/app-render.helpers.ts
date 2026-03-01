import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { t } from "../i18n/index.ts";
import { CHAT_SESSIONS_ACTIVE_MINUTES, refreshChat } from "./app-chat.ts";
import { syncUrlWithSessionKey } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import { OpenClawApp } from "./app.ts";
import { ChatState, loadChatHistory } from "./controllers/chat.ts";
import { loadSessions } from "./controllers/sessions.ts";
import { icons } from "./icons.ts";
import { iconForTab, pathForTab, titleForTab, type Tab } from "./navigation.ts";
import type { ThemeTransitionContext } from "./theme-transition.ts";
import type { ThemeMode } from "./theme.ts";
import type { GatewayAgentRow, SessionsListResult } from "./types.ts";

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainSessionKey?: string;
  mainKey?: string;
};

export type SessionAgentFilter = {
  agentId?: string | null;
  defaultAgentId?: string | null;
};

function normalizeAgentId(value: string | null | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized || "main";
}

function resolveDefaultAgentId(state: AppViewState): string {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fromSnapshot = snapshot?.sessionDefaults?.defaultAgentId;
  if (typeof fromSnapshot === "string" && fromSnapshot.trim()) {
    return normalizeAgentId(fromSnapshot);
  }
  if (typeof state.agentsList?.defaultId === "string" && state.agentsList.defaultId.trim()) {
    return normalizeAgentId(state.agentsList.defaultId);
  }
  return "main";
}

function resolveMainKey(state: AppViewState): string {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const raw = snapshot?.sessionDefaults?.mainKey;
  const trimmed = (raw ?? "").trim().toLowerCase();
  return trimmed || "main";
}

function sessionBelongsToAgent(params: {
  sessionKey: string;
  agentId: string;
  defaultAgentId: string;
}): boolean {
  const key = params.sessionKey.trim();
  if (!key) {
    return false;
  }
  const targetAgent = normalizeAgentId(params.agentId);
  const defaultAgent = normalizeAgentId(params.defaultAgentId);
  const parsed = parseAgentSessionKey(key);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId) === targetAgent;
  }
  const lowered = key.toLowerCase();
  if (lowered === "global" || lowered === "unknown") {
    return false;
  }
  if (lowered.startsWith("agent:")) {
    return false;
  }
  return targetAgent === defaultAgent;
}

export function resolveChatAgentId(state: AppViewState): string {
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  if (typeof state.agentsSelectedId === "string" && state.agentsSelectedId.trim()) {
    return normalizeAgentId(state.agentsSelectedId);
  }
  return resolveDefaultAgentId(state);
}

function resolveAgentMainSessionKey(state: AppViewState, agentId: string): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  const defaultAgentId = resolveDefaultAgentId(state);
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const scopedMain = snapshot?.sessionDefaults?.mainSessionKey?.trim();
  if (scopedMain) {
    const parsed = parseAgentSessionKey(scopedMain);
    if (parsed?.agentId && normalizeAgentId(parsed.agentId) === normalizedAgentId) {
      return scopedMain;
    }
    if (!parsed && normalizedAgentId === defaultAgentId) {
      return scopedMain;
    }
  }
  return `agent:${normalizedAgentId}:${resolveMainKey(state)}`;
}

function pickSessionKeyForAgent(state: AppViewState, agentId: string): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  const defaultAgentId = resolveDefaultAgentId(state);
  if (
    sessionBelongsToAgent({
      sessionKey: state.sessionKey,
      agentId: normalizedAgentId,
      defaultAgentId,
    })
  ) {
    return state.sessionKey;
  }
  const preferredMainKey = resolveAgentMainSessionKey(state, normalizedAgentId);
  if (state.sessionsResult?.sessions?.some((row) => row.key === preferredMainKey)) {
    return preferredMainKey;
  }
  const firstMatching = state.sessionsResult?.sessions?.find((row) =>
    sessionBelongsToAgent({
      sessionKey: row.key,
      agentId: normalizedAgentId,
      defaultAgentId,
    }),
  );
  return firstMatching?.key ?? preferredMainKey;
}

function switchChatAgent(state: AppViewState, agentId: string) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const nextSessionKey = pickSessionKeyForAgent(state, normalizedAgentId);
  state.agentsSelectedId = normalizedAgentId;
  if (state.sessionKey !== nextSessionKey) {
    resetChatStateForSessionSwitch(state, nextSessionKey);
    syncUrlWithSessionKey(
      state as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
      nextSessionKey,
      true,
    );
  }
  void state.loadAssistantIdentity();
  void loadChatHistory(state as unknown as ChatState);
  void loadSessions(state as unknown as OpenClawApp, {
    activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
    agentId: normalizedAgentId,
  });
}

function resolveChatAgentOptionLabel(agent: GatewayAgentRow): string {
  const agentId = normalizeAgentId(agent.id);
  const displayName =
    agent.identity?.name?.trim() ||
    agent.name?.trim() ||
    agent.id.trim() ||
    agentId;
  return displayName;
}

function isLikelyEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length > 16) {
    return false;
  }
  let hasNonAscii = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) > 127) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) {
    return false;
  }
  if (trimmed.includes("://") || trimmed.includes("/") || trimmed.includes(".")) {
    return false;
  }
  return true;
}

function resolveChatAgentOptionEmoji(state: AppViewState, agent: GatewayAgentRow): string {
  const normalizedAgentId = normalizeAgentId(agent.id);
  const identity =
    state.agentIdentityById[agent.id] ??
    state.agentIdentityById[normalizedAgentId] ??
    null;
  const identityEmoji = identity?.emoji?.trim();
  if (identityEmoji && isLikelyEmoji(identityEmoji)) {
    return identityEmoji;
  }
  const configuredEmoji = agent.identity?.emoji?.trim();
  if (configuredEmoji && isLikelyEmoji(configuredEmoji)) {
    return configuredEmoji;
  }
  return "";
}

function resolveSidebarChatSessionKey(state: AppViewState): string {
  const activeAgentId = resolveChatAgentId(state);
  return resolveAgentMainSessionKey(state, activeAgentId);
}

function resetChatStateForSessionSwitch(state: AppViewState, sessionKey: string) {
  state.sessionKey = sessionKey;
  state.chatMessage = "";
  state.chatStream = null;
  (state as unknown as OpenClawApp).chatStreamStartedAt = null;
  state.chatRunId = null;
  (state as unknown as OpenClawApp).resetToolStream();
  (state as unknown as OpenClawApp).resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
}

export function renderTab(state: AppViewState, tab: Tab) {
  const href = pathForTab(tab, state.basePath);
  return html`
    <a
      href=${href}
      class="nav-item ${state.tab === tab ? "active" : ""}"
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
          const mainSessionKey = resolveSidebarChatSessionKey(state);
          if (state.sessionKey !== mainSessionKey) {
            resetChatStateForSessionSwitch(state, mainSessionKey);
            void state.loadAssistantIdentity();
          }
        }
        state.setTab(tab);
      }}
      title=${titleForTab(tab)}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      <span class="nav-item__text">${titleForTab(tab)}</span>
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
      ${
        hiddenCount > 0
          ? html`<span
            style="
              position: absolute;
              top: -5px;
              right: -6px;
              background: var(--color-accent, #6366f1);
              color: #fff;
              border-radius: 999px;
              font-size: 9px;
              line-height: 1;
              padding: 1px 3px;
              pointer-events: none;
            "
          >${hiddenCount}</span
          >`
          : ""
      }
    </span>
  `;
}

export function renderChatControls(state: AppViewState) {
  const activeAgentId = resolveChatAgentId(state);
  const defaultAgentId = resolveDefaultAgentId(state);
  const mainSessionKey = resolveAgentMainSessionKey(state, activeAgentId);
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron
    ? countHiddenCronSessions(state.sessionKey, state.sessionsResult)
    : 0;
  const sessionOptions = resolveSessionOptions(
    state.sessionKey,
    state.sessionsResult,
    mainSessionKey,
    {
      hideCron,
      filter: {
        agentId: activeAgentId,
        defaultAgentId,
      },
    },
  );
  const disableThinkingToggle = state.onboarding;
  const disableInlineToolFlowToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const inlineToolFlowActive = state.onboarding ? false : state.settings.chatShowInlineToolFlow;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  // Refresh icon
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
      <label class="field chat-controls__session">
        <select
          .value=${state.sessionKey}
          ?disabled=${!state.connected}
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value;
            state.sessionKey = next;
            const parsed = parseAgentSessionKey(next);
            if (parsed?.agentId) {
              state.agentsSelectedId = normalizeAgentId(parsed.agentId);
            } else if (next.trim().toLowerCase() === "main") {
              state.agentsSelectedId = defaultAgentId;
            }
            state.chatMessage = "";
            state.chatStream = null;
            (state as unknown as OpenClawApp).chatStreamStartedAt = null;
            state.chatRunId = null;
            (state as unknown as OpenClawApp).resetToolStream();
            (state as unknown as OpenClawApp).resetChatScroll();
            state.applySettings({
              ...state.settings,
              sessionKey: next,
              lastActiveSessionKey: next,
            });
            void state.loadAssistantIdentity();
            syncUrlWithSessionKey(
              state as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
              next,
              true,
            );
            void loadChatHistory(state as unknown as ChatState);
          }}
        >
          ${repeat(
            sessionOptions,
            (entry) => entry.key,
            (entry) =>
              html`<option value=${entry.key} title=${entry.key}>
                ${entry.displayName ?? entry.key}
              </option>`,
          )}
        </select>
      </label>
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${state.chatLoading || !state.connected}
        @click=${async () => {
          const app = state as unknown as OpenClawApp;
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
        title=${t("chat.refreshTitle")}
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
          const nextThinking = !state.settings.chatShowThinking;
          state.applySettings({
            ...state.settings,
            chatShowThinking: nextThinking,
            chatShowInlineToolFlow: nextThinking ? false : state.settings.chatShowInlineToolFlow,
          });
        }}
        aria-pressed=${showThinking}
        title=${disableThinkingToggle ? t("chat.onboardingDisabled") : t("chat.thinkingToggle")}
      >
        ${icons.brain}
      </button>
      <button
        class="btn btn--sm btn--icon ${inlineToolFlowActive ? "active" : ""}"
        ?disabled=${disableInlineToolFlowToggle}
        @click=${() => {
          if (disableInlineToolFlowToggle) {
            return;
          }
          const nextInlineFlow = !state.settings.chatShowInlineToolFlow;
          state.applySettings({
            ...state.settings,
            chatShowInlineToolFlow: nextInlineFlow,
            chatShowThinking: nextInlineFlow ? false : state.settings.chatShowThinking,
          });
        }}
        aria-pressed=${inlineToolFlowActive}
        title=${
          disableInlineToolFlowToggle
            ? t("chat.onboardingDisabled")
            : t("chat.toolFlowToggle")
        }
      >
        ${icons.fileCode}
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
        title=${disableFocusToggle ? t("chat.onboardingDisabled") : t("chat.focusToggle")}
      >
        ${focusIcon}
      </button>
      <button
        class="btn btn--sm btn--icon ${hideCron ? "active" : ""}"
        @click=${() => {
          state.sessionsHideCron = !hideCron;
        }}
        aria-pressed=${hideCron}
        title=${
          hideCron
            ? hiddenCronCount > 0
              ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
              : t("chat.showCronSessions")
            : t("chat.hideCronSessions")
        }
      >
        ${renderCronFilterIcon(hiddenCronCount)}
      </button>
    </div>
  `;
}

export function renderChatNavAgentPicker(state: AppViewState) {
  const agents = state.agentsList?.agents ?? [];
  if (agents.length === 0) {
    return nothing;
  }
  const selectedAgentId = resolveChatAgentId(state);
  const pickerDisabled = !state.connected;
  return html`
    <div class="nav-chat-agent-picker" role="radiogroup" aria-label=${t("chat.agentPickerLabel")}>
      ${repeat(
        agents,
        (agent) => agent.id,
        (agent) => {
          const normalizedAgentId = normalizeAgentId(agent.id);
          const isActive = normalizedAgentId === selectedAgentId;
          const optionEmoji = resolveChatAgentOptionEmoji(state, agent);
          return html`
            <button
              type="button"
              class="nav-item nav-item--agent ${isActive ? "active" : ""}"
              role="radio"
              aria-checked=${isActive}
              ?disabled=${pickerDisabled}
              @click=${() => {
                if (pickerDisabled || isActive) {
                  return;
                }
                switchChatAgent(state, normalizedAgentId);
              }}
              title=${t("chat.agentPickerTitle")}
            >
              <span
                class="nav-item__icon ${optionEmoji ? "nav-item__icon--agent-emoji" : "nav-item__icon--agent"}"
                aria-hidden="true"
              >
                ${optionEmoji || icons.circle}
              </span>
              <span class="nav-item__text">${resolveChatAgentOptionLabel(agent)}</span>
            </button>
          `;
        },
      )}
    </div>
  `;
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

export function resolveSessionOptions(
  sessionKey: string,
  sessions: SessionsListResult | null,
  mainSessionKey?: string | null,
  opts?: {
    hideCron?: boolean;
    filter?: SessionAgentFilter;
  },
) {
  const hideCron = opts?.hideCron === true;
  const filter = opts?.filter;
  const seen = new Set<string>();
  const options: Array<{ key: string; displayName?: string }> = [];
  const normalizedFilterAgentId =
    typeof filter?.agentId === "string" && filter.agentId.trim()
      ? normalizeAgentId(filter.agentId)
      : "";
  const normalizedDefaultAgentId =
    typeof filter?.defaultAgentId === "string" && filter.defaultAgentId.trim()
      ? normalizeAgentId(filter.defaultAgentId)
      : "main";
  const shouldIncludeKey = (key: string): boolean => {
    if (!normalizedFilterAgentId) {
      return true;
    }
    return sessionBelongsToAgent({
      sessionKey: key,
      agentId: normalizedFilterAgentId,
      defaultAgentId: normalizedDefaultAgentId,
    });
  };

  const resolvedMain = mainSessionKey && sessions?.sessions?.find((s) => s.key === mainSessionKey);
  const resolvedCurrent = sessions?.sessions?.find((s) => s.key === sessionKey);

  // Add main session key first
  if (mainSessionKey && shouldIncludeKey(mainSessionKey)) {
    seen.add(mainSessionKey);
    options.push({
      key: mainSessionKey,
      displayName: resolveSessionDisplayName(mainSessionKey, resolvedMain || undefined),
    });
  }

  // Add current session key next — always include it even if it is hidden by
  // filters, so the active session is never silently dropped from the select.
  if (!seen.has(sessionKey)) {
    seen.add(sessionKey);
    options.push({
      key: sessionKey,
      displayName: resolveSessionDisplayName(sessionKey, resolvedCurrent),
    });
  }

  // Add sessions from the result, optionally filtering out cron sessions.
  if (sessions?.sessions) {
    for (const s of sessions.sessions) {
      if (!shouldIncludeKey(s.key)) {
        continue;
      }
      if (!seen.has(s.key)) {
        if (hideCron && isCronSessionKey(s.key) && s.key !== sessionKey) {
          continue;
        }
        seen.add(s.key);
        options.push({
          key: s.key,
          displayName: resolveSessionDisplayName(s.key, s),
        });
      }
    }
  }

  if (options.length === 0 && sessionKey.trim()) {
    options.push({
      key: sessionKey,
      displayName: resolveSessionDisplayName(sessionKey, resolvedCurrent),
    });
  }

  return options;
}

/** Count sessions with a cron: key that would be hidden when hideCron=true. */
function countHiddenCronSessions(sessionKey: string, sessions: SessionsListResult | null): number {
  if (!sessions?.sessions) {
    return 0;
  }
  // Don't count the currently active session even if it's a cron.
  return sessions.sessions.filter((s) => isCronSessionKey(s.key) && s.key !== sessionKey).length;
}

const THEME_ORDER: ThemeMode[] = ["system", "light", "dark"];

export function renderThemeToggle(state: AppViewState) {
  const index = Math.max(0, THEME_ORDER.indexOf(state.theme));
  const applyTheme = (next: ThemeMode) => (event: MouseEvent) => {
    const element = event.currentTarget as HTMLElement;
    const context: ThemeTransitionContext = { element };
    if (event.clientX || event.clientY) {
      context.pointerClientX = event.clientX;
      context.pointerClientY = event.clientY;
    }
    state.setTheme(next, context);
  };

  return html`
    <div class="theme-toggle" style="--theme-index: ${index};">
      <div class="theme-toggle__track" role="group" aria-label="Theme">
        <span class="theme-toggle__indicator"></span>
        <button
          class="theme-toggle__button ${state.theme === "system" ? "active" : ""}"
          @click=${applyTheme("system")}
          aria-pressed=${state.theme === "system"}
          aria-label="System theme"
          title="System"
        >
          ${renderMonitorIcon()}
        </button>
        <button
          class="theme-toggle__button ${state.theme === "light" ? "active" : ""}"
          @click=${applyTheme("light")}
          aria-pressed=${state.theme === "light"}
          aria-label="Light theme"
          title="Light"
        >
          ${renderSunIcon()}
        </button>
        <button
          class="theme-toggle__button ${state.theme === "dark" ? "active" : ""}"
          @click=${applyTheme("dark")}
          aria-pressed=${state.theme === "dark"}
          aria-label="Dark theme"
          title="Dark"
        >
          ${renderMoonIcon()}
        </button>
      </div>
    </div>
  `;
}

function renderSunIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4"></circle>
      <path d="M12 2v2"></path>
      <path d="M12 20v2"></path>
      <path d="m4.93 4.93 1.41 1.41"></path>
      <path d="m17.66 17.66 1.41 1.41"></path>
      <path d="M2 12h2"></path>
      <path d="M20 12h2"></path>
      <path d="m6.34 17.66-1.41 1.41"></path>
      <path d="m19.07 4.93-1.41 1.41"></path>
    </svg>
  `;
}

function renderMoonIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"
      ></path>
    </svg>
  `;
}

function renderMonitorIcon() {
  return html`
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2"></rect>
      <line x1="8" x2="16" y1="21" y2="21"></line>
      <line x1="12" x2="12" y1="17" y2="21"></line>
    </svg>
  `;
}
