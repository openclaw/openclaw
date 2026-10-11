import { html, nothing } from "lit";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import { serializeSidebarEntry, type SidebarZoneEntry } from "../app-navigation.ts";
import { isRouteId, pluginTabLocation } from "../app-route-paths.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { NativeGateway, NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { isHomePanelAvailable } from "../app/panel-availability.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { hasSameOriginGatewayTransport } from "../dev-gateway.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { renderHoverMarquee } from "../lib/hover-marquee.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { pluginTabKey } from "../pages/plugin/route.ts";
import { renderSidebarNavLink } from "./app-sidebar-nav-menus.ts";
import { renderSidebarSessionFilter } from "./app-sidebar-session-filter-summary.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { renderGatewayStatus } from "./gateway-status.ts";
import { icons } from "./icons.ts";
import { renderShortcutHint } from "./kbd.ts";
import { renderNewSessionLink } from "./new-session-link.ts";
import { HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import { renderSessionLeadingState } from "./session-leading-indicator.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";
import { formatSidebarBuildSubtitle } from "./sidebar-build-chip-format.ts";
import { renderThemeBrandIcon } from "./theme-brand-icon.ts";

export type AppSidebarRenderHost = AppSidebarSessionNavigationElement & {
  teamOnlineExpanded: boolean;
  readonly people: import("./sidebar-people-controller.ts").SidebarPeopleController;
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
    agent: rosterAgent,
    agents: cardAgents,
    identity: cardIdentity,
  } = host.activeChipAgent();
  const gateway = host.sessionDataContext?.gateway;
  const bootstrapIdentity =
    gateway && hasSameOriginGatewayTransport(gateway.connection.gatewayUrl)
      ? host.sessionDataContext?.config.current.assistantIdentity
      : undefined;
  const cardAgent =
    rosterAgent ??
    (bootstrapIdentity?.agentId === cardAgentId
      ? {
          id: cardAgentId,
          name: bootstrapIdentity.name,
          identity: { avatar: bootstrapIdentity.avatar ?? undefined },
        }
      : undefined);
  const cached =
    host.sidebarSnapshot?.mode === "chip" && host.sidebarSnapshot.brand.agentId === cardAgentId
      ? host.sidebarSnapshot.brand
      : null;
  if (!cardAgent && !cached) {
    return renderSidebarWorkspaceHeader(host);
  }
  const menuUnread = cardAgents.some((entry) => {
    const agentId = normalizeAgentId(entry.id);
    return agentId !== cardAgentId && host.agentUnreadCount(agentId) > 0;
  });
  const cardName = cached?.name ?? (cardAgent ? normalizeAgentLabel(cardAgent, cardIdentity) : "");
  const avatarAuthReady = Boolean(
    gateway &&
    (gateway.snapshot.hello ||
      gateway.connection.token.trim() ||
      gateway.connection.password.trim() ||
      bootstrapIdentity?.agentId === cardAgentId),
  );
  return html`
    <openclaw-sidebar-agent-card
      .agentName=${cardName}
      .agentId=${cardAgentId}
      .avatarUrl=${cached ? cached.avatar : cardAgent ? resolveAgentAvatarUrl(cardAgent, cardIdentity) : null}
      .avatarAuthReady=${avatarAuthReady}
      .avatarText=${cached ? (cached.textAvatar ?? null) : cardAgent ? resolveAgentTextAvatar(cardAgent, cardIdentity) : null}
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

export function readSidebarBrandPresentation(host: AppSidebarRenderHost) {
  const config = host.sessionDataContext?.config.current;
  const chip = host.activeChipAgent();
  const branding = host.sessionDataContext?.theme.branding ?? currentThemeBranding();
  return {
    agentId: host.sidebarAgentsMode === "chip" ? chip.agent?.id : undefined,
    textAvatar:
      host.sidebarAgentsMode === "chip" && chip.agent
        ? resolveAgentTextAvatar(chip.agent, chip.identity)
        : undefined,
    name:
      host.sidebarAgentsMode === "chip" && chip.agent
        ? normalizeAgentLabel(chip.agent, chip.identity)
        : readSidebarNativeGateway()?.name.trim() || branding.brandName,
    avatar:
      host.sidebarAgentsMode === "chip" && chip.agent
        ? resolveAgentAvatarUrl(chip.agent, chip.identity)
        : (config?.assistantIdentity.avatar ?? null),
    icon: branding.brandIcon,
    iconUrl: branding.artwork?.icons?.[branding.brandIcon]?.url,
    environment: config?.environment?.label ?? null,
  };
}

function renderSidebarWorkspaceHeader(host: AppSidebarRenderHost) {
  const currentBranding = host.sessionDataContext?.theme.branding ?? currentThemeBranding();
  const cached = host.sidebarSnapshot?.brand.agentId ? null : host.sidebarSnapshot?.brand;
  const brand = cached ?? readSidebarBrandPresentation(host);
  const branding = cached
    ? {
        ...currentBranding,
        brandName: brand.name,
        brandIcon: brand.icon,
        artwork: brand.iconUrl ? { icons: { [brand.icon]: { url: brand.iconUrl } } } : undefined,
      }
    : currentBranding;
  const name = brand.name;
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
          branding.brandIcon !== "claw"
            ? html`<span
                class="sidebar-workspace-header__mark sidebar-workspace-header__mark--neutral"
                aria-hidden="true"
                >${renderThemeBrandIcon(icons.lobster, branding)}</span
              >`
            : html`<span class="sidebar-workspace-header__mark" aria-hidden="true"
                >${icons.lobster}</span
              >`
        }
        <span class="sidebar-agent-card__text">
          <span class="sidebar-agent-card__name">
            ${renderHoverMarquee(name, "sidebar-agent-card__name-text", { loop: true, delay: 300, speed: 35 })}
            <span class="sidebar-agent-card__chevron" aria-hidden="true"
              >${icons.chevronsUpDown}</span
            >
          </span>
          ${
            brand.environment
              ? html`<span class="control-ui-environment-pill">${brand.environment}</span>`
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

export function renderAppSidebarFooterBar(host: AppSidebarRenderHost) {
  const home = host.visibleHomeSession(host.expandedAgentId());
  const connectionStatus = host.connectionStatus;
  const selfUser = host.sessionDataContext
    ? gatewayPresentationScope(host.sessionDataContext.gateway).displayUser
    : null;
  const displayUser = selfUser ?? host.sidebarSnapshot?.footer;
  const selfLabel = displayUser?.name ?? displayUser?.email ?? t("nav.owner");
  const avatarUser = {
    id: "owner",
    ...displayUser,
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
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true"
        >${announcement}</span
      >
      <span class="sidebar-footer-actions">
        ${html`<openclaw-tooltip
          .content=${`${t("assistantPanel.toggle")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.homePanel)})`}
          .contentTemplate=${renderShortcutHint(t("assistantPanel.toggle"), KEYBOARD_SHORTCUT_COMBOS.homePanel)}
          ><button
            type="button"
            class="sidebar-brand__icon sidebar-footer-bar__home"
            aria-label=${t("assistantPanel.toggle")}
            ?disabled=${!isHomePanelAvailable(host.sessionDataContext?.gateway)}
            @click=${() => {
              host.personalNavigationEpoch += 1;
              window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
            }}
          >
            ${home ? renderSessionLeadingState(home, undefined, "owned", undefined, undefined, false, html`<span class="nav-item__icon" aria-hidden="true">${icons.home}</span>`).leadingIndicator : icons.home}
            ${home ? renderSessionRowBadges({ outboxAttentionCount: home.outboxAttentionCount, hasComposerDraft: home.hasComposerDraft }) : nothing}
          </button></openclaw-tooltip
        >`}
        <openclaw-sidebar-attention
          .activeRouteId=${host.activeRouteId}
          .onNavigate=${host.onNavigate}
          .watchUpdateProgress=${host.watchUpdateProgress}
        ></openclaw-sidebar-attention>
      </span>
      <button
        type="button"
        class="sidebar-identity-card"
        aria-haspopup="menu"
        aria-expanded=${String(host.sidebarMenus.identityMenuPosition !== null)}
        title=${identityDetail ? `${identityMenuLabel}: ${identityDetail}` : identityMenuLabel}
        data-connection-status=${connectionStatus ?? nothing}
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
    </div>
  `;
}

export function renderAppSidebarPageEntry(
  host: AppSidebarRenderHost,
  entry: SidebarZoneEntry,
  sessionRows: ReadonlyMap<string, SidebarRecentSession>,
  pluginTabs: ReadonlyMap<string, GatewayControlUiPluginTab>,
) {
  if (entry.type === "person") {
    return nothing;
  }
  const serialized = serializeSidebarEntry(entry);
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
              .navigationChildren=${false}
              .navigationMenus=${host.sidebarMenus}
            ></openclaw-plugin-contributions>`
          : sessionRows.has(entry.key)
            ? host.renderPinnedSidebarSession(sessionRows.get(entry.key)!)
            : nothing;
  const draggable = !host.sidebarSnapshot && (entry.type === "route" || entry.type === "plugin");
  return html`
    <div
      class="sidebar-zone-entry ${
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
    >
      ${content}
    </div>
  `;
}

export function renderAppSidebarPluginTab(
  host: AppSidebarRenderHost,
  tab: GatewayControlUiPluginTab,
) {
  const ref = { pluginId: tab.pluginId, id: tab.id };
  const key = pluginTabKey(ref);
  const routePlacement = tab.placement?.startsWith("route:")
    ? tab.placement.slice("route:".length)
    : "";
  const routeId = isRouteId(routePlacement) ? routePlacement : null;
  if (routeId) {
    return host.sidebarMenus.renderRoute(routeId);
  }
  const location = pluginTabLocation(tab, host.basePath);
  return renderSidebarNavLink({
    href: `${location.pathname}${location.search}`,
    icon: Object.entries(icons).find(([name]) => name === tab.icon)?.[1] ?? icons.plug,
    label: tab.label,
    active: host.activeRouteId === "plugin" && host.activePluginTabId === key,
    onNavigate: () => host.onNavigate?.("plugin", location),
  });
}
