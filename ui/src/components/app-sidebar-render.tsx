import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
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
import { KEYBOARD_SHORTCUT_COMBOS } from "../lib/keyboard-shortcut-contract.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { HoverMarquee } from "../lib/solid/hover-marquee.tsx";
import { pluginTabKey } from "../pages/plugin/route.ts";
import { renderSidebarNavLink as SidebarNavLink } from "./app-sidebar-nav-menus.tsx";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { iconData, type IconName } from "./icon-data.ts";
import { HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import { SidebarAgentCard } from "./sidebar-agent-card.tsx";
import { SidebarAttention } from "./sidebar-attention.tsx";
import { formatSidebarBuildSubtitle } from "./sidebar-build-chip-format.ts";
import { GatewayStatus, gatewayStatusLabel } from "./solid/gateway-status.tsx";
import { Icon } from "./solid/icon.tsx";
import { ShortcutHint } from "./solid/kbd.tsx";
import { renderSessionLeadingState, SessionRowBadges } from "./solid/session-presentation.tsx";
import "./theme-brand-icon.tsx";

export type AppSidebarRenderHost = AppSidebarSessionNavigationElement & {
  readonly nativeGatewaySnapshot: NativeGatewaysSnapshot | null;
  readonly people: import("./sidebar-people.ts").SidebarPeoplePreferences;
  readonly peopleView?: ReturnType<typeof import("./sidebar-people.ts").createSidebarPeople>;
  renderPinnedSidebarSession(session: () => SidebarRecentSession): JSX.Element;
  toggleSection(sectionId: string): void;
};

function readSidebarNativeGateway(host: AppSidebarRenderHost): NativeGateway | null {
  const snapshot = host.nativeGatewaySnapshot;
  return snapshot?.gateways.find((gateway) => gateway.id === snapshot.currentId) ?? null;
}

export function renderSidebarAgentCard(host: AppSidebarRenderHost): JSX.Element {
  let menuTrigger: HTMLButtonElement | undefined;
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
  const menuUnread = createMemo(() => host.otherAgentsHaveUnread());
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
      <openclaw-tooltip
        prop:content={cardName()}
        prop:descriptionTarget={() => menuTrigger ?? null}
      >
        <SidebarAgentCard
          onTriggerRef={(element) => (menuTrigger = element)}
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
          onContextMenu={(trigger, event) => {
            event.preventDefault();
            if (host.sidebarMenus.agentMenuPosition !== null) {
              return;
            }
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
  let button: HTMLButtonElement | undefined;
  const focusHeader = () => button?.focus();
  onCleanup(() => {
    if (host.sidebarMenus.focusAgentRoster === focusHeader) {
      host.sidebarMenus.focusAgentRoster = undefined;
    }
  });
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
    <openclaw-tooltip prop:content={name()} prop:descriptionTarget={() => button ?? null}>
      <div class="sidebar-workspace-header sidebar-workspace-header--rail">
        <button
          type="button"
          class="sidebar-workspace-header__main"
          ref={(element) => {
            button = element;
            host.sidebarMenus.focusAgentRoster = focusHeader;
          }}
          aria-haspopup="menu"
          aria-expanded={menuOpen() ? "true" : "false"}
          aria-label={`${name()} · ${t("agentChip.workspaceMenuLabel")}`}
          onPointerMove={(event) => {
            host.sidebarMenus.scheduleAgentMenuHoverOpen(event.currentTarget, event);
          }}
          onPointerLeave={() => host.sidebarMenus.handleAgentMenuTriggerPointerLeave()}
          onPointerDown={(event: PointerEvent) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            host.sidebarMenus.toggleAgentMenu(event.currentTarget);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            if (!menuOpen()) {
              host.sidebarMenus.toggleAgentMenu(event.currentTarget);
            }
          }}
        >
          {branding().brandIcon !== "claw" ? (
            <span
              class="sidebar-workspace-header__mark sidebar-workspace-header__mark--neutral"
              aria-hidden="true"
            >
              {branding().brandIcon === "mark" ? (
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
              <HoverMarquee
                content={name()}
                class="sidebar-agent-card__name-text"
                options={{ loop: true, delay: 300, speed: 35 }}
              />
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
  const context = useApplication();
  const profileGateway = projectGateway(context.gateway);
  const home = () => host.visibleHomeSession(host.expandedAgentId());
  const connectionStatus = () => host.connectionStatus;
  const selfUser = createMemo(() => {
    profileGateway.read();
    const gateway = host.sessionDataContext?.gateway;
    return gateway ? gatewayPresentationScope(gateway).displayUser : null;
  });
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
  const statusLabel = () =>
    host.gatewayStatus?.kind && (host.gatewayStatus.kind !== "connected" || host.connectionRecovery)
      ? gatewayStatusLabel(host.gatewayStatus.kind, host.gatewayStatus.queuedCount)
      : connectionStatus()
        ? t(`connection.${connectionStatus()}`)
        : null;
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
  const identityLabel = () =>
    identityDetail() ? `${identityMenuLabel()}: ${identityDetail()}` : identityMenuLabel();
  let identityAnchor!: HTMLDivElement;
  let flag!: HTMLDivElement;
  const [hovered, setHovered] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const [flagOpen, setFlagOpen] = createSignal(false);
  const flagKind = createMemo(() => (host.connectionFlagAllowed ? host.gatewayStatus?.kind : null));
  createEffect(
    () => ({
      kind: flagKind(),
      transition: host.connectionFlagVisible,
      hover: hovered(),
      focus: focused(),
      footerControlsOverlap: host.footerControlsOverlap,
    }),
    (request, previous) => {
      if (!request.kind || !(request.transition || request.hover || request.focus)) {
        setFlagOpen(false);
        return;
      }
      // Measure only new open requests, not exits held open by another input.
      if (
        previous &&
        request.kind === previous.kind &&
        (!request.transition || previous.transition) &&
        (!request.hover || previous.hover) &&
        (!request.focus || previous.focus)
      ) {
        return;
      }
      const anchor = identityAnchor.getBoundingClientRect();
      const { width, height } = flag.getBoundingClientRect();
      // The hidden flag has a box; anchor its resting rect without the slide transform.
      const overlaps = request.footerControlsOverlap?.({
        left: anchor.right,
        right: anchor.right + width,
        top: anchor.bottom - height,
        bottom: anchor.bottom,
      });
      setFlagOpen(!overlaps);
    },
  );
  return (
    <div class="sidebar-footer-bar sidebar-footer-bar--one-action">
      <span class="sidebar-footer-actions">
        <openclaw-tooltip>
          <span slot="content">
            <ShortcutHint
              label={t("assistantPanel.toggle")}
              combo={KEYBOARD_SHORTCUT_COMBOS.homePanel}
            />
          </span>
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
                    renderSessionLeadingState({
                      get session() {
                        return session();
                      },
                      attribution: "owned",
                      icon: (
                        <span class="nav-item__icon" aria-hidden="true">
                          <Icon name="home" />
                        </span>
                      ),
                    }).leadingIndicator
                  }
                  <SessionRowBadges
                    outboxAttentionCount={session().outboxAttentionCount}
                    hasComposerDraft={session().hasComposerDraft}
                  />
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
      <div
        ref={(element) => (identityAnchor = element)}
        class="sidebar-identity-anchor"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocusIn={() => setFocused(true)}
        onFocusOut={(event) =>
          setFocused(
            event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget),
          )
        }
      >
        <button
          type="button"
          class="sidebar-identity-card"
          aria-haspopup="menu"
          aria-expanded={host.sidebarMenus.identityMenuPosition !== null ? "true" : "false"}
          title={flagOpen() ? "" : identityLabel()}
          data-connection-status={connectionStatus() ?? (host.connected ? "connected" : undefined)}
          aria-label={identityLabel()}
          onClick={(event) => host.sidebarMenus.toggleIdentityMenu(event.currentTarget)}
        >
          <span class="sidebar-identity-card__avatar">
            <openclaw-viewer-avatar prop:user={avatarUser()} variant="footer" />
            <span class="sidebar-identity-card__status" aria-hidden="true" />
          </span>
          <span class="sidebar-identity-card__text">
            <HoverMarquee
              content={selfLabel()}
              class="sidebar-identity-card__name"
              options={{ loop: true, delay: 300, speed: 35 }}
            />
            {gateway() ? (
              <span class="sidebar-identity-card__gateway" aria-hidden="true">
                <span class="sidebar-gateway-name">{gateway()?.name}</span>
                {gatewayPrimaryTag() ? (
                  <span class="sidebar-gateway-primary">{gatewayPrimaryTag()}</span>
                ) : undefined}
              </span>
            ) : undefined}
          </span>
        </button>
        <Show when={flagKind()}>
          <div
            ref={(element) => (flag = element)}
            class="sidebar-connection-flag"
            data-open={flagOpen() ? "" : undefined}
          >
            <GatewayStatus {...host.gatewayStatus!} row />
          </div>
        </Show>
      </div>
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
      host.sidebarMenus.renderRoute(entry.route, host)
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
  triggerRef?: (element: HTMLAnchorElement) => void,
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
  const iconName = createMemo(() => {
    const icon = tab().icon;
    return icon && Object.hasOwn(iconData, icon)
      ? (icon as IconName) // SAFETY: The preceding own-key guard admits only keys of iconData.
      : "plug";
  });
  const link = (
    <SidebarNavLink
      ref={triggerRef}
      href={`${location().pathname}${location().search}`}
      icon={<Icon name={iconName()} />}
      label={tab().label}
      active={host.activeRouteId === "plugin" && host.activePluginTabId === key()}
      onNavigate={() => host.onNavigate?.("plugin", location())}
    />
  );
  return (
    <Show when={routeId()} fallback={link}>
      {(route) => host.sidebarMenus.renderRoute(route(), host)}
    </Show>
  );
}
