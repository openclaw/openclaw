// Control UI module implements app render behavior.
import { html, nothing } from "lit";
import type { SessionsListResult } from "../api/types.ts";
import {
  isSettingsNavigationRoute,
  navigationIconForRoute,
  titleForRoute,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-routes.ts";
import { normalizeChatAutoScrollMode, type ChatAutoScrollMode } from "../app/settings.ts";
import { icons } from "../components/icons.ts";
import "../components/tooltip.ts";
import { t } from "../i18n/index.ts";
import {
  isCronSessionKey,
  parseSessionKey,
  resolveSessionDisplayName,
} from "../lib/session-display.ts";
import {
  areUiSessionKeysEquivalent,
  isSessionKeyTiedToAgent,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../lib/string-coerce.ts";
import { refreshChat } from "../pages/chat/data.ts";
import { createChatSessionsLoadOverrides } from "../pages/chat/session-scope.ts";
import {
  resetChatStateForSessionSwitch,
  switchChatSession,
  switchChatSessionAndWait,
} from "../pages/chat/session-switch.ts";
import { hasOperatorAdminAccess } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import {
  renderChatSessionSelect as renderChatSessionSelectBase,
  renderChatModelSelect,
  renderChatQuotaPill,
  resolveSessionOptionGroups,
} from "./chat/session-controls.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";

export { isCronSessionKey, parseSessionKey, resolveSessionDisplayName, resolveSessionOptionGroups };
export { switchChatSession, switchChatSessionAndWait };

type SessionDefaultsSnapshot = {
  mainSessionKey?: string;
  mainKey?: string;
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

/**
 * Whether the operator terminal surface (toolbar toggle + dock) should render.
 *
 * The terminal is an admin-only host shell, so availability must track a *live,
 * admin* connection — not just `terminal.open` appearing in `features.methods`,
 * which is the server-wide catalog and stays populated from a stale `hello`
 * while the client auto-reconnects. Requiring `connected` also lets the panel's
 * own `available` teardown fire on disconnect (the gateway kills that
 * connection's PTYs), so the UI never keeps tabs pointing at dead sessions.
 */
export function isTerminalAvailable(
  state: Pick<AppViewState, "connected" | "terminalEnabled" | "hello">,
): boolean {
  if (!state.connected || !state.terminalEnabled) {
    return false;
  }
  const auth =
    (state.hello as { auth?: { role?: string; scopes?: string[] } } | null)?.auth ?? null;
  return hasOperatorAdminAccess(auth) && isGatewayMethodAdvertised(state, "terminal.open") === true;
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

const ROUTE_PRELOAD_DELAY_MS = 50;
const routePreloadTimers = new WeakMap<EventTarget, ReturnType<typeof setTimeout>>();

export function renderRouteNavItem(
  state: AppViewState,
  routeId: RouteId,
  opts?: {
    activeRouteId?: RouteId;
    collapsed?: boolean;
    onNavigate?: (routeId: RouteId) => void;
    preloadRoute?: (routeId: RouteId) => Promise<void>;
  },
) {
  const href = pathForRoute(routeId, state.basePath);
  const activeRouteId = opts?.activeRouteId;
  const isActive =
    routeId === "config"
      ? activeRouteId !== undefined && isSettingsNavigationRoute(activeRouteId)
      : activeRouteId === routeId;
  const collapsed = opts?.collapsed ?? state.settings.navCollapsed;
  const preload = (event: Event, immediate = false) => {
    if (isActive) {
      return;
    }
    const target = event.currentTarget;
    if (!target) {
      return;
    }
    const start = () => {
      routePreloadTimers.delete(target);
      void opts?.preloadRoute?.(routeId).catch(() => undefined);
    };
    if (immediate) {
      start();
      return;
    }
    if (!routePreloadTimers.has(target)) {
      routePreloadTimers.set(target, globalThis.setTimeout(start, ROUTE_PRELOAD_DELAY_MS));
    }
  };
  const cancelPreload = (event: Event) => {
    const target = event.currentTarget;
    if (!target) {
      return;
    }
    const timer = routePreloadTimers.get(target);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      routePreloadTimers.delete(target);
    }
  };
  const routeTitle = titleForRoute(routeId);
  const navItem = html`
    <a
      href=${href}
      class="nav-item ${isActive ? "nav-item--active" : ""}"
      @focus=${preload}
      @blur=${cancelPreload}
      @pointerenter=${preload}
      @pointerleave=${cancelPreload}
      @touchstart=${(event: TouchEvent) => preload(event, true)}
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
        if (routeId === "chat") {
          if (!state.sessionKey) {
            const mainSessionKey = resolveSidebarChatSessionKey(state);
            resetChatStateForSessionSwitch(state, mainSessionKey);
          }
          if (activeRouteId !== undefined && activeRouteId !== "chat") {
            void state.loadAssistantIdentity();
          }
        }
        opts?.onNavigate?.(routeId);
      }}
    >
      <span class="nav-item__icon" aria-hidden="true"
        >${icons[navigationIconForRoute(routeId)]}</span
      >
      ${!collapsed ? html`<span class="nav-item__text">${routeTitle}</span>` : nothing}
    </a>
  `;
  return collapsed
    ? html`<openclaw-tooltip .content=${routeTitle}>${navItem}</openclaw-tooltip>`
    : navItem;
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
  return renderChatSessionSelectBase(state, switchChatSession, { surface: "desktop" });
}

function chatAutoScrollLabel(mode: ChatAutoScrollMode) {
  switch (mode) {
    case "always":
      return t("chat.autoScrollAlways");
    case "off":
      return t("chat.autoScrollOff");
    case "near-bottom":
      return t("chat.autoScrollNearBottom");
  }
  return t("chat.autoScrollNearBottom");
}

function nextChatAutoScrollMode(mode: ChatAutoScrollMode): ChatAutoScrollMode {
  switch (mode) {
    case "near-bottom":
      return "always";
    case "always":
      return "off";
    case "off":
      return "near-bottom";
  }
  return "near-bottom";
}

function renderChatAutoScrollToggle(state: AppViewState, options: { labelled?: boolean } = {}) {
  const mode = normalizeChatAutoScrollMode(state.settings.chatAutoScroll);
  const label = `${t("chat.autoScrollMode")}: ${chatAutoScrollLabel(mode)}`;
  const active = mode !== "off";
  return html`
    <openclaw-tooltip .content=${label}>
      <button
        class="btn btn--sm btn--icon ${options.labelled ? "chat-settings-action" : ""} ${active
          ? "active"
          : ""}"
        data-chat-auto-scroll-toggle="true"
        data-chat-auto-scroll-mode=${mode}
        aria-label=${label}
        aria-pressed=${active}
        @click=${() => {
          state.applySettings({
            ...state.settings,
            chatAutoScroll: nextChatAutoScrollMode(mode),
          });
        }}
      >
        ${icons.scrollText}
        ${options.labelled
          ? html`<span class="chat-settings-action__text">${t("chat.autoScrollMode")}</span>`
          : ""}
      </button>
    </openclaw-tooltip>
  `;
}

export function renderChatControls(state: AppViewState, onNavigate?: (routeId: RouteId) => void) {
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron ? countHiddenCronSessions(state, state.sessionsResult) : 0;
  const disableThinkingToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const persistCommentary = state.settings.chatPersistCommentary === true;
  const thinkingLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.thinkingToggle");
  const toolCallsLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.toolCallsToggle");
  const commentaryLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.commentaryToggle");
  const refreshDisabled =
    !state.connected ||
    state.chatManualRefreshInFlight ||
    state.chatLoading ||
    state.chatSending ||
    state.chatStream !== null ||
    Boolean(state.chatRunId);
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
  const settingsOpen = state.chatMobileControlsOpen;
  const settingsLabel = t("chat.settings");
  const settingsTitle = t("chat.settings");

  return html`
    <div
      class="chat-composer-model-control"
      @click=${() => {
        if (state.chatMobileControlsOpen) {
          state.setChatMobileControlsOpen(false);
        }
      }}
    >
      ${renderChatModelSelect(state)}
    </div>
    ${renderChatQuotaPill(state, onNavigate)}
    <div class="chat-settings-popover-wrapper">
      <openclaw-tooltip .content=${settingsTitle}>
        <button
          class="chat-settings-chip ${settingsOpen ? "chat-settings-chip--open" : ""}"
          type="button"
          aria-label=${settingsTitle}
          aria-expanded=${settingsOpen}
          aria-controls="chat-composer-settings-popover"
          @click=${(e: Event) => {
            e.stopPropagation();
            (e.currentTarget as HTMLElement)
              .closest(".agent-chat__composer-controls")
              ?.querySelectorAll("details.chat-controls__inline-select[open]")
              .forEach((details) => details.removeAttribute("open"));
            state.setChatMobileControlsOpen(!settingsOpen, {
              trigger: e.currentTarget as HTMLElement,
            });
          }}
        >
          <span class="chat-settings-chip__icon">${icons.settings}</span>
          <span class="chat-settings-chip__text">${settingsLabel}</span>
          <span class="chat-settings-chip__chevron">${icons.chevronDown}</span>
        </button>
      </openclaw-tooltip>
      <div
        id="chat-composer-settings-popover"
        class="chat-settings-popover ${settingsOpen ? "chat-settings-popover--open" : ""}"
        role="dialog"
        aria-label=${settingsTitle}
      >
        <div class="chat-settings-popover__section">
          <span class="chat-settings-popover__label">${settingsLabel}</span>
          <div class="chat-settings-popover__toggles">
            <openclaw-tooltip .content=${t("common.refresh")}>
              <button
                class="btn btn--sm btn--icon chat-settings-action"
                ?disabled=${refreshDisabled}
                @click=${() => {
                  if (!refreshDisabled) {
                    void handleChatManualRefresh(state as ChatRefreshHost);
                  }
                }}
                aria-label=${t("common.refresh")}
              >
                ${icons.refresh}
                <span class="chat-settings-action__text">${t("common.refresh")}</span>
              </button>
            </openclaw-tooltip>
            ${renderChatAutoScrollToggle(state, { labelled: true })}
            <openclaw-tooltip .content=${thinkingLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${showThinking ? "active" : ""}"
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
                aria-label=${thinkingLabel}
              >
                ${icons.brain}
                <span class="chat-settings-action__text">${t("cron.form.thinking")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${toolCallsLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${showToolCalls ? "active" : ""}"
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
                aria-label=${toolCallsLabel}
              >
                ${toolCallsIcon}
                <span class="chat-settings-action__text">${t("agents.tabs.tools")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${commentaryLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${persistCommentary
                  ? "active"
                  : ""}"
                ?disabled=${disableThinkingToggle}
                @click=${() => {
                  if (disableThinkingToggle) {
                    return;
                  }
                  state.applySettings({
                    ...state.settings,
                    chatPersistCommentary: !persistCommentary,
                  });
                }}
                aria-pressed=${persistCommentary}
                aria-label=${commentaryLabel}
              >
                ${persistCommentary ? icons.pin : icons.pinOff}
                <span class="chat-settings-action__text">${t("chat.commentaryLabel")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${cronLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${hideCron ? "active" : ""}"
                @click=${() => {
                  state.sessionsHideCron = !hideCron;
                }}
                aria-pressed=${hideCron}
                aria-label=${cronLabel}
              >
                ${renderCronFilterIcon(hiddenCronCount)}
                <span class="chat-settings-action__text">${t("cron.jobList.history")}</span>
              </button>
            </openclaw-tooltip>
          </div>
        </div>
      </div>
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
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const persistCommentary = state.settings.chatPersistCommentary === true;
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

  return html`
    <div class="chat-mobile-controls-wrapper">
      <openclaw-tooltip .content=${t("chat.settings")}>
        <button
          class="btn btn--sm btn--icon chat-controls-mobile-toggle"
          @click=${(e: Event) => {
            e.stopPropagation();
            state.setChatMobileControlsOpen(!mobileControlsOpen, {
              trigger: e.currentTarget as HTMLElement,
            });
          }}
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
      </openclaw-tooltip>
      <div
        id=${controlsDropdownId}
        class="chat-controls-dropdown ${mobileControlsOpen ? "open" : ""}"
        @click=${(e: Event) => {
          e.stopPropagation();
        }}
      >
        <div class="chat-controls">
          ${renderChatSessionSelectBase(state, switchChatSession, { surface: "mobile" })}
          <div class="chat-controls__thinking">
            ${renderChatAutoScrollToggle(state)}
            <openclaw-tooltip .content=${t("chat.thinkingToggle")}>
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
                aria-label=${t("chat.thinkingToggle")}
              >
                ${icons.brain}
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${t("chat.toolCallsToggle")}>
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
                aria-label=${t("chat.toolCallsToggle")}
              >
                ${toolCallsIcon}
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${t("chat.commentaryToggle")}>
              <button
                class="btn btn--sm btn--icon ${persistCommentary ? "active" : ""}"
                ?disabled=${disableThinkingToggle}
                @click=${() => {
                  if (!disableThinkingToggle) {
                    state.applySettings({
                      ...state.settings,
                      chatPersistCommentary: !persistCommentary,
                    });
                  }
                }}
                aria-pressed=${persistCommentary}
                aria-label=${t("chat.commentaryToggle")}
              >
                ${persistCommentary ? icons.pin : icons.pinOff}
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip
              .content=${hideCron
                ? hiddenCronCount > 0
                  ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
                  : t("chat.showCronSessions")
                : t("chat.hideCronSessions")}
            >
              <button
                class="btn btn--sm btn--icon ${hideCron ? "active" : ""}"
                @click=${() => {
                  state.sessionsHideCron = !hideCron;
                }}
                aria-pressed=${hideCron}
                aria-label=${hideCron
                  ? hiddenCronCount > 0
                    ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
                    : t("chat.showCronSessions")
                  : t("chat.hideCronSessions")}
              >
                ${renderCronFilterIcon(hiddenCronCount)}
              </button>
            </openclaw-tooltip>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function isCurrentChatSessionArchived(state: AppViewState): boolean {
  if (state.selectedChatSessionArchived === true) {
    return true;
  }
  return [
    ...(state.sessionsResult?.sessions ?? []),
    ...Object.values(state.chatAgentSessionRowsByAgent ?? {}).flat(),
  ].some(
    (row) => row.archived === true && areUiSessionKeysEquivalent(row.key, state.sessionKey),
  );
}

export function dismissRealtimeTalkError(state: AppViewState) {
  if (state.realtimeTalkStatus !== "error") {
    return;
  }
  const talkHost = state as unknown as {
    realtimeTalkSession?: { stop(): void } | null;
  };
  talkHost.realtimeTalkSession?.stop();
  talkHost.realtimeTalkSession = null;
  state.realtimeTalkActive = false;
  state.realtimeTalkStatus = "idle";
  state.realtimeTalkDetail = null;
  state.realtimeTalkTranscript = null;
  state.resetRealtimeTalkConversation?.();
}

export function dismissChatError(state: AppViewState) {
  state.lastError = null;
  state.lastErrorCode = null;
  state.chatError = null;
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

  return sessions.sessions.filter(
    (s) =>
      isCronSessionKey(s.key) &&
      s.key !== state.sessionKey &&
      isSessionKeyTiedToAgent(s.key, activeAgentId, defaultAgentId),
  ).length;
}
