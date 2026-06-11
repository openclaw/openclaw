import { html, nothing } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { t } from "../i18n/index.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { hasAbortableSessionRun, refreshChat } from "./app-chat.ts";
import {
  renderTab,
  resolveAssistantAttachmentAuthToken,
  resolveDashboardHeaderContext,
  renderSidebarConnectionStatus,
  renderTopbarThemeModeToggle,
  createChatSession,
  dismissChatError,
  switchChatSession,
} from "./app-render.helpers.ts";
import { warnQueryToken } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import { setAssistantAvatarOverride } from "./controllers/assistant-identity.ts";
import { loadChannels } from "./controllers/channels.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import {
  applyConfig,
  loadConfig,
  openConfigFile,
  resetConfigPendingChanges,
  runUpdate,
  saveConfig,
  stageConfigPreset,
  updateConfigFormValue,
  removeConfigFormValue,
} from "./controllers/config.ts";
import { loadDebug, callDebugMethod } from "./controllers/debug.ts";
import {
  approveDevicePairing,
  loadDevices,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./controllers/devices.ts";
import {
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./controllers/exec-approvals.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadNodes } from "./controllers/nodes.ts";
import { loadPresence } from "./controllers/presence.ts";
import {
  branchSessionFromCheckpoint,
  deleteSessionsAndRefresh,
  loadSessions,
  patchSession,
  restoreSessionFromCheckpoint,
  toggleSessionCompactionCheckpoints,
} from "./controllers/sessions.ts";
import {
  closeClawHubDetail,
  installFromClawHub,
  installSkill,
  loadClawHubDetail,
  loadSkills,
  saveSkillApiKey,
  searchClawHub,
  setClawHubSearchQuery,
  updateSkillEdit,
  updateSkillEnabled,
} from "./controllers/skills.ts";
import { resolveConfiguredDreaming } from "./dreaming-config.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "./external-link.ts";
import { icons } from "./icons.ts";
import { createLazyView, renderLazyView } from "./lazy-view.ts";
import {
  normalizeBasePath,
  TAB_GROUPS,
  subtitleForTab,
  titleForTab,
  type Tab,
} from "./navigation.ts";
import { buildAgentMainSessionKey, parseAgentSessionKey } from "./session-key.ts";
import "./components/dashboard-header.ts";
import { loadLocalAssistantIdentity } from "./storage.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import { isRenderableControlUiAvatarUrl } from "./views/agents-utils.ts";
import { renderCommandPalette } from "./views/command-palette.ts";
import { renderDreamingRestartConfirmation } from "./views/dreaming-restart-confirmation.ts";
import { renderExecApprovalPrompt } from "./views/exec-approval.ts";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation.ts";
import {
  renderConnectionLoader,
  renderLoginGate,
  shouldShowConnectionLoader,
} from "./views/login-gate.ts";
import { renderOverview } from "./views/overview.ts";

let _pendingUpdate: (() => void) | undefined;

const notifyLazyViewChanged = () => _pendingUpdate?.();

// Lazy-loaded view modules are deferred so the initial bundle stays small.
// The shared loader renders visible fallback states instead of leaving a tab blank.
const lazyChannels = createLazyView(() => import("./views/channels.ts"), notifyLazyViewChanged);
const lazyChat = createLazyView(() => import("./views/chat.ts"), notifyLazyViewChanged);
const lazyConfig = createLazyView(
  () => import("./app-render-config-tab.ts"),
  notifyLazyViewChanged,
);
const lazyCron = createLazyView(() => import("./app-render-cron-tab.ts"), notifyLazyViewChanged);
const lazyDebug = createLazyView(() => import("./views/debug.ts"), notifyLazyViewChanged);
const lazyDreaming = createLazyView(
  () => import("./app-render-dreaming-tab.ts"),
  notifyLazyViewChanged,
);
const lazyAppStudio = createLazyView(
  () => import("./views/app-studio-dashboard.ts"),
  notifyLazyViewChanged,
);
const lazyInstances = createLazyView(() => import("./views/instances.ts"), notifyLazyViewChanged);
const lazyKalshi = createLazyView(
  () => import("./views/kalshi-dashboard.ts"),
  notifyLazyViewChanged,
);
const lazyBookWriter = createLazyView(
  () => import("./views/book-writer-dashboard.ts"),
  notifyLazyViewChanged,
);
const lazyLogs = createLazyView(() => import("./views/logs.ts"), notifyLazyViewChanged);
const lazyNodes = createLazyView(() => import("./views/nodes.ts"), notifyLazyViewChanged);
const lazyPatternLab = createLazyView(
  () => import("./views/pattern-lab-dashboard.ts"),
  notifyLazyViewChanged,
);
const lazyMusicStudio = createLazyView(
  () => import("./views/music-studio.ts"),
  notifyLazyViewChanged,
);
const lazySnesStudio = createLazyView(
  () => import("./views/snes-studio.ts"),
  notifyLazyViewChanged,
);
const lazyProjects = createLazyView(
  () => import("./app-render-projects-tab.ts"),
  notifyLazyViewChanged,
);
const lazySessions = createLazyView(() => import("./views/sessions.ts"), notifyLazyViewChanged);
const lazySkills = createLazyView(() => import("./views/skills.ts"), notifyLazyViewChanged);
const lazyUsage = createLazyView(() => import("./app-render-usage-tab.ts"), notifyLazyViewChanged);
const lazyAgents = createLazyView(
  () => import("./app-render-agents-tab.ts"),
  notifyLazyViewChanged,
);
const lazyChatControls = createLazyView(
  () => import("./app-render-chat-controls.ts"),
  notifyLazyViewChanged,
);

function renderSidebarBrandLogo() {
  return html`
    <span class="sidebar-brand__logo" role="img" aria-label="OpenClaw">
      <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="openclaw-sidebar-logo-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#ff5a5f" />
            <stop offset="100%" stop-color="#b91c1c" />
          </linearGradient>
        </defs>
        <path
          d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"
          fill="url(#openclaw-sidebar-logo-gradient)"
        />
        <path
          d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"
          fill="url(#openclaw-sidebar-logo-gradient)"
        />
        <path
          d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"
          fill="url(#openclaw-sidebar-logo-gradient)"
        />
        <path
          d="M45 15 Q35 5 30 8 M75 15 Q85 5 90 8"
          stroke="#ff6b6b"
          stroke-width="3"
          stroke-linecap="round"
        />
        <circle cx="45" cy="35" r="6" fill="#050810" />
        <circle cx="75" cy="35" r="6" fill="#050810" />
        <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
        <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />
      </svg>
    </span>
  `;
}

function renderLazyInline<M>(view: { read: () => M | null }, render: (mod: M) => unknown) {
  const mod = view.read();
  return mod === null ? nothing : render(mod);
}

let clawhubSearchTimer: ReturnType<typeof setTimeout> | null = null;

const UPDATE_BANNER_DISMISS_KEY = "openclaw:control-ui:update-banner-dismissed:v1";

type DismissedUpdateBanner = {
  latestVersion: string;
  channel: string | null;
  dismissedAtMs: number;
};

function loadDismissedUpdateBanner(): DismissedUpdateBanner | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(UPDATE_BANNER_DISMISS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DismissedUpdateBanner>;
    if (!parsed || typeof parsed.latestVersion !== "string") {
      return null;
    }
    return {
      latestVersion: parsed.latestVersion,
      channel: typeof parsed.channel === "string" ? parsed.channel : null,
      dismissedAtMs: typeof parsed.dismissedAtMs === "number" ? parsed.dismissedAtMs : Date.now(),
    };
  } catch {
    return null;
  }
}

function isUpdateBannerDismissed(updateAvailable: unknown): boolean {
  const dismissed = loadDismissedUpdateBanner();
  if (!dismissed) {
    return false;
  }
  const info = updateAvailable as { latestVersion?: unknown; channel?: unknown };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  return Boolean(
    latestVersion && dismissed.latestVersion === latestVersion && dismissed.channel === channel,
  );
}

function dismissUpdateBanner(updateAvailable: unknown) {
  const info = updateAvailable as { latestVersion?: unknown; channel?: unknown };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  if (!latestVersion) {
    return;
  }
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  const payload: DismissedUpdateBanner = {
    latestVersion,
    channel,
    dismissedAtMs: Date.now(),
  };
  try {
    getSafeLocalStorage()?.setItem(UPDATE_BANNER_DISMISS_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) {
    return undefined;
  }
  if (isRenderableControlUiAvatarUrl(candidate)) {
    return candidate;
  }
  return undefined;
}

function buildAssistantAvatarRoute(basePathValue: string | null | undefined, agentId: string) {
  const basePath = normalizeBasePath(basePathValue ?? "");
  const encoded = encodeURIComponent(agentId);
  return basePath ? `${basePath}/avatar/${encoded}` : `/avatar/${encoded}`;
}

export function extractQuickSettingsSecurity(state: AppViewState): {
  gatewayAuth: string;
  execPolicy: string;
  deviceAuth: boolean;
} {
  const config = state.configForm ?? state.configSnapshot?.config;
  if (!config || typeof config !== "object") {
    return { gatewayAuth: "unknown", execPolicy: "unknown", deviceAuth: false };
  }
  const cfg = config;
  const gateway =
    "gateway" in cfg && cfg.gateway && typeof cfg.gateway === "object"
      ? (cfg.gateway as Record<string, unknown>)
      : null;
  const auth =
    gateway && "auth" in gateway && gateway.auth && typeof gateway.auth === "object"
      ? (gateway.auth as Record<string, unknown>)
      : null;
  let gatewayAuth = "unknown";
  if (auth) {
    const mode = typeof auth.mode === "string" ? auth.mode.trim() : "";
    if (mode) {
      gatewayAuth = mode;
    } else if (auth.password) {
      gatewayAuth = "password";
    } else if (auth.token) {
      gatewayAuth = "token";
    } else if (auth.trustedProxy) {
      gatewayAuth = "trusted-proxy";
    } else {
      gatewayAuth = "none";
    }
  }
  let execPolicy = "allowlist";
  const tools = cfg.tools;
  if (tools && typeof tools === "object") {
    const exec = (tools as Record<string, unknown>).exec;
    if (exec && typeof exec === "object") {
      const security = (exec as Record<string, unknown>).security;
      if (typeof security === "string" && security.trim()) {
        execPolicy = security.trim();
      }
    }
  }
  let deviceAuth = true;
  if (gateway) {
    const controlUi =
      "controlUi" in gateway && gateway.controlUi && typeof gateway.controlUi === "object"
        ? (gateway.controlUi as Record<string, unknown>)
        : null;
    if (controlUi?.dangerouslyDisableDeviceAuth === true) {
      deviceAuth = false;
    }
  }
  return { gatewayAuth, execPolicy, deviceAuth };
}

function resolveQuickSettingsSessionRow(state: AppViewState) {
  return state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
}

export function renderApp(state: AppViewState) {
  const updatableState = state as AppViewState & { requestUpdate?: () => void };
  const requestHostUpdate =
    typeof updatableState.requestUpdate === "function"
      ? () => updatableState.requestUpdate?.()
      : undefined;
  _pendingUpdate = requestHostUpdate;

  // Gate: require successful gateway connection before showing the dashboard.
  // Local-first creative studios must remain usable before Gateway auth.
  // The gateway URL confirmation overlay is always rendered so URL-param flows still work.
  if (!state.connected && state.tab !== "snesStudio" && state.tab !== "musicStudio") {
    const gate = shouldShowConnectionLoader(state)
      ? renderConnectionLoader(state)
      : renderLoginGate(state);
    return html` ${gate} ${renderGatewayUrlConfirmation(state)} `;
  }

  const presenceCount = state.presenceEntries.length;
  const sessionsCount = state.sessionsResult?.count ?? null;
  const cronNext = state.cronStatus?.nextWakeAtMs ?? null;
  const chatDisabledReason = state.connected ? null : t("chat.disconnected");
  const isChat = state.tab === "chat";
  const shouldShowHeaderError = Boolean(
    state.lastError &&
    !((state.tab === "snesStudio" || state.tab === "musicStudio") && !state.connected),
  );
  const chatFocus = isChat && (state.settings.chatFocusMode || state.onboarding);
  const navDrawerOpen = state.navDrawerOpen && !chatFocus && !state.onboarding;
  const navCollapsed = state.settings.navCollapsed && !navDrawerOpen;
  const dashboardHeaderContext = resolveDashboardHeaderContext(state);
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const localAssistantAvatarOverride =
    normalizeOptionalString(loadLocalAssistantIdentity().avatar) ?? null;
  const assistantAvatarUrl = resolveAssistantAvatarUrl(state);
  const chatAssistantAvatarStatus = localAssistantAvatarOverride
    ? "data"
    : (state.chatAvatarStatus ?? state.assistantAvatarStatus ?? null);
  const chatAssistantAvatarReason = localAssistantAvatarOverride
    ? null
    : (state.chatAvatarReason ?? state.assistantAvatarReason ?? null);
  const chatAssistantAvatarMissing =
    chatAssistantAvatarStatus === "none" && chatAssistantAvatarReason === "missing";
  const effectiveAssistantAvatar =
    localAssistantAvatarOverride ?? (chatAssistantAvatarMissing ? null : state.assistantAvatar);
  const chatAvatarUrl =
    localAssistantAvatarOverride ??
    state.chatAvatarUrl ??
    (chatAssistantAvatarMissing ? null : (assistantAvatarUrl ?? null));
  const configAssistantAvatarStatus = localAssistantAvatarOverride
    ? "data"
    : (state.assistantAvatarStatus ?? state.chatAvatarStatus ?? null);
  const configAssistantAvatarReason = localAssistantAvatarOverride
    ? null
    : (state.assistantAvatarReason ?? state.chatAvatarReason ?? null);
  const configAssistantAvatarSource =
    localAssistantAvatarOverride ?? state.assistantAvatarSource ?? state.chatAvatarSource ?? null;
  const configAssistantAvatarMissing =
    configAssistantAvatarStatus === "none" && configAssistantAvatarReason === "missing";
  const configAssistantAvatar =
    localAssistantAvatarOverride ??
    (configAssistantAvatarMissing || configAssistantAvatarStatus === "local"
      ? null
      : state.assistantAvatar);
  const configAssistantAvatarUrl =
    localAssistantAvatarOverride ??
    (configAssistantAvatarStatus === "local" && state.assistantAgentId
      ? buildAssistantAvatarRoute(state.basePath, state.assistantAgentId)
      : (state.chatAvatarUrl ??
        (configAssistantAvatarMissing ? null : (assistantAvatarUrl ?? null))));
  const configValue =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const configuredDreaming = resolveConfiguredDreaming(configValue);
  const dreamingOn = state.dreamingStatus?.enabled ?? configuredDreaming.enabled;
  const dreamingLoading = state.dreamingStatusLoading || state.dreamingModeSaving;
  const dreamingRefreshLoading = state.dreamingStatusLoading || state.dreamDiaryLoading;
  const refreshDreaming = () => {
    void import("./app-render-dreaming-tab.ts").then((m) => m.refreshDreaming(state));
  };
  const applyDreamingEnabled = (enabled: boolean) => {
    if (
      state.dreamingModeSaving ||
      state.dreamingRestartConfirmLoading ||
      state.dreamingRestartConfirmOpen ||
      dreamingOn === enabled
    ) {
      return;
    }
    state.dreamingPendingEnabled = enabled;
    state.dreamingRestartConfirmOpen = true;
    state.dreamingStatusError = null;
    requestHostUpdate?.();
  };
  const cancelDreamingRestart = () => {
    if (state.dreamingRestartConfirmLoading) {
      return;
    }
    state.dreamingRestartConfirmOpen = false;
    state.dreamingPendingEnabled = null;
    state.dreamingStatusError = null;
  };
  const confirmDreamingRestart = () => {
    const enabled = state.dreamingPendingEnabled;
    if (enabled == null || state.dreamingRestartConfirmLoading) {
      return;
    }
    void (async () => {
      state.dreamingRestartConfirmLoading = true;
      state.dreamingStatusError = null;
      try {
        await import("./app-render-dreaming-tab.ts").then((m) =>
          m.confirmDreamingRestart(state, enabled),
        );
      } finally {
        state.dreamingRestartConfirmLoading = false;
      }
    })();
  };
  const basePath = normalizeBasePath(state.basePath ?? "");
  const resolvedAgentId =
    state.agentsSelectedId ??
    state.agentsList?.defaultId ??
    state.agentsList?.agents?.[0]?.id ??
    null;
  const renderConfigTabForActiveTab = () =>
    renderLazyView(lazyConfig, (m) =>
      m.renderConfigTabForActiveTab(state, {
        requestHostUpdate,
        localAssistantAvatarOverride,
        configAssistantAvatar,
        configAssistantAvatarUrl,
        configAssistantAvatarSource,
        configAssistantAvatarStatus,
        configAssistantAvatarReason,
      }),
    );

  return html`
    ${renderCommandPalette({
      open: state.paletteOpen,
      query: state.paletteQuery,
      activeIndex: state.paletteActiveIndex,
      onToggle: () => {
        state.paletteOpen = !state.paletteOpen;
      },
      onQueryChange: (q) => {
        state.paletteQuery = q;
      },
      onActiveIndexChange: (i) => {
        state.paletteActiveIndex = i;
      },
      onNavigate: (tab) => {
        state.setTab(tab as import("./navigation.ts").Tab);
      },
      onSlashCommand: (cmd) => {
        state.setTab("chat" as import("./navigation.ts").Tab);
        state.handleChatDraftChange(cmd.endsWith(" ") ? cmd : `${cmd} `);
      },
    })}
    <div
      class="shell ${isChat ? "shell--chat" : ""} ${chatFocus
        ? "shell--chat-focus"
        : ""} ${navCollapsed ? "shell--nav-collapsed" : ""} ${navDrawerOpen
        ? "shell--nav-drawer-open"
        : ""} ${state.onboarding ? "shell--onboarding" : ""}"
      style=${styleMap(
        state.chatMessageMaxWidth ? { "--chat-message-max-width": state.chatMessageMaxWidth } : {},
      )}
    >
      <button
        type="button"
        class="shell-nav-backdrop"
        aria-label="${t("nav.collapse")}"
        @click=${() => {
          state.navDrawerOpen = false;
        }}
      ></button>
      <header class="topbar">
        <div class="topnav-shell">
          <button
            type="button"
            class="sidebar-menu-trigger topbar-nav-toggle"
            @click=${() => {
              state.navDrawerOpen = !navDrawerOpen;
            }}
            title="${navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-label="${navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-expanded=${navDrawerOpen}
          >
            <span class="nav-collapse-toggle__icon" aria-hidden="true">${icons.menu}</span>
          </button>
          <div class="topnav-shell__content">
            <dashboard-header
              .tab=${state.tab}
              .basePath=${state.basePath}
              .agentLabel=${dashboardHeaderContext.agentLabel}
              @navigate=${(event: CustomEvent<Tab>) => {
                state.setTab(event.detail);
              }}
            ></dashboard-header>
          </div>
          <div class="topnav-shell__actions">
            <button
              class="topbar-search"
              @click=${() => {
                state.paletteOpen = !state.paletteOpen;
              }}
              title=${t("chat.commandPaletteTitle")}
              aria-label=${t("chat.openCommandPalette")}
            >
              <span class="topbar-search__label">${t("common.search")}</span>
              <kbd class="topbar-search__kbd">⌘K</kbd>
            </button>
            <div class="topbar-status">
              ${isChat
                ? renderLazyInline(lazyChatControls, (m) => m.renderChatMobileToggle(state))
                : nothing}
              ${renderTopbarThemeModeToggle(state)}
            </div>
          </div>
        </div>
      </header>
      <div class="shell-nav">
        <aside class="sidebar ${navCollapsed ? "sidebar--collapsed" : ""}">
          <div class="sidebar-shell">
            <div class="sidebar-shell__header">
              <div class="sidebar-brand">
                ${navCollapsed
                  ? nothing
                  : html`
                      ${renderSidebarBrandLogo()}
                      <span class="sidebar-brand__copy">
                        <span class="sidebar-brand__eyebrow">${t("nav.control")}</span>
                        <span class="sidebar-brand__title">OpenClaw</span>
                      </span>
                    `}
              </div>
              <button
                type="button"
                class="nav-collapse-toggle"
                @click=${() =>
                  state.applySettings({
                    ...state.settings,
                    navCollapsed: !state.settings.navCollapsed,
                  })}
                title="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
                aria-label="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
              >
                <span class="nav-collapse-toggle__icon" aria-hidden="true"
                  >${navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}</span
                >
              </button>
            </div>
            <div class="sidebar-shell__body">
              <nav class="sidebar-nav">
                ${TAB_GROUPS.map((group) => {
                  const isGroupCollapsed = state.settings.navGroupsCollapsed[group.label] ?? false;
                  const hasActiveTab = group.tabs.some((tab) => tab === state.tab);
                  const showItems = navCollapsed || hasActiveTab || !isGroupCollapsed;

                  return html`
                    <section class="nav-section ${!showItems ? "nav-section--collapsed" : ""}">
                      ${!navCollapsed
                        ? html`
                            <button
                              class="nav-section__label"
                              @click=${() => {
                                const next = { ...state.settings.navGroupsCollapsed };
                                next[group.label] = !isGroupCollapsed;
                                state.applySettings({
                                  ...state.settings,
                                  navGroupsCollapsed: next,
                                });
                              }}
                              aria-expanded=${showItems}
                            >
                              <span class="nav-section__label-text"
                                >${t(`nav.${group.label}`)}</span
                              >
                              <span class="nav-section__chevron"> ${icons.chevronDown} </span>
                            </button>
                          `
                        : nothing}
                      <div class="nav-section__items">
                        ${group.tabs.map((tab) =>
                          renderTab(state, tab, { collapsed: navCollapsed }),
                        )}
                      </div>
                    </section>
                  `;
                })}
              </nav>
            </div>
            <div class="sidebar-shell__footer">
              <div class="sidebar-utility-group">
                <a
                  class="nav-item nav-item--external sidebar-utility-link"
                  href="https://docs.openclaw.ai"
                  target=${EXTERNAL_LINK_TARGET}
                  rel=${buildExternalLinkRel()}
                  title=${t("chat.docsOpensInNewTab", { label: t("common.docs") })}
                >
                  <span class="nav-item__icon" aria-hidden="true">${icons.book}</span>
                  ${!navCollapsed
                    ? html`
                        <span class="nav-item__text">${t("common.docs")}</span>
                        <span class="nav-item__external-icon">${icons.externalLink}</span>
                      `
                    : nothing}
                </a>
                <div class="sidebar-mode-switch">${renderTopbarThemeModeToggle(state)}</div>
                ${(() => {
                  const version = state.hello?.server?.version ?? "";
                  return version
                    ? html`
                        <div class="sidebar-version" title=${`v${version}`}>
                          ${!navCollapsed
                            ? html`
                                <span class="sidebar-version__label">${t("common.version")}</span>
                                <span class="sidebar-version__text">v${version}</span>
                                ${renderSidebarConnectionStatus(state)}
                              `
                            : html` ${renderSidebarConnectionStatus(state)} `}
                        </div>
                      `
                    : nothing;
                })()}
              </div>
            </div>
          </div>
        </aside>
      </div>
      <main class="content ${isChat ? "content--chat" : ""}">
        ${state.updateStatusBanner
          ? html`<div class="callout ${state.updateStatusBanner.tone}" role="alert">
              ${state.updateStatusBanner.text}
            </div>`
          : nothing}
        ${state.updateAvailable &&
        state.updateAvailable.latestVersion !== state.updateAvailable.currentVersion &&
        !isUpdateBannerDismissed(state.updateAvailable)
          ? html`<div class="update-banner callout danger" role="alert">
              <strong>${t("chat.updateAvailable")}</strong> v${state.updateAvailable.latestVersion}
              (${t("chat.runningVersion", { version: state.updateAvailable.currentVersion })}).
              <button
                class="btn btn--sm update-banner__btn"
                ?disabled=${state.updateRunning || !state.connected}
                @click=${() => runUpdate(state)}
              >
                ${state.updateRunning ? t("chat.updating") : t("chat.updateNow")}
              </button>
              <button
                class="update-banner__close"
                type="button"
                title=${t("common.dismiss")}
                aria-label=${t("chat.dismissUpdateBanner")}
                @click=${() => {
                  dismissUpdateBanner(state.updateAvailable);
                  state.updateAvailable = null;
                }}
              >
                ${icons.x}
              </button>
            </div>`
          : nothing}
        ${state.tab === "config"
          ? nothing
          : html`<section
              class=${isChat && state.chatHeaderControlsHidden
                ? "content-header content-header--chat-hidden"
                : "content-header"}
              ?inert=${isChat && state.chatHeaderControlsHidden}
              aria-hidden=${isChat && state.chatHeaderControlsHidden ? "true" : nothing}
            >
              <div>
                ${isChat
                  ? renderLazyInline(lazyChatControls, (m) => m.renderChatSessionSelect(state))
                  : html`<div class="page-title">${titleForTab(state.tab)}</div>`}
                ${isChat ? nothing : html`<div class="page-sub">${subtitleForTab(state.tab)}</div>`}
              </div>
              <div class="page-meta">
                ${state.tab === "dreams"
                  ? html`
                      <div class="dreaming-header-controls">
                        <button
                          class="btn btn--subtle btn--sm"
                          ?disabled=${dreamingLoading || state.dreamDiaryLoading}
                          @click=${refreshDreaming}
                        >
                          ${dreamingRefreshLoading
                            ? t("dreaming.header.refreshing")
                            : t("dreaming.header.refresh")}
                        </button>
                        <button
                          class="dreams__phase-toggle ${dreamingOn
                            ? "dreams__phase-toggle--on"
                            : ""}"
                          ?disabled=${dreamingLoading}
                          @click=${() => applyDreamingEnabled(!dreamingOn)}
                        >
                          <span class="dreams__phase-toggle-dot"></span>
                          <span class="dreams__phase-toggle-label">
                            ${dreamingOn ? t("dreaming.header.on") : t("dreaming.header.off")}
                          </span>
                        </button>
                      </div>
                    `
                  : nothing}
                ${shouldShowHeaderError
                  ? html`<div class="pill danger">${state.lastError}</div>`
                  : nothing}
                ${isChat
                  ? renderLazyInline(lazyChatControls, (m) => m.renderChatControls(state))
                  : nothing}
              </div>
            </section>`}
        ${state.tab === "overview"
          ? renderOverview({
              connected: state.connected,
              hello: state.hello,
              settings: state.settings,
              password: state.password,
              lastError: state.lastError,
              lastErrorCode: state.lastErrorCode,
              presenceCount,
              sessionsCount,
              cronEnabled: state.cronStatus?.enabled ?? null,
              cronNext,
              lastChannelsRefresh: state.channelsLastSuccess,
              warnQueryToken,
              modelAuthStatus: state.modelAuthStatusResult,
              usageResult: state.usageResult,
              sessionsResult: state.sessionsResult,
              skillsReport: state.skillsReport,
              cronJobs: state.cronJobs,
              cronStatus: state.cronStatus,
              attentionItems: state.attentionItems,
              eventLog: state.eventLog,
              overviewLogLines: state.overviewLogLines,
              basePath: state.basePath ?? "",
              showGatewayToken: state.overviewShowGatewayToken,
              showGatewayPassword: state.overviewShowGatewayPassword,
              onSettingsChange: (next) => state.applySettings(next),
              onPasswordChange: (next) => (state.password = next),
              onSessionKeyChange: (next) => {
                switchChatSession(state, next);
              },
              onToggleGatewayTokenVisibility: () => {
                state.overviewShowGatewayToken = !state.overviewShowGatewayToken;
              },
              onToggleGatewayPasswordVisibility: () => {
                state.overviewShowGatewayPassword = !state.overviewShowGatewayPassword;
              },
              onConnect: () => state.connect(),
              onRefresh: () => state.loadOverview({ refresh: true }),
              onNavigate: (tab) => state.setTab(tab as import("./navigation.ts").Tab),
              onRefreshLogs: () => state.loadOverview({ refresh: true }),
            })
          : nothing}
        ${state.tab === "appStudio"
          ? renderLazyView(lazyAppStudio, (m) =>
              m.renderAppStudioDashboard({
                loading: state.appStudioLoading,
                error: state.appStudioError,
                snapshot: state.appStudioDashboard,
                lastFetchAt: state.appStudioLastFetchAt,
                selectedAppDir: state.appStudioSelectedAppDir,
                promptDraft: state.appStudioPromptDraft,
                createNameDraft: state.appStudioCreateNameDraft,
                createAppIdDraft: state.appStudioCreateAppIdDraft,
                createBundleIdDraft: state.appStudioCreateBundleIdDraft,
                savingAction: state.appStudioSavingAction,
                actionReceipt: state.appStudioActionReceipt,
                appleFactsDraft: state.appStudioAppleFactsDraft,
                buildEngineDraft: state.appStudioBuildEngineDraft,
                screenImageDrafts: state.appStudioScreenImageDrafts,
                screenImageNotesDraft: state.appStudioScreenImageNotesDraft,
                screenAnalysisDraft: state.appStudioScreenAnalysisDraft,
                flowDraft: state.appStudioFlowDraft,
                actionStartedAt: state.appStudioActionStartedAt,
                onRefresh: () => state.loadAppStudioDashboard({ quiet: false }),
                onSelectProject: (appDir) => state.selectAppStudioProject(appDir),
                onPromptDraftChange: (value) => {
                  state.appStudioPromptDraft = value;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onCreateNameDraftChange: (value) => {
                  state.appStudioCreateNameDraft = value;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onCreateAppIdDraftChange: (value) => {
                  state.appStudioCreateAppIdDraft = value;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onCreateBundleIdDraftChange: (value) => {
                  state.appStudioCreateBundleIdDraft = value;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onCreateProject: () => state.createAppStudioProject(),
                onApplyPrompt: () => state.applyAppStudioPrompt(),
                onBuildEngineChange: (buildEngine) => state.setAppStudioBuildEngine(buildEngine),
                onRunGate: (gate) => state.runAppStudioGate(gate),
                onMoveScreen: (screenId, direction) =>
                  state.reorderAppStudioScreens(screenId, direction),
                onScreenOrderChange: (screenIds) => state.setAppStudioScreenOrder(screenIds),
                onScreenImageFilesChange: (files) => state.updateAppStudioScreenImageFiles(files),
                onScreenImageNotesChange: (value) => state.updateAppStudioScreenImageNotes(value),
                onImportScreenImages: () => state.importAppStudioScreenImages(),
                onScreenAnalysisDraftChange: (value) =>
                  state.updateAppStudioScreenAnalysisDraft(value),
                onApplyScreenAnalysis: () => state.applyAppStudioScreenAnalysis(),
                onFlowDraftChange: (field, value) => state.updateAppStudioFlowDraft(field, value),
                onAddScreenFlowEdge: () => state.addAppStudioScreenFlowConnection(),
                onRemoveScreenFlowEdge: (edgeId) =>
                  state.removeAppStudioScreenFlowConnection(edgeId),
                onAppleFactChange: (field, value) => state.updateAppStudioAppleFact(field, value),
                onImportAppleFacts: () => state.importAppStudioAppleFacts(),
                onApproveGate: (approvalId) => state.approveAppStudioGate(approvalId),
                onDismissReceipt: () => state.dismissAppStudioReceipt(),
              }),
            )
          : nothing}
        ${state.tab === "kalshi"
          ? renderLazyView(lazyKalshi, (m) =>
              m.renderKalshiDashboard({
                loading: state.kalshiDashboardLoading,
                error: state.kalshiDashboardError,
                snapshot: state.kalshiDashboard,
                lastFetchAt: state.kalshiDashboardLastFetchAt,
                timezone: state.kalshiDashboardTimezone,
                timeframe: state.kalshiDashboardTimeframe,
                pnlTimeframe: state.kalshiDashboardPnlTimeframe,
                strategySort: state.kalshiDashboardStrategySort,
                showDeepAudit: state.kalshiDashboardShowDeepAudit,
                auditTablePages: state.kalshiDashboardAuditPages,
                auditTableQueries: state.kalshiDashboardAuditQueries,
                onTimezoneChange: (timezone) => {
                  state.kalshiDashboardTimezone = timezone;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onTimeframeChange: (timeframe) => {
                  state.kalshiDashboardTimeframe = timeframe;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onPnlTimeframeChange: (timeframe) => {
                  state.kalshiDashboardPnlTimeframe = timeframe;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onStrategySortChange: (sort) => {
                  state.kalshiDashboardStrategySort = sort;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onToggleDeepAudit: () => {
                  const nextShowDeepAudit = !state.kalshiDashboardShowDeepAudit;
                  state.kalshiDashboardShowDeepAudit = nextShowDeepAudit;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                  if (nextShowDeepAudit) {
                    void state.loadKalshiDashboard({
                      auditTablePages: state.kalshiDashboardAuditPages,
                      auditTableQueries: state.kalshiDashboardAuditQueries,
                      force: true,
                      view: "full",
                    });
                  }
                },
                onAuditTablePageChange: (table, page) => {
                  state.kalshiDashboardAuditPages = {
                    ...state.kalshiDashboardAuditPages,
                    [table]: page,
                  };
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                  if (state.kalshiDashboardShowDeepAudit) {
                    void state.loadKalshiDashboard({
                      auditTablePages: state.kalshiDashboardAuditPages,
                      auditTableQueries: state.kalshiDashboardAuditQueries,
                      force: true,
                      view: "full",
                    });
                  }
                },
                onAuditTableQueryChange: (table, query) => {
                  state.kalshiDashboardAuditQueries = {
                    ...state.kalshiDashboardAuditQueries,
                    [table]: query,
                  };
                  state.kalshiDashboardAuditPages = {
                    ...state.kalshiDashboardAuditPages,
                    [table]: 1,
                  };
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                  if (state.kalshiDashboardShowDeepAudit) {
                    void state.loadKalshiDashboard({
                      auditTablePages: state.kalshiDashboardAuditPages,
                      auditTableQueries: state.kalshiDashboardAuditQueries,
                      force: true,
                      view: "full",
                    });
                  }
                },
                onRefresh: () =>
                  state.loadKalshiDashboard({
                    auditTablePages: state.kalshiDashboardAuditPages,
                    auditTableQueries: state.kalshiDashboardAuditQueries,
                    force: true,
                    view: state.kalshiDashboardShowDeepAudit ? "full" : "workspace",
                  }),
              }),
            )
          : nothing}
        ${state.tab === "bookWriter"
          ? renderLazyView(lazyBookWriter, (m) =>
              m.renderBookWriterDashboard({
                loading: state.bookWriterLoading,
                error: state.bookWriterError,
                snapshot: state.bookWriterDashboard,
                lastFetchAt: state.bookWriterLastFetchAt,
                selectedRunId: state.bookWriterSelectedRunId,
                topicDraft: state.bookWriterTopicDraft,
                targetWordsDraft: state.bookWriterTargetWordsDraft,
                toneDraft: state.bookWriterToneDraft,
                customToneDraft: state.bookWriterCustomToneDraft,
                profanityDraft: state.bookWriterProfanityDraft,
                penNameDraft: state.bookWriterPenNameDraft,
                newBookSetupOpen: state.bookWriterNewBookSetupOpen,
                readPage: state.bookWriterReadPage,
                readPreviewOpen: state.bookWriterReadPreviewOpen,
                readPreviewMode: state.bookWriterReadPreviewMode,
                activeView: state.bookWriterActiveView,
                mode: state.bookWriterMode,
                pendingAiAction: state.bookWriterPendingAiAction,
                pendingAiSuggestion: state.bookWriterPendingAiSuggestion,
                pendingDestructiveAction: state.bookWriterPendingDestructiveAction,
                actionReceipt: state.bookWriterActionReceipt,
                celebration: state.bookWriterCelebration,
                focusedParagraphId: state.bookWriterFocusedParagraphId,
                searchQuery: state.bookWriterSearchQuery,
                savingAction: state.bookWriterSavingAction,
                canUndo: state.bookWriterUndoStack.length > 0,
                canRedo: state.bookWriterRedoStack.length > 0,
                onRefresh: () => state.loadBookWriterDashboard({ quiet: false }),
                onSelectRun: (runId) => {
                  state.bookWriterNewBookSetupOpen = false;
                  void state.loadBookWriterDashboard({ runId });
                },
                onTopicDraftChange: (value) => {
                  state.bookWriterTopicDraft = value;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onTargetWordsDraftChange: (value) => {
                  state.bookWriterTargetWordsDraft = value;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onToneDraftChange: (value) => {
                  state.bookWriterToneDraft = value;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onCustomToneDraftChange: (value) => {
                  state.bookWriterCustomToneDraft = value;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onProfanityDraftChange: (value) => {
                  state.bookWriterProfanityDraft = value;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onPenNameDraftChange: (value) => {
                  state.bookWriterPenNameDraft = value;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onOpenNewBookSetup: () => {
                  state.bookWriterNewBookSetupOpen = true;
                  state.bookWriterMode = "guided";
                  state.bookWriterActiveView = "brief";
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onCloseNewBookSetup: () => {
                  state.bookWriterNewBookSetupOpen = false;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onCreatePlan: () => state.createBookWriterPlan(),
                onFixBook: () => state.fixBookWriterPlan(),
                onSavePlan: (plan) => state.saveBookWriterPlan(plan),
                onDeleteRun: (runId) => state.deleteBookWriterPlan(runId),
                onArchiveRun: (runId) => state.archiveBookWriterPlan(runId),
                onCopyRun: (runId) => state.copyBookWriterPlan(runId),
                onRestoreArchivedRun: (archivedId) =>
                  state.restoreArchivedBookWriterPlan(archivedId),
                onDeleteArchivedRun: (archivedId) => state.deleteArchivedBookWriterPlan(archivedId),
                onRestoreDeletedRun: (deletedId) => state.restoreDeletedBookWriterPlan(deletedId),
                onDeleteDeletedRun: (deletedId) => state.deleteDeletedBookWriterPlan(deletedId),
                onEmptyDeletedRuns: () => state.emptyDeletedBookWriterPlans(),
                onFinishRun: (runId, proof) => state.finishBookWriterPlan(runId, proof),
                onRestoreFinishedRun: (finishedId) =>
                  state.restoreFinishedBookWriterPlan(finishedId),
                onUpdatePublishedMetrics: (finishedId, metrics) =>
                  state.updatePublishedBookWriterMetrics(finishedId, metrics),
                onBuildRecommendedBook: (topicParagraph) => {
                  state.bookWriterTopicDraft = topicParagraph;
                  state.bookWriterSelectedRunId = null;
                  state.bookWriterNewBookSetupOpen = true;
                  state.bookWriterMode = "guided";
                  state.bookWriterActiveView = "brief";
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                  void state.loadBookWriterDashboard({ runId: null, quiet: true });
                },
                onDraftPlan: () => state.draftBookWriterPlan(),
                onFillParagraphPlans: (chapterId) => state.fillBookWriterParagraphPlans(chapterId),
                onGenerateIdeaSetup: (targets) => state.generateBookWriterIdeaSetup(targets),
                onGenerateChapterSetup: (targets) => state.generateBookWriterChapterSetup(targets),
                onUpdatePenNameProfile: (profile) => state.updateBookWriterPenNameProfile(profile),
                onDraftParagraph: (paragraphId, replaceExisting) =>
                  state.draftBookWriterParagraph(paragraphId, replaceExisting),
                onStitchPlan: () => state.stitchBookWriterPlan(),
                onPackagePlan: () => state.packageBookWriterPlan(),
                onPreparePublish: () => state.prepareBookWriterPublish(),
                onPreparePublishWithCoverStrategy: (coverStrategy) =>
                  state.prepareBookWriterPublishWithCoverStrategy(coverStrategy),
                onGenerateCoverConcept: () => state.generateBookWriterCoverConcept(),
                onGenerateEditableCoverConcept: () =>
                  state.generateBookWriterEditableCoverConcept(),
                onEditCoverWithLocalAi: (variantId, instruction) =>
                  state.editBookWriterCoverWithLocalAi(variantId, instruction),
                onApproveCover: (variantId) => state.approveBookWriterCover(variantId),
                onUploadCoverFile: (file) => state.uploadBookWriterCoverFile(file),
                onDisableAutomation: () => state.disableBookWriterAutomation(),
                onCreateQuickRead: () => state.createBookWriterQuickRead(),
                onShowHome: () => {
                  state.bookWriterNewBookSetupOpen = false;
                  state.bookWriterMode = "guided";
                  state.bookWriterActiveView = "brief";
                  state.bookWriterSelectedRunId = null;
                  state.bookWriterPendingAiAction = null;
                  state.bookWriterPendingAiSuggestion = null;
                  state.bookWriterPendingDestructiveAction = null;
                  state.bookWriterActionReceipt = null;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                  void state.loadBookWriterDashboard({ runId: null, quiet: false });
                },
                onActiveViewChange: (view) => {
                  state.bookWriterActiveView = view;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onReadPageChange: (page) => {
                  state.bookWriterReadPage = page;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onReadPreviewOpenChange: (open) => {
                  state.bookWriterReadPreviewOpen = open;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onReadPreviewModeChange: (mode) => {
                  state.bookWriterReadPreviewMode = mode;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onModeChange: (mode) => {
                  state.bookWriterMode = mode;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onFocusedParagraphChange: (paragraphId) => {
                  state.bookWriterFocusedParagraphId = paragraphId;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onRequestAiHelp: (request) => state.requestBookWriterAiHelp(request),
                onRequestSetupAiHelp: (intent, customDirection) =>
                  state.requestBookWriterSetupAiHelp(intent, customDirection),
                onCancelAiSuggestion: () => state.cancelBookWriterAiSuggestion(),
                onApplyAiSuggestion: (suggestion, value) =>
                  state.applyBookWriterAiSuggestion(suggestion, value),
                onRequestAiAction: (action) => {
                  state.bookWriterPendingAiAction = action;
                  state.bookWriterActionReceipt = null;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onCancelAiAction: () => {
                  state.bookWriterPendingAiAction = null;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onConfirmAiAction: (action) => {
                  state.bookWriterPendingAiAction = null;
                  state.bookWriterActionReceipt = null;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                  switch (action) {
                    case "create":
                      void state.createBookWriterPlan();
                      break;
                    case "full-draft":
                      void state.createBookWriterFullDraft();
                      break;
                    case "paragraph-plan":
                      state.bookWriterActiveView = "paragraphs";
                      (state as { requestUpdate?: () => void }).requestUpdate?.();
                      break;
                    case "draft":
                      void state.draftBookWriterPlan();
                      break;
                    case "propagate":
                      void state.propagateBookWriterStoryChange();
                      break;
                    case "rebalance":
                      void state.rebalanceBookWriterStructure();
                      break;
                    case "stitch":
                      void state.stitchBookWriterPlan();
                      break;
                    case "package":
                      void state.packageBookWriterPlan();
                      break;
                    case "fix":
                      void state.fixBookWriterPlan();
                      break;
                    case "publish":
                      void state.prepareBookWriterPublish();
                      break;
                    case "cover-local-ai":
                      void state.generateBookWriterCoverConcept();
                      break;
                    case "cover-concept":
                    case "cover-generate":
                      void state.generateBookWriterEditableCoverConcept();
                      break;
                    default:
                      action satisfies never;
                  }
                },
                onRequestDestructiveAction: (action) => {
                  state.bookWriterPendingDestructiveAction = action;
                  state.bookWriterActionReceipt = null;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onCancelDestructiveAction: () => {
                  state.bookWriterPendingDestructiveAction = null;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onConfirmDestructiveAction: (action) => {
                  state.bookWriterPendingDestructiveAction = null;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                  switch (action.kind) {
                    case "move-active":
                      void state.deleteBookWriterPlan(action.runId);
                      break;
                    case "move-active-many":
                      void state.deleteActiveBookWriterPlans(action.runIds);
                      break;
                    case "delete-archived":
                      void state.deleteArchivedBookWriterPlan(action.archivedId);
                      break;
                    case "delete-deleted":
                      void state.deleteDeletedBookWriterPlan(action.deletedId);
                      break;
                    case "empty-deleted":
                      void state.emptyDeletedBookWriterPlans();
                      break;
                  }
                },
                onDismissReceipt: () => {
                  state.bookWriterActionReceipt = null;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onDismissCelebration: () => {
                  state.bookWriterCelebration = null;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onSearchQueryChange: (query) => {
                  state.bookWriterSearchQuery = query;
                  (state as { requestUpdate?: () => void }).requestUpdate?.();
                },
                onUndo: () => state.undoBookWriterEdit(),
                onRedo: () => state.redoBookWriterEdit(),
              }),
            )
          : nothing}
        ${state.tab === "patternLab"
          ? renderLazyView(lazyPatternLab, (m) =>
              m.renderPatternLabDashboard({
                loading: state.patternLabDashboardLoading,
                error: state.patternLabDashboardError,
                snapshot: state.patternLabDashboard,
                lastFetchAt: state.patternLabDashboardLastFetchAt,
                approvingAssetType: state.patternLabApprovalBusy,
                basePath: state.basePath ?? "",
                authToken: resolveAssistantAttachmentAuthToken(state),
                onRefresh: () => state.loadPatternLabDashboard(),
                onApproveAssetType: (assetType) => state.approvePatternLabAssetType(assetType),
              }),
            )
          : nothing}
        ${state.tab === "musicStudio"
          ? renderLazyView(lazyMusicStudio, (m) => m.renderMusicStudio(state))
          : nothing}
        ${state.tab === "snesStudio"
          ? renderLazyView(lazySnesStudio, (m) => m.renderSnesStudio(state))
          : nothing}
        ${state.tab === "channels"
          ? renderLazyView(lazyChannels, (m) =>
              m.renderChannels({
                connected: state.connected,
                loading: state.channelsLoading,
                snapshot: state.channelsSnapshot,
                lastError: state.channelsError,
                lastSuccessAt: state.channelsLastSuccess,
                whatsappMessage: state.whatsappLoginMessage,
                whatsappQrDataUrl: state.whatsappLoginQrDataUrl,
                whatsappConnected: state.whatsappLoginConnected,
                whatsappBusy: state.whatsappBusy,
                configSchema: state.configSchema,
                configSchemaLoading: state.configSchemaLoading,
                configForm: state.configForm,
                configUiHints: state.configUiHints,
                configSaving: state.configSaving,
                configFormDirty: state.configFormDirty,
                nostrProfileFormState: state.nostrProfileFormState,
                nostrProfileAccountId: state.nostrProfileAccountId,
                onRefresh: (probe) => loadChannels(state, probe),
                onWhatsAppStart: (force) => state.handleWhatsAppStart(force),
                onWhatsAppWait: () => state.handleWhatsAppWait(),
                onWhatsAppLogout: () => state.handleWhatsAppLogout(),
                onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
                onConfigSave: () => state.handleChannelConfigSave(),
                onConfigReload: () => state.handleChannelConfigReload(),
                onNostrProfileEdit: (accountId, profile) =>
                  state.handleNostrProfileEdit(accountId, profile),
                onNostrProfileCancel: () => state.handleNostrProfileCancel(),
                onNostrProfileFieldChange: (field, value) =>
                  state.handleNostrProfileFieldChange(field, value),
                onNostrProfileSave: () => state.handleNostrProfileSave(),
                onNostrProfileImport: () => state.handleNostrProfileImport(),
                onNostrProfileToggleAdvanced: () => state.handleNostrProfileToggleAdvanced(),
              }),
            )
          : nothing}
        ${state.tab === "instances"
          ? renderLazyView(lazyInstances, (m) =>
              m.renderInstances({
                loading: state.presenceLoading,
                entries: state.presenceEntries,
                lastError: state.presenceError,
                statusMessage: state.presenceStatus,
                onRefresh: () => loadPresence(state),
              }),
            )
          : nothing}
        ${state.tab === "sessions"
          ? renderLazyView(lazySessions, (m) =>
              m.renderSessions({
                loading: state.sessionsLoading,
                result: state.sessionsResult,
                error: state.sessionsError,
                activeMinutes: state.sessionsFilterActive,
                limit: state.sessionsFilterLimit,
                includeGlobal: state.sessionsIncludeGlobal,
                includeUnknown: state.sessionsIncludeUnknown,
                showArchived: state.sessionsShowArchived,
                filtersCollapsed: state.sessionsFiltersCollapsed,
                basePath: state.basePath,
                searchQuery: state.sessionsSearchQuery,
                agentIdentityById: state.agentIdentityById,
                sortColumn: state.sessionsSortColumn,
                sortDir: state.sessionsSortDir,
                page: state.sessionsPage,
                pageSize: state.sessionsPageSize,
                selectedKeys: state.sessionsSelectedKeys,
                expandedCheckpointKey: state.sessionsExpandedCheckpointKey,
                checkpointItemsByKey: state.sessionsCheckpointItemsByKey,
                checkpointLoadingKey: state.sessionsCheckpointLoadingKey,
                checkpointBusyKey: state.sessionsCheckpointBusyKey,
                checkpointErrorByKey: state.sessionsCheckpointErrorByKey,
                onFiltersChange: (next) => {
                  state.sessionsFilterActive = next.activeMinutes;
                  state.sessionsFilterLimit = next.limit;
                  state.sessionsIncludeGlobal = next.includeGlobal;
                  state.sessionsIncludeUnknown = next.includeUnknown;
                  state.sessionsShowArchived = next.showArchived;
                  state.sessionsSelectedKeys = new Set();
                  state.sessionsPage = 0;
                  void loadSessions(state, {
                    activeMinutes: Number(next.activeMinutes) || 0,
                    limit: Number(next.limit) || 0,
                    includeGlobal: next.includeGlobal,
                    includeUnknown: next.includeUnknown,
                    showArchived: next.showArchived,
                  });
                },
                onToggleFiltersCollapsed: () => {
                  state.sessionsFiltersCollapsed = !state.sessionsFiltersCollapsed;
                },
                onClearFilters: () => {
                  state.sessionsFilterActive = "";
                  state.sessionsFilterLimit = "";
                  state.sessionsIncludeGlobal = true;
                  state.sessionsIncludeUnknown = true;
                  state.sessionsShowArchived = true;
                  state.sessionsSearchQuery = "";
                  state.sessionsSelectedKeys = new Set();
                  state.sessionsPage = 0;
                  void loadSessions(state, {
                    activeMinutes: 0,
                    limit: 0,
                    includeGlobal: true,
                    includeUnknown: true,
                    showArchived: true,
                  });
                },
                onSearchChange: (q) => {
                  state.sessionsSearchQuery = q;
                  state.sessionsPage = 0;
                },
                onSortChange: (col, dir) => {
                  state.sessionsSortColumn = col;
                  state.sessionsSortDir = dir;
                  state.sessionsPage = 0;
                },
                onPageChange: (p) => {
                  state.sessionsPage = p;
                },
                onPageSizeChange: (s) => {
                  state.sessionsPageSize = s;
                  state.sessionsPage = 0;
                },
                onRefresh: () => loadSessions(state),
                onPatch: (key, patch) => patchSession(state, key, patch),
                onToggleSelect: (key) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  if (next.has(key)) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onSelectPage: (keys) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  for (const k of keys) {
                    next.add(k);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onDeselectPage: (keys) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  for (const k of keys) {
                    next.delete(k);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onDeselectAll: () => {
                  state.sessionsSelectedKeys = new Set();
                },
                onDeleteSelected: async () => {
                  const keys = [...state.sessionsSelectedKeys];
                  const deleted = await deleteSessionsAndRefresh(state, keys);
                  if (deleted.length > 0) {
                    const next = new Set(state.sessionsSelectedKeys);
                    for (const k of deleted) {
                      next.delete(k);
                    }
                    state.sessionsSelectedKeys = next;
                  }
                },
                onNavigateToChat: (sessionKey) => {
                  switchChatSession(state, sessionKey);
                  state.setTab("chat" as import("./navigation.ts").Tab);
                },
                onToggleCheckpointDetails: (sessionKey) =>
                  toggleSessionCompactionCheckpoints(state, sessionKey),
                onBranchFromCheckpoint: async (sessionKey, checkpointId) => {
                  const nextKey = await branchSessionFromCheckpoint(
                    state,
                    sessionKey,
                    checkpointId,
                  );
                  if (nextKey) {
                    switchChatSession(state, nextKey);
                    state.setTab("chat" as import("./navigation.ts").Tab);
                  }
                },
                onRestoreCheckpoint: (sessionKey, checkpointId) =>
                  restoreSessionFromCheckpoint(state, sessionKey, checkpointId),
              }),
            )
          : nothing}
        ${state.tab === "projects"
          ? renderLazyView(lazyProjects, (m) => m.renderProjectsTab(state))
          : nothing}
        ${state.tab === "usage"
          ? renderLazyView(lazyUsage, (m) => m.renderUsageTab(state))
          : nothing}
        ${state.tab === "cron"
          ? renderLazyView(lazyCron, (m) =>
              m.renderCronTab(state, {
                configValue,
                requestHostUpdate,
              }),
            )
          : nothing}
        ${state.tab === "agents" || state.tab === "agentWorkflows"
          ? renderLazyView(lazyAgents, (m) => m.renderAgentsTab(state, configValue))
          : nothing}
        ${state.tab === "skills"
          ? renderLazyView(lazySkills, (m) =>
              m.renderSkills({
                connected: state.connected,
                loading: state.skillsLoading,
                report: state.skillsReport,
                error: state.skillsError,
                filter: state.skillsFilter,
                statusFilter: state.skillsStatusFilter,
                edits: state.skillEdits,
                messages: state.skillMessages,
                busyKey: state.skillsBusyKey,
                detailKey: state.skillsDetailKey,
                clawhubQuery: state.clawhubSearchQuery,
                clawhubResults: state.clawhubSearchResults,
                clawhubSearchLoading: state.clawhubSearchLoading,
                clawhubSearchError: state.clawhubSearchError,
                clawhubDetail: state.clawhubDetail,
                clawhubDetailSlug: state.clawhubDetailSlug,
                clawhubDetailLoading: state.clawhubDetailLoading,
                clawhubDetailError: state.clawhubDetailError,
                clawhubInstallSlug: state.clawhubInstallSlug,
                clawhubInstallMessage: state.clawhubInstallMessage,
                onFilterChange: (next) => (state.skillsFilter = next),
                onStatusFilterChange: (next) => (state.skillsStatusFilter = next),
                onRefresh: () => loadSkills(state, { clearMessages: true }),
                onToggle: (key, enabled) => updateSkillEnabled(state, key, enabled),
                onEdit: (key, value) => updateSkillEdit(state, key, value),
                onSaveKey: (key) => saveSkillApiKey(state, key),
                onInstall: (skillKey, name, installId) =>
                  installSkill(state, skillKey, name, installId),
                onDetailOpen: (key) => (state.skillsDetailKey = key),
                onDetailClose: () => (state.skillsDetailKey = null),
                onClawHubQueryChange: (query) => {
                  setClawHubSearchQuery(state, query);
                  if (clawhubSearchTimer) {
                    clearTimeout(clawhubSearchTimer);
                  }
                  clawhubSearchTimer = setTimeout(() => searchClawHub(state, query), 300);
                },
                onClawHubDetailOpen: (slug) => loadClawHubDetail(state, slug),
                onClawHubDetailClose: () => closeClawHubDetail(state),
                onClawHubInstall: (slug) => installFromClawHub(state, slug),
              }),
            )
          : nothing}
        ${state.tab === "nodes"
          ? renderLazyView(lazyNodes, (m) =>
              m.renderNodes({
                loading: state.nodesLoading,
                nodes: state.nodes,
                devicesLoading: state.devicesLoading,
                devicesError: state.devicesError,
                devicesList: state.devicesList,
                configForm:
                  state.configForm ??
                  (state.configSnapshot?.config as Record<string, unknown> | null),
                configLoading: state.configLoading,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                configFormMode: state.configFormMode,
                execApprovalsLoading: state.execApprovalsLoading,
                execApprovalsSaving: state.execApprovalsSaving,
                execApprovalsDirty: state.execApprovalsDirty,
                execApprovalsSnapshot: state.execApprovalsSnapshot,
                execApprovalsForm: state.execApprovalsForm,
                execApprovalsSelectedAgent: state.execApprovalsSelectedAgent,
                execApprovalsTarget: state.execApprovalsTarget,
                execApprovalsTargetNodeId: state.execApprovalsTargetNodeId,
                onRefresh: () => loadNodes(state),
                onDevicesRefresh: () => loadDevices(state),
                onDeviceApprove: (requestId) => approveDevicePairing(state, requestId),
                onDeviceReject: (requestId) => rejectDevicePairing(state, requestId),
                onDeviceRotate: (deviceId, role, scopes) =>
                  rotateDeviceToken(state, { deviceId, role, scopes }),
                onDeviceRevoke: (deviceId, role) => revokeDeviceToken(state, { deviceId, role }),
                onLoadConfig: () => loadConfig(state, { discardPendingChanges: true }),
                onLoadExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                      : { kind: "gateway" as const };
                  return loadExecApprovals(state, target);
                },
                onBindDefault: (nodeId) => {
                  if (nodeId) {
                    updateConfigFormValue(state, ["tools", "exec", "node"], nodeId);
                  } else {
                    removeConfigFormValue(state, ["tools", "exec", "node"]);
                  }
                },
                onBindAgent: (agentIndex, nodeId) => {
                  const basePath = ["agents", "list", agentIndex, "tools", "exec", "node"];
                  if (nodeId) {
                    updateConfigFormValue(state, basePath, nodeId);
                  } else {
                    removeConfigFormValue(state, basePath);
                  }
                },
                onSaveBindings: () => saveConfig(state),
                onExecApprovalsTargetChange: (kind, nodeId) => {
                  state.execApprovalsTarget = kind;
                  state.execApprovalsTargetNodeId = nodeId;
                  state.execApprovalsSnapshot = null;
                  state.execApprovalsForm = null;
                  state.execApprovalsDirty = false;
                  state.execApprovalsSelectedAgent = null;
                },
                onExecApprovalsSelectAgent: (agentId) => {
                  state.execApprovalsSelectedAgent = agentId;
                },
                onExecApprovalsPatch: (path, value) =>
                  updateExecApprovalsFormValue(state, path, value),
                onExecApprovalsRemove: (path) => removeExecApprovalsFormValue(state, path),
                onSaveExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                      : { kind: "gateway" as const };
                  return saveExecApprovals(state, target);
                },
              }),
            )
          : nothing}
        ${state.tab === "chat"
          ? renderLazyView(lazyChat, (m) =>
              m.renderChat({
                sessionKey: state.sessionKey,
                onSessionKeyChange: (next) => {
                  switchChatSession(state, next);
                },
                thinkingLevel: state.chatThinkingLevel,
                showThinking,
                showToolCalls,
                loading: state.chatLoading,
                sending: state.chatSending,
                compactionStatus: state.compactionStatus,
                fallbackStatus: state.fallbackStatus,
                assistantAvatarUrl: chatAvatarUrl,
                messages: state.chatMessages,
                sideResult: state.chatSideResult,
                toolMessages: state.chatToolMessages,
                streamSegments: state.chatStreamSegments,
                stream: state.chatStream,
                streamStartedAt: state.chatStreamStartedAt,
                runStatus: state.chatRunStatus,
                targetRunId: state.chatTargetRunId ?? null,
                targetAuditTs: state.chatTargetAuditTs ?? null,
                targetStatus: state.chatTargetStatus ?? null,
                draft: state.chatMessage,
                queue: state.chatQueue,
                realtimeTalkActive: state.realtimeTalkActive,
                realtimeTalkStatus: state.realtimeTalkStatus,
                realtimeTalkDetail: state.realtimeTalkDetail,
                realtimeTalkTranscript: state.realtimeTalkTranscript,
                connected: state.connected,
                canSend: state.connected,
                disabledReason: chatDisabledReason,
                error: state.lastError,
                onDismissError: () => dismissChatError(state),
                sessions: state.sessionsResult,
                focusMode: chatFocus,
                autoExpandToolCalls: false,
                onRefresh: () => {
                  state.chatSideResult = null;
                  state.resetToolStream();
                  return refreshChat(state, { scheduleScroll: false });
                },
                onLoadTargetHistory: () => {
                  state.chatSideResult = null;
                  state.resetToolStream();
                  return loadChatHistory(state, {
                    targetRunId: state.chatTargetRunId ?? null,
                    auditTs: state.chatTargetAuditTs ?? null,
                  });
                },
                onToggleFocusMode: () => {
                  if (state.onboarding) {
                    return;
                  }
                  state.applySettings({
                    ...state.settings,
                    chatFocusMode: !state.settings.chatFocusMode,
                  });
                },
                onChatScroll: (event) => state.handleChatScroll(event),
                getDraft: () => state.chatMessage,
                onDraftChange: (next) => state.handleChatDraftChange(next),
                onRequestUpdate: requestHostUpdate,
                onHistoryKeydown: (input) => state.handleChatInputHistoryKey(input),
                attachments: state.chatAttachments,
                onAttachmentsChange: (next) => (state.chatAttachments = next),
                onSend: () => state.handleSendChat(),
                onCompact: () => state.handleSendChat("/compact", { restoreDraft: true }),
                onOpenSessionCheckpoints: () => {
                  state.sessionsExpandedCheckpointKey = state.sessionKey;
                  state.setTab("sessions" as import("./navigation.ts").Tab);
                  void loadSessions(state, {
                    activeMinutes: 0,
                    limit: 0,
                    includeGlobal: true,
                    includeUnknown: true,
                  });
                },
                onToggleRealtimeTalk: () => state.toggleRealtimeTalk(),
                canAbort: hasAbortableSessionRun(state),
                onAbort: () => void state.handleAbortChat(),
                onQueueRemove: (id) => state.removeQueuedMessage(id),
                onQueueSteer: (id) => void state.steerQueuedChatMessage(id),
                onDismissSideResult: () => {
                  state.chatSideResult = null;
                },
                onNewSession: () => void createChatSession(state),
                onClearHistory: async () => {
                  if (!state.client || !state.connected) {
                    return;
                  }
                  try {
                    await state.client.request("sessions.reset", { key: state.sessionKey });
                    state.chatMessages = [];
                    state.chatSideResult = null;
                    state.chatStream = null;
                    state.chatRunId = null;
                    await loadChatHistory(state);
                  } catch (err) {
                    state.lastError = String(err);
                  }
                },
                agentsList: state.agentsList,
                currentAgentId: resolvedAgentId ?? "main",
                onAgentChange: (agentId: string) => {
                  switchChatSession(state, buildAgentMainSessionKey({ agentId }));
                },
                onNavigateToAgent: () => {
                  state.agentsSelectedId = resolvedAgentId;
                  state.setTab("agents" as import("./navigation.ts").Tab);
                },
                onSessionSelect: (key: string) => {
                  switchChatSession(state, key);
                },
                showNewMessages: state.chatNewMessagesBelow && !state.chatManualRefreshInFlight,
                onScrollToBottom: () => state.scrollToBottom(),
                // Sidebar props for tool output viewing
                sidebarOpen: state.sidebarOpen,
                sidebarContent: state.sidebarContent,
                sidebarError: state.sidebarError,
                splitRatio: state.splitRatio,
                canvasPluginSurfaceUrl: state.hello?.pluginSurfaceUrls?.canvas ?? null,
                onOpenSidebar: (content) => state.handleOpenSidebar(content),
                onCloseSidebar: () => state.handleCloseSidebar(),
                onSplitRatioChange: (ratio: number) => state.handleSplitRatioChange(ratio),
                assistantName: state.assistantName,
                assistantAvatar: effectiveAssistantAvatar,
                userName: state.userName ?? null,
                userAvatar: state.userAvatar ?? null,
                localMediaPreviewRoots: state.localMediaPreviewRoots,
                embedSandboxMode: state.embedSandboxMode,
                allowExternalEmbedUrls: state.allowExternalEmbedUrls,
                assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state),
                basePath: state.basePath ?? "",
              }),
            )
          : nothing}
        ${renderConfigTabForActiveTab()}
        ${state.tab === "debug"
          ? renderLazyView(lazyDebug, (m) =>
              m.renderDebug({
                loading: state.debugLoading,
                status: state.debugStatus,
                health: state.debugHealth,
                models: state.debugModels,
                heartbeat: state.debugHeartbeat,
                eventLog: state.eventLog,
                methods: (state.hello?.features?.methods ?? []).toSorted(),
                callMethod: state.debugCallMethod,
                callParams: state.debugCallParams,
                callResult: state.debugCallResult,
                callError: state.debugCallError,
                onCallMethodChange: (next) => (state.debugCallMethod = next),
                onCallParamsChange: (next) => (state.debugCallParams = next),
                onRefresh: () => loadDebug(state),
                onCall: () => callDebugMethod(state),
              }),
            )
          : nothing}
        ${state.tab === "logs"
          ? renderLazyView(lazyLogs, (m) =>
              m.renderLogs({
                loading: state.logsLoading,
                error: state.logsError,
                file: state.logsFile,
                entries: state.logsEntries,
                filterText: state.logsFilterText,
                levelFilters: state.logsLevelFilters,
                autoFollow: state.logsAutoFollow,
                truncated: state.logsTruncated,
                onFilterTextChange: (next) => (state.logsFilterText = next),
                onLevelToggle: (level, enabled) => {
                  state.logsLevelFilters = { ...state.logsLevelFilters, [level]: enabled };
                },
                onToggleAutoFollow: (next) => (state.logsAutoFollow = next),
                onRefresh: () => loadLogs(state, { reset: true }),
                onExport: (lines, label) => state.exportLogs(lines, label),
                onScroll: (event) => state.handleLogsScroll(event),
              }),
            )
          : nothing}
        ${state.tab === "dreams"
          ? renderLazyView(lazyDreaming, (m) =>
              m.renderDreamingTab(state, {
                active: dreamingOn,
                onRequestUpdate: requestHostUpdate,
              }),
            )
          : nothing}
      </main>
      ${renderExecApprovalPrompt(state)} ${renderGatewayUrlConfirmation(state)}
      ${renderDreamingRestartConfirmation({
        open: state.dreamingRestartConfirmOpen,
        loading: state.dreamingRestartConfirmLoading,
        onConfirm: confirmDreamingRestart,
        onCancel: cancelDreamingRestart,
        hasError: Boolean(state.dreamingStatusError),
      })}
      ${nothing}
    </div>
  `;
}
