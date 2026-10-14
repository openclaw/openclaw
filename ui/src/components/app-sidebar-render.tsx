import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import { serializeSidebarEntry, type SidebarZoneEntry } from "../app-navigation.ts";
import { isRouteId, pluginTabLocation } from "../app-route-paths.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import type { NativeGateway, NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { isHomePanelAvailable } from "../app/panel-availability.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { hasSameOriginGatewayTransport } from "../dev-gateway.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import { pluginTabKey } from "../pages/plugin/route.ts";
import { renderSidebarNavLink } from "./app-sidebar-nav-menus.tsx";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { iconData, type IconName } from "./icon-data.ts";
// Tooltip still owns Lit contentTemplate rendering until its overlay port lands.
import { renderShortcutHint } from "./kbd.ts";
import { HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import { SidebarAgentCard } from "./sidebar-agent-card.tsx";
import { SidebarAttention } from "./sidebar-attention.tsx";
import { formatSidebarBuildSubtitle } from "./sidebar-build-chip-format.ts";
import { renderGatewayStatus } from "./solid/gateway-status.tsx";
import { Icon } from "./solid/icon.tsx";
import { renderSessionLeadingState, SessionRowBadges } from "./solid/session-presentation.tsx";
import "./theme-brand-icon.ts";

export type AppSidebarRenderHost = AppSidebarSessionNavigationElement & {
  teamOnlineExpanded: boolean;
  readonly nativeGatewaySnapshot: NativeGatewaysSnapshot | null;
  readonly people: import("./sidebar-people-controller.ts").SidebarPeopleController;
  renderPinnedSidebarSession(session: () => SidebarRecentSession): JSX.Element;
  toggleSection(sectionId: string): void;
};

function readSidebarNativeGateway(host: AppSidebarRenderHost): NativeGateway | null {
  const snapshot = host.nativeGatewaySnapshot;
  return snapshot?.gateways.find((gateway) => gateway.id === snapshot.currentId) ?? null;
}

export function renderSidebarAgentCard(host: AppSidebarRenderHost): JSX.Element {
  const chipAgent = createMemo(() => host.activeChipAgent()),
    cardAgentId = () => chipAgent().activeId,
    rosterAgent = () => chipAgent().agent,
    cardAgents = () => chipAgent().agents,
    cardIdentity = () => chipAgent().identity;
  const gateway = () => host.sessionDataContext?.gateway;
  const bootstrapIdentity = createMemo(() =>
    gateway() && hasSameOriginGatewayTransport(gateway()?.connection.gatewayUrl ?? "")
      ? host.sessionDataContext?.config.current.assistantIdentity
      : undefined,
  );
  const cardAgent = createMemo(
    () =>
      rosterAgent() ??
      (bootstrapIdentity()?.agentId === cardAgentId()
        ? {
            id: cardAgentId(),
            name: bootstrapIdentity()?.name,
            identity: { avatar: bootstrapIdentity()?.avatar ?? undefined },
          }
        : undefined),
  );
  const cached = () =>
    host.sidebarSnapshot?.mode === "chip" && host.sidebarSnapshot.brand.agentId === cardAgentId()
      ? host.sidebarSnapshot.brand
      : null;
  const menuUnread = createMemo(() =>
    cardAgents().some((entry) => {
      const agentId = normalizeAgentId(entry.id);
      return agentId !== cardAgentId() && host.agentUnreadCount(agentId) > 0;
    }),
  );
  const cardName = createMemo(() => {
    const agent = cardAgent();
    return cached()?.name ?? (agent ? normalizeAgentLabel(agent, cardIdentity()) : "");
  });
  const avatarAuthReady = createMemo(() =>
    Boolean(
      gateway() &&
      (gateway()?.snapshot.hello ||
        gateway()?.connection.token.trim() ||
        gateway()?.connection.password.trim() ||
        bootstrapIdentity()?.agentId === cardAgentId()),
    ),
  );
  return (
    <Show
      when={host.sidebarAgentsMode !== "roster" && (cardAgent() || cached())}
      fallback={renderSidebarWorkspaceHeader(host)}
    >
      <openclaw-tooltip prop:content={cardName()}>
        <SidebarAgentCard
          compact={true}
          agentName={cardName()}
          agentId={cardAgentId()}
          avatarUrl={
            cached()
              ? cached()!.avatar
              : cardAgent()
                ? resolveAgentAvatarUrl(cardAgent()!, cardIdentity())
                : null
          }
          avatarAuthReady={avatarAuthReady()}
          avatarText={
            cached()
              ? (cached()!.textAvatar ?? null)
              : cardAgent()
                ? resolveAgentTextAvatar(cardAgent()!, cardIdentity())
                : null
          }
          environment={host.sessionDataContext?.config?.current?.environment ?? null}
          menuOpen={host.sidebarMenus.agentMenuPosition !== null}
          menuUnread={menuUnread()}
          switcherAvailable={cardAgents().length > 1}
          onToggleMenu={(trigger: HTMLElement) => host.sidebarMenus.toggleAgentMenu(trigger)}
          onMenuPointerMove={(trigger: HTMLElement, event: PointerEvent) =>
            host.sidebarMenus.scheduleAgentMenuHoverOpen(trigger, event)
          }
          onMenuPointerLeave={() => host.sidebarMenus.handleAgentMenuTriggerPointerLeave()}
          onContextMenu={(event) => {
            event.preventDefault();
            if (host.sidebarMenus.agentMenuPosition !== null) {
              return;
            }
            const card = event.currentTarget;
            const trigger = card.querySelector<HTMLElement>(".sidebar-agent-card__main") ?? card;
            host.sidebarMenus.toggleAgentMenu(trigger);
          }}
        />
      </openclaw-tooltip>
    </Show>
  );
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
        : readSidebarNativeGateway(host)?.name.trim() || branding.brandName,
    avatar:
      host.sidebarAgentsMode === "chip" && chip.agent
        ? resolveAgentAvatarUrl(chip.agent, chip.identity)
        : (config?.assistantIdentity.avatar ?? null),
    icon: branding.brandIcon,
    iconUrl: branding.artwork?.icons?.[branding.brandIcon]?.url,
    environment: config?.environment?.label ?? null,
  };
}

function renderSidebarWorkspaceHeader(host: AppSidebarRenderHost): JSX.Element {
  const currentBranding = () => host.sessionDataContext?.theme.branding ?? currentThemeBranding();
  const cached = () => (host.sidebarSnapshot?.brand.agentId ? null : host.sidebarSnapshot?.brand);
  const brand = () => cached() ?? readSidebarBrandPresentation(host);
  const branding = createMemo(() => {
    const current = currentBranding();
    const saved = cached();
    if (!saved) {
      return current;
    }
    const url = saved.iconUrl;
    return {
      ...current,
      brandName: saved.name,
      brandIcon: saved.icon,
      artwork: url ? { icons: { [saved.icon]: { url } } } : undefined,
    };
  });
  const name = () => brand().name;
  const menuOpen = () => host.sidebarMenus.agentMenuPosition !== null;
  return (
    <openclaw-tooltip prop:content={name()}>
      <div class="sidebar-workspace-header sidebar-workspace-header--rail">
        <button
          type="button"
          class="sidebar-workspace-header__main"
          aria-haspopup="menu"
          aria-expanded={menuOpen() ? "true" : "false"}
          aria-label={`${name()} · ${t("agentChip.workspaceMenuLabel")}`}
          onPointerMove={(event: PointerEvent) => {
            if (event.currentTarget instanceof HTMLElement) {
              host.sidebarMenus.scheduleAgentMenuHoverOpen(event.currentTarget, event);
            }
          }}
          onPointerLeave={() => host.sidebarMenus.handleAgentMenuTriggerPointerLeave()}
          onPointerDown={(event: PointerEvent) => event.stopPropagation()}
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            if (event.currentTarget instanceof HTMLElement) {
              host.sidebarMenus.toggleAgentMenu(event.currentTarget);
            }
          }}
          onContextMenu={(event: MouseEvent) => {
            event.preventDefault();
            if (!menuOpen() && event.currentTarget instanceof HTMLElement) {
              host.sidebarMenus.toggleAgentMenu(event.currentTarget);
            }
          }}
        >
          {branding().brandIcon !== "claw" ? (
            <span
              class="sidebar-workspace-header__mark sidebar-workspace-header__mark--neutral"
              aria-hidden="true"
            >
              {branding().brandIcon === "claw" ? (
                <Icon name="lobster" />
              ) : branding().brandIcon === "mark" ? (
                <Icon name="mark" />
              ) : (
                <openclaw-theme-brand-icon prop:branding={branding()} aria-hidden="true" />
              )}
            </span>
          ) : (
            <span class="sidebar-workspace-header__mark" aria-hidden="true">
              <Icon name="lobster" />
            </span>
          )}
          <span class="sidebar-agent-card__text">
            <span class="sidebar-agent-card__name">
              {renderHoverMarquee(name(), "sidebar-agent-card__name-text", {
                loop: true,
                delay: 300,
                speed: 35,
              })}
              <span class="sidebar-agent-card__chevron" aria-hidden="true">
                <Icon name="chevronsUpDown" />
              </span>
            </span>
            {host.sessionDataContext?.config.current.environment ? (
              <span class="control-ui-environment-pill">
                {host.sessionDataContext.config.current.environment.label}
              </span>
            ) : undefined}
          </span>
        </button>
      </div>
    </openclaw-tooltip>
  );
}

export function renderAppSidebarFooterBar(host: AppSidebarRenderHost): JSX.Element {
  const home = () => host.visibleHomeSession(host.expandedAgentId());
  const connectionStatus = () => host.connectionStatus;
  const selfUser = () =>
    host.sessionDataContext
      ? gatewayPresentationScope(host.sessionDataContext.gateway).displayUser
      : null;
  const displayUser = () => selfUser() ?? host.sidebarSnapshot?.footer;
  const selfLabel = () => displayUser()?.name ?? displayUser()?.email ?? t("nav.owner");
  const avatarUser = createMemo(() => ({
    id: "owner",
    ...displayUser(),
    name: selfLabel(),
    watchedSessions: [],
  }));
  const gateway = () => readSidebarNativeGateway(host);
  const buildSubtitle = () => formatSidebarBuildSubtitle(CONTROL_UI_BUILD_INFO);
  const gatewayPrimaryTag = () => (gateway()?.isPrimary ? t("nav.gateway.primaryTag") : null);
  const identityMenuLabel = () => t("profilePage.identity.menuButtonLabel", { name: selfLabel() });
  const statusLabel = () => (connectionStatus() ? t(`connection.${connectionStatus()}`) : null);
  const identityDetail = () => {
    const status = statusLabel();
    const selectedGateway = gateway();
    return (
      status ??
      (selectedGateway
        ? `${selectedGateway.name}${gatewayPrimaryTag() ? `, ${gatewayPrimaryTag()}` : ""}`
        : buildSubtitle())
    );
  };
  const announcement = () => statusLabel() ?? (host.connected ? t("nav.gateway.connected") : "");
  return (
    <div class="sidebar-footer-bar sidebar-footer-bar--one-action">
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement()}
      </span>
      <span class="sidebar-footer-actions">
        <openclaw-tooltip
          prop:content={`${t("assistantPanel.toggle")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.homePanel)})`}
          prop:contentTemplate={renderShortcutHint(
            t("assistantPanel.toggle"),
            KEYBOARD_SHORTCUT_COMBOS.homePanel,
          )}
        >
          <button
            type="button"
            class="sidebar-brand__icon sidebar-footer-bar__home"
            aria-label={t("assistantPanel.toggle")}
            disabled={!isHomePanelAvailable(host.sessionDataContext?.gateway)}
            onClick={(event) => {
              window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
              if (
                !isMobileNavLayout() &&
                !host.navigationCollapsed &&
                shouldHandleNavigationClick(event)
              ) {
                host.onToggleSidebar?.();
              }
            }}
          >
            <Show when={home()} fallback={<Icon name="home" />}>
              {(session) => (
                <>
                  {
                    renderSessionLeadingState(
                      session(),
                      undefined,
                      "owned",
                      undefined,
                      undefined,
                      false,
                      <span class="nav-item__icon" aria-hidden="true">
                        <Icon name="home" />
                      </span>,
                    ).leadingIndicator
                  }
                  {
                    <SessionRowBadges
                      outboxAttentionCount={session().outboxAttentionCount}
                      hasComposerDraft={session().hasComposerDraft}
                    />
                  }
                </>
              )}
            </Show>
          </button>
        </openclaw-tooltip>
        <SidebarAttention
          activeRouteId={host.activeRouteId}
          onNavigate={host.onNavigate}
          watchUpdateProgress={host.watchUpdateProgress}
        />
      </span>
      <button
        type="button"
        class="sidebar-identity-card"
        aria-haspopup="menu"
        aria-expanded={host.sidebarMenus.identityMenuPosition !== null ? "true" : "false"}
        title={
          identityDetail() ? `${identityMenuLabel()}: ${identityDetail()}` : identityMenuLabel()
        }
        data-connection-status={connectionStatus() ?? undefined}
        aria-label={
          identityDetail() ? `${identityMenuLabel()}: ${identityDetail()}` : identityMenuLabel()
        }
        onClick={(event) => host.sidebarMenus.toggleIdentityMenu(event.currentTarget)}
      >
        <openclaw-viewer-avatar prop:user={avatarUser()} variant="footer" />
        <span class="sidebar-identity-card__text">
          {renderHoverMarquee(selfLabel(), "sidebar-identity-card__name", {
            loop: true,
            delay: 300,
            speed: 35,
          })}
          {connectionStatus() ? (
            renderGatewayStatus({
              get kind() {
                return connectionStatus();
              },
              get lastError() {
                return host.lastError;
              },
              announce: false,
            })
          ) : gateway() ? (
            <span class="sidebar-identity-card__gateway" aria-hidden="true">
              <span class="sidebar-gateway-name">{gateway()?.name}</span>
              {gatewayPrimaryTag() ? (
                <span class="sidebar-gateway-primary">{gatewayPrimaryTag()}</span>
              ) : undefined}
            </span>
          ) : undefined}
        </span>
      </button>
    </div>
  );
}

export function renderAppSidebarPageEntry(
  host: AppSidebarRenderHost,
  entry: SidebarZoneEntry,
  sessionRows: () => ReadonlyMap<string, SidebarRecentSession>,
  pluginTabs: () => ReadonlyMap<string, GatewayControlUiPluginTab>,
): JSX.Element {
  if (entry.type === "person") {
    return undefined;
  }
  const serialized = serializeSidebarEntry(entry);
  const pluginTab = () => (entry.type === "plugin" ? pluginTabs().get(entry.key) : undefined);
  const pinnedSession = () => (entry.type === "session" ? sessionRows().get(entry.key) : undefined);
  const content =
    entry.type === "route" ? (
      host.sidebarMenus.renderRoute(entry.route)
    ) : entry.type === "plugin" ? (
      <Show
        when={pluginTab()}
        fallback={
          <openclaw-plugin-contributions
            prop:kind={"navigation"}
            prop:navigationKey={entry.key}
            prop:navigationChildren={false}
            prop:navigationMenus={host.sidebarMenus}
          />
        }
      >
        {(tab) => renderAppSidebarPluginTab(host, tab)}
      </Show>
    ) : (
      <Show when={pinnedSession()}>{(session) => host.renderPinnedSidebarSession(session)}</Show>
    );
  const draggable = () =>
    !host.sidebarSnapshot && (entry.type === "route" || entry.type === "plugin");
  return (
    <div
      class={[
        "sidebar-zone-entry",
        {
          "sidebar-zone-entry--dragging": host.sessionOrganizer.draggingSidebarEntry === serialized,
        },
      ]}
      data-sidebar-entry={serialized}
      draggable={draggable() ? "true" : "false"}
      onDragStart={
        entry.type === "route"
          ? (event: DragEvent) => host.sessionOrganizer.startSidebarRouteDrag(event, entry.route)
          : entry.type === "plugin"
            ? (event: DragEvent) => host.sessionOrganizer.startSidebarPluginDrag(event, entry.key)
            : undefined
      }
      onDragEnd={() => {
        if (draggable()) {
          host.sessionOrganizer.finishSidebarEntryDrag();
        }
      }}
    >
      {content}
    </div>
  );
}

export function renderAppSidebarPluginTab(
  host: AppSidebarRenderHost,
  tab: () => GatewayControlUiPluginTab,
): JSX.Element {
  const ref = () => ({ pluginId: tab().pluginId, id: tab().id });
  const key = () => pluginTabKey(ref());
  const routePlacement = () => {
    const placement = tab().placement;
    return placement?.startsWith("route:") ? placement.slice("route:".length) : "";
  };
  const routeId = createMemo(() => {
    const route = routePlacement();
    return isRouteId(route) ? route : null;
  });
  const location = createMemo(() => pluginTabLocation(tab(), host.basePath));
  const link = renderSidebarNavLink({
    get href() {
      return `${location().pathname}${location().search}`;
    },
    get icon() {
      const icon = tab().icon;
      return (
        <Icon
          name={
            icon && Object.hasOwn(iconData, icon)
              ? (icon as IconName) // SAFETY: The preceding own-key guard admits only keys of iconData.
              : "plug"
          }
        />
      );
    },
    get label() {
      return tab().label;
    },
    get active() {
      return host.activeRouteId === "plugin" && host.activePluginTabId === key();
    },
    onNavigate: () => host.onNavigate?.("plugin", location()),
  });
  return (
    <Show when={routeId()} fallback={link}>
      {(route) => host.sidebarMenus.renderRoute(route())}
    </Show>
  );
}
