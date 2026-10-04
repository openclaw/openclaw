import { html, nothing } from "lit";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import { serializeSidebarEntry, titleForRoute, type SidebarZoneEntry } from "../app-navigation.ts";
import { isRouteId, isSessionRouteId } from "../app-route-paths.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { NativeGateway, NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { isHomePanelAvailable } from "../app/panel-availability.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { renderHoverMarquee } from "../lib/hover-marquee.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { isSessionRunActive } from "../lib/session-run-state.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import { pluginTabKey } from "../pages/plugin/route.ts";
import { renderSidebarPluginTab } from "./app-sidebar-nav-menus.ts";
import { renderSidebarSessionFilter } from "./app-sidebar-session-filter-summary.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { renderGatewayStatus } from "./gateway-status.ts";
import { icons } from "./icons.ts";
import { renderShortcutHint } from "./kbd.ts";
import { renderNewSessionLink } from "./new-session-link.ts";
import { HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import {
  renderSessionAttentionIcon,
  sessionAttentionTooltipLabel,
} from "./session-attention-presentation.ts";
import { renderSessionGlyph, renderSessionUnreadBadge } from "./session-glyph.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";
import { formatSidebarBuildSubtitle } from "./sidebar-build-chip-format.ts";
import { renderSidebarReorderMenu } from "./sidebar-reorder.ts";

export type AppSidebarRenderHost = AppSidebarSessionNavigationElement & {
  activePluginTabId: string;
  teamOnlineExpanded: boolean;
  readonly people: import("./sidebar-people-controller.ts").SidebarPeopleController;
  getRouteSessionKey(): string;
  renderPinnedSidebarSession(session: SidebarRecentSession): unknown;
  toggleSection(sectionId: string): void;
};

// Display-only: read the injected global directly; the capability module must stay
// lazy to protect the startup budget.
function readSidebarNativeGateway(): NativeGateway | null {
  const snapshot = (window as Window & { __OPENCLAW_NATIVE_GATEWAYS__?: NativeGatewaysSnapshot })[
    "__OPENCLAW_NATIVE_GATEWAYS__"
  ];
  if (!snapshot || !Array.isArray(snapshot.gateways)) {
    return null;
  }
  return snapshot.gateways.find((gateway) => gateway.id === snapshot.currentId) ?? null;
}

function renderSidebarAgentCard(host: AppSidebarRenderHost) {
  const {
    activeId: cardAgentId,
    agent: cardAgent,
    agents: cardAgents,
    identity: cardIdentity,
  } = host.activeChipAgent();
  if (!cardAgent) {
    return renderSidebarWorkspaceHeader(host);
  }
  const menuUnread = cardAgents.some((entry) => {
    const agentId = normalizeAgentId(entry.id);
    return agentId !== cardAgentId && host.agentUnreadCount(agentId) > 0;
  });
  const cardName = normalizeAgentLabel(cardAgent, cardIdentity);
  const gateway = host.sessionDataContext?.gateway;
  const avatarAuthReady = Boolean(
    gateway &&
    (gateway.snapshot.hello ||
      gateway.connection.token.trim() ||
      gateway.connection.password.trim()),
  );
  return html`
    <openclaw-sidebar-agent-card
      .agentName=${cardName}
      .agentId=${cardAgentId}
      .avatarUrl=${resolveAgentAvatarUrl(cardAgent, cardIdentity)}
      .avatarAuthReady=${avatarAuthReady}
      .avatarText=${resolveAgentTextAvatar(cardAgent, cardIdentity)}
      .environment=${host.sessionDataContext?.config?.current?.environment ?? null}
      .menuOpen=${host.sidebarMenus.agentMenuPosition !== null}
      .menuUnread=${menuUnread}
      .switcherAvailable=${cardAgents.length > 1}
      .onToggleMenu=${(trigger: HTMLElement) => host.sidebarMenus.toggleAgentMenu(trigger)}
      .onMenuPointerMove=${(trigger: HTMLElement, event: PointerEvent) =>
        host.sidebarMenus.scheduleAgentMenuHoverOpen(trigger, event)}
      .onMenuPointerLeave=${() => host.sidebarMenus.handleAgentMenuTriggerPointerLeave()}
      @contextmenu=${(event: MouseEvent) => {
        event.preventDefault();
        if (host.sidebarMenus.agentMenuPosition !== null) {
          return;
        }
        const card = event.currentTarget as HTMLElement;
        const trigger = card.querySelector<HTMLElement>(".sidebar-agent-card__main") ?? card;
        host.sidebarMenus.toggleAgentMenu(trigger);
      }}
    ></openclaw-sidebar-agent-card>
  `;
}

function renderSidebarWorkspaceHeader(host: AppSidebarRenderHost) {
  const name = readSidebarNativeGateway()?.name.trim() || "OpenClaw";
  const menuOpen = host.sidebarMenus.agentMenuPosition !== null;
  return html`
    <div class="sidebar-workspace-header">
      <button
        type="button"
        class="sidebar-workspace-header__main"
        aria-haspopup="menu"
        aria-expanded=${String(menuOpen)}
        aria-label="${name} · ${t("agentChip.workspaceMenuLabel")}"
        @pointermove=${(event: PointerEvent) => {
          if (event.currentTarget instanceof HTMLElement) {
            host.sidebarMenus.scheduleAgentMenuHoverOpen(event.currentTarget, event);
          }
        }}
        @pointerleave=${() => host.sidebarMenus.handleAgentMenuTriggerPointerLeave()}
        @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
        @click=${(event: MouseEvent) => {
          event.stopPropagation();
          if (event.currentTarget instanceof HTMLElement) {
            host.sidebarMenus.toggleAgentMenu(event.currentTarget);
          }
        }}
        @contextmenu=${(event: MouseEvent) => {
          event.preventDefault();
          if (!menuOpen && event.currentTarget instanceof HTMLElement) {
            host.sidebarMenus.toggleAgentMenu(event.currentTarget);
          }
        }}
      >
        ${
          host.sessionDataContext?.theme.branding.mascot === "none"
            ? html`<span
                class="sidebar-workspace-header__mark sidebar-workspace-header__mark--neutral"
                aria-hidden="true"
                >${icons.mark}</span
              >`
            : html`<img
                class="sidebar-workspace-header__mark"
                src=${controlUiPublicAssetPath("favicon.svg", host.basePath)}
                alt=""
                aria-hidden="true"
              />`
        }
        <span class="sidebar-agent-card__text">
          <span class="sidebar-agent-card__name">
            ${renderHoverMarquee(name, "sidebar-agent-card__name-text", { loop: true, delay: 300, speed: 35 })}
            <span class="sidebar-agent-card__chevron" aria-hidden="true"
              >${icons.chevronsUpDown}</span
            >
          </span>
          ${
            host.sessionDataContext?.config.current.environment
              ? html`<span class="control-ui-environment-pill"
                  >${host.sessionDataContext.config.current.environment.label}</span
                >`
              : nothing
          }
        </span>
      </button>
    </div>
  `;
}

export function renderAppSidebarBrand(
  host: AppSidebarRenderHost,
  teamNewSession: unknown = nothing,
) {
  const newSessionAccess = host.readNewSessionAccess();
  const collapseLabel = t("nav.collapse");
  return html`
    <div class="sidebar-brand">
      ${host.sidebarAgentsMode === "roster" ? renderSidebarWorkspaceHeader(host) : renderSidebarAgentCard(host)}
      <div class="sidebar-brand__actions">
        <openclaw-tooltip
          .content=${`${collapseLabel} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar)})`}
          .contentTemplate=${renderShortcutHint(collapseLabel, KEYBOARD_SHORTCUT_COMBOS.toggleSidebar)}
        >
          <button
            type="button"
            class="sidebar-brand__icon sidebar-brand__header-control sidebar-brand__desktop-control sidebar-brand__collapse"
            aria-label=${collapseLabel}
            aria-expanded="true"
            ?disabled=${!host.onToggleSidebar}
            @click=${() => host.onToggleSidebar?.()}
          >
            ${icons.panelLeftClose}
          </button>
        </openclaw-tooltip>
        <openclaw-tooltip
          .content=${`${t("chat.openCommandPalette")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette)})`}
          .contentTemplate=${renderShortcutHint(t("chat.openCommandPalette"), KEYBOARD_SHORTCUT_COMBOS.commandPalette)}
        >
          <button
            type="button"
            class="sidebar-brand__icon sidebar-brand__header-control sidebar-brand__desktop-control sidebar-brand__search"
            aria-label=${t("chat.openCommandPalette")}
            ?disabled=${!host.onOpenPalette}
            @click=${() => host.onOpenPalette?.()}
          >
            ${icons.search}
          </button>
        </openclaw-tooltip>
        ${
          host.sidebarAgentsMode === "roster"
            ? renderSidebarSessionFilter(host, "sidebar-brand__icon sidebar-brand__header-control")
            : nothing
        }
        ${
          host.sidebarAgentsMode === "roster"
            ? teamNewSession
            : renderNewSessionLink({
                basePath: host.basePath,
                agentId: host.expandedAgentId(),
                className:
                  "sidebar-brand__icon sidebar-brand__header-control sidebar-brand__new-thread",
                label: t("agentChip.newConversation"),
                showShortcut: true,
                disabledReason: newSessionAccess.allowed ? undefined : newSessionAccess.reason,
                onOpen: (agentId, target) => host.requestOpenNewSession(agentId, target),
              })
        }
      </div>
    </div>
  `;
}

/** Home: the first page. Opens the rolling main session on its saved face. */
export function renderAppSidebarHomeRow(host: AppSidebarRenderHost) {
  if (host.sidebarAgentsMode === "roster") {
    return nothing;
  }
  const agentId = host.expandedAgentId();
  const mainKey = host.selectedAgentMainSessionKey(agentId);
  const mainRow = host.mainSessionRow(agentId);
  const session = mainRow ? host.projectHomeSession(mainRow, agentId) : null;
  const attention = session?.attention ?? host.resolveSessionAttention({ key: mainKey, agentId });
  const attentionLabel = sessionAttentionTooltipLabel(attention);
  const outboxAttentionCount = host.storedOutboxes?.attentionCountForSession(mainKey) ?? 0;
  const active =
    isSessionRouteId(host.activeRouteId) &&
    areUiSessionKeysEquivalent(host.getRouteSessionKey(), mainKey);
  const hasComposerDraft = host.storedOutboxes?.hasSessionDraft(mainKey) ?? false;
  const ownRun = mainRow ? isSessionRunActive(mainRow) : false;
  const subagentsWorking = (session?.runningChildCount ?? 0) > 0;
  const running = ownRun || subagentsWorking;
  const queued = ownRun && mainRow?.status === "queued" && !subagentsWorking;
  const unread = (mainRow?.unread === true || (session?.unreadChildCount ?? 0) > 0) && !active;
  const activeRunLabel = running
    ? t(
        subagentsWorking && (!ownRun || mainRow?.status === "queued")
          ? "sessionsView.subagentsWorking"
          : queued
            ? "sessionsView.statusQueued"
            : "sessionsView.activeRun",
      )
    : "";
  const unreadLabel = unread ? t("sessionsView.unread") : "";
  const homeDescription =
    attentionLabel || (activeRunLabel && unreadLabel)
      ? [attentionLabel, activeRunLabel, unreadLabel].filter(Boolean).join(" · ")
      : "";
  const homeGlyph = renderSessionGlyph({
    content:
      attention.kind === "none"
        ? html`<span class="nav-item__icon" aria-hidden="true">${icons.home}</span>`
        : renderSessionAttentionIcon(attention, true),
    running,
    queued,
    runningLabel: activeRunLabel,
    badge: unread && !running ? renderSessionUnreadBadge() : nothing,
  });
  return html`
    <a
      href=${
        sessionNavigationTarget({
          face: resolveSessionPreferredFace(mainRow),
          sessionKey: mainKey,
          fallbackAgentId: agentId,
          basePath: host.basePath,
          row: mainRow ?? undefined,
          mainKey: parseAgentSessionKey(mainKey)?.rest,
          preferenceDerivedFace: true,
        }).href
      }
      class="nav-item nav-item--home ${active ? "nav-item--active" : ""}"
      aria-label=${homeDescription ? `${t("nav.home")} · ${homeDescription}` : nothing}
      aria-current=${active ? "page" : nothing}
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        host.openMainSession(agentId);
      }}
    >
      ${homeGlyph}
      <span class="nav-item__text">${t("nav.home")}</span>
      ${
        outboxAttentionCount > 0 || hasComposerDraft
          ? html`<span class="nav-item__state sidebar-home-session-states">
              ${renderSessionRowBadges({
                outboxAttentionCount,
                hasComposerDraft,
              })}
            </span>`
          : nothing
      }
    </a>
  `;
}

export function renderAppSidebarPagesHead(host: AppSidebarRenderHost) {
  return html`
    <div class="sidebar-nav__head">
      <span class="sidebar-recent-sessions__label-text sr-only">${t("nav.pages")}</span>
      <button
        type="button"
        class="sidebar-nav__head-action"
        aria-haspopup="menu"
        aria-expanded=${String(host.sidebarMenus.moreMenuPosition !== null)}
        aria-label=${t("nav.customize")}
        @click=${(event: MouseEvent) =>
          host.sidebarMenus.toggleMoreMenu(event.currentTarget as HTMLElement)}
      >
        ${icons.penLine}
      </button>
    </div>
  `;
}

/** Zone 5: product chrome recedes to one slim footer bar. */
export function renderAppSidebarFooterBar(host: AppSidebarRenderHost) {
  const connectionStatus = host.connectionStatus;
  const selfUser = host.sessionDataContext
    ? gatewayPresentationScope(host.sessionDataContext.gateway).displayUser
    : null;
  const selfLabel = selfUser?.name ?? selfUser?.email ?? t("nav.owner");
  const avatarUser = {
    id: "owner",
    ...selfUser,
    name: selfLabel,
    watchedSessions: [],
  };
  const gateway = readSidebarNativeGateway();
  const buildSubtitle = formatSidebarBuildSubtitle(CONTROL_UI_BUILD_INFO);
  const gatewayPrimaryTag = gateway?.isPrimary ? t("nav.gateway.primaryTag") : null;
  const identityMenuLabel = t("profilePage.identity.menuButtonLabel", { name: selfLabel });
  const statusLabel = connectionStatus ? t(`connection.${connectionStatus}`) : null;
  const identityDetail = statusLabel
    ? statusLabel
    : gateway
      ? `${gateway.name}${gatewayPrimaryTag ? `, ${gatewayPrimaryTag}` : ""}`
      : buildSubtitle;
  const announcement = statusLabel ?? (host.connected ? t("nav.gateway.connected") : "");
  return html`
    <div class="sidebar-footer-bar sidebar-footer-bar--one-action">
      <button
        type="button"
        class="sidebar-identity-card"
        aria-haspopup="menu"
        aria-expanded=${String(host.sidebarMenus.identityMenuPosition !== null)}
        aria-label=${identityDetail ? `${identityMenuLabel}: ${identityDetail}` : identityMenuLabel}
        @click=${(event: MouseEvent) =>
          host.sidebarMenus.toggleIdentityMenu(event.currentTarget as HTMLElement)}
      >
        <openclaw-viewer-avatar .user=${avatarUser} variant="footer"></openclaw-viewer-avatar>
        <span class="sidebar-identity-card__text">
          ${renderHoverMarquee(selfLabel, "sidebar-identity-card__name", { loop: true, delay: 300, speed: 35 })}
          ${
            connectionStatus
              ? renderGatewayStatus({
                  kind: connectionStatus,
                  lastError: host.lastError,
                  announce: false,
                })
              : gateway
                ? html`<span class="sidebar-identity-card__gateway" aria-hidden="true">
                    <span class="sidebar-gateway-name">${gateway.name}</span>
                    ${gatewayPrimaryTag ? html`<span class="sidebar-gateway-primary">${gatewayPrimaryTag}</span>` : nothing}
                  </span>`
                : nothing
          }
        </span>
      </button>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true"
        >${announcement}</span
      >
      <span class="sidebar-footer-actions">
        ${
          isHomePanelAvailable(host.sessionDataContext?.gateway)
            ? html`<openclaw-tooltip
                .content=${`${t("assistantPanel.toggle")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.homePanel)})`}
                .contentTemplate=${renderShortcutHint(t("assistantPanel.toggle"), KEYBOARD_SHORTCUT_COMBOS.homePanel)}
                ><button
                  type="button"
                  class="sidebar-brand__icon sidebar-footer-bar__home"
                  aria-label=${t("assistantPanel.toggle")}
                  @click=${() => window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT))}
                >
                  ${icons.home}
                </button></openclaw-tooltip
              >`
            : nothing
        }
        <openclaw-sidebar-attention
          .activeRouteId=${host.activeRouteId}
          .onNavigate=${host.onNavigate}
          .watchUpdateProgress=${host.watchUpdateProgress}
        ></openclaw-sidebar-attention>
      </span>
    </div>
  `;
}

export function renderAppSidebarZoneEntry(
  host: AppSidebarRenderHost,
  entry: SidebarZoneEntry,
  sessionRows: ReadonlyMap<string, SidebarRecentSession>,
  pluginTabs: ReadonlyMap<string, GatewayControlUiPluginTab>,
) {
  if (entry.type === "route" && !host.sidebarMenus.isRouteEnabled(entry.route)) {
    return nothing;
  }
  const serialized = serializeSidebarEntry(entry);
  const dropPosition =
    host.sessionOrganizer.sidebarZoneDropTarget?.entry === serialized
      ? host.sessionOrganizer.sidebarZoneDropTarget.position
      : null;
  const pluginTab = entry.type === "plugin" ? pluginTabs.get(entry.key) : undefined;
  const content =
    entry.type === "route"
      ? host.sidebarMenus.renderRoute(entry.route)
      : pluginTab
        ? renderAppSidebarPluginTab(host, pluginTab)
        : entry.type === "plugin"
          ? html`<openclaw-plugin-contributions
              .kind=${"navigation"}
              .navigationKey=${entry.key}
            ></openclaw-plugin-contributions>`
          : sessionRows.has(entry.key)
            ? host.renderPinnedSidebarSession(sessionRows.get(entry.key)!)
            : nothing;
  const draggable = entry.type === "route" || entry.type === "plugin";
  const label =
    entry.type === "route"
      ? titleForRoute(entry.route)
      : entry.type === "session"
        ? (sessionRows.get(entry.key)?.label ?? entry.key)
        : (pluginTab?.label ??
          host.pluginNavigation().find((item) => item.key === entry.key)?.value.label ??
          entry.key);
  return html`
    <div
      class="sidebar-zone-entry ${dropPosition ? `sidebar-zone-entry--drop-${dropPosition}` : ""} ${
        host.sessionOrganizer.draggingSidebarEntry === serialized
          ? "sidebar-zone-entry--dragging"
          : ""
      }"
      data-sidebar-entry=${serialized}
      draggable=${draggable ? "true" : "false"}
      @dragstart=${
        entry.type === "route"
          ? (event: DragEvent) => host.sessionOrganizer.startSidebarRouteDrag(event, entry.route)
          : entry.type === "plugin"
            ? (event: DragEvent) => host.sessionOrganizer.startSidebarPluginDrag(event, entry.key)
            : nothing
      }
      @dragend=${draggable ? () => host.sessionOrganizer.finishSidebarEntryDrag() : nothing}
      @dragover=${(event: DragEvent) =>
        host.sessionOrganizer.handleSidebarZoneDragOver(event, serialized)}
      @drop=${(event: DragEvent) => host.sessionOrganizer.handleSidebarZoneDrop(event, serialized)}
    >
      ${content}
      ${renderSidebarReorderMenu({
        label,
        kind: "entry",
        onMove: async (target, position) => {
          host.sessionOrganizer.writeSidebarEntryAt(serialized, target, position);
          host.requestUpdate();
          await host.updateComplete;
        },
      })}
    </div>
  `;
}

function renderAppSidebarPluginTab(host: AppSidebarRenderHost, tab: GatewayControlUiPluginTab) {
  const ref = { pluginId: tab.pluginId, id: tab.id };
  const key = pluginTabKey(ref);
  const routePlacement = tab.placement?.startsWith("route:")
    ? tab.placement.slice("route:".length)
    : "";
  const routeId = isRouteId(routePlacement) ? routePlacement : null;
  return routeId
    ? host.sidebarMenus.renderRoute(routeId)
    : renderSidebarPluginTab({
        tab,
        basePath: host.basePath,
        active: host.activeRouteId === "plugin" && host.activePluginTabId === key,
        onNavigate: (location) => host.onNavigate?.("plugin", location),
      });
}
