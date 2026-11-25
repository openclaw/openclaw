import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import { isRouteId, pluginTabLocation, pluginTabKey } from "../app-route-paths.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import type { NativeGateway, NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { isHomePanelAvailable } from "../app/panel-availability.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../lib/keyboard-shortcut-contract.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { HoverMarquee } from "../lib/solid/hover-marquee.tsx";
import { renderSidebarNavLink as SidebarNavLink } from "./app-sidebar-nav-menus.tsx";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { iconData, type IconName } from "./icon-data.ts";
import { HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import { SidebarAttention } from "./sidebar-attention.tsx";
import { formatSidebarBuildSubtitle } from "./sidebar-build-chip-format.ts";
import { GatewayIdentityPlaceholder } from "./solid/gateway-connection-view.tsx";
import { GatewayStatus, gatewayStatusLabel } from "./solid/gateway-status.tsx";
import { Icon } from "./solid/icon.tsx";
import { ShortcutHint } from "./solid/kbd.tsx";
import { renderNewSessionLink as NewSessionLink } from "./solid/new-session-link.tsx";
import {
  renderSessionUnreadBadge,
  SessionGlyph,
  SessionRowBadges,
} from "./solid/session-presentation.tsx";

export type AppSidebarRenderHost = AppSidebarSessionNavigationElement & {
  readonly scroll?: { windowKeys(): string[] | undefined; rowFloor(): number };
  readonly nativeGatewaySnapshot: NativeGatewaysSnapshot | null;
  readonly people: import("./sidebar-people.ts").SidebarPeoplePreferences;
  readonly peopleView?: ReturnType<typeof import("./sidebar-people.ts").createSidebarPeople>;
  toggleSection(sectionId: string): void;
};

function readSidebarNativeGateway(host: AppSidebarRenderHost): NativeGateway | null {
  const snapshot = host.nativeGatewaySnapshot;
  return snapshot?.gateways.find((gateway) => gateway.id === snapshot.currentId) ?? null;
}

/**
 * The saved collapse choice. The page decides whether a sidebar shows at all, so a page
 * without one reads as collapsed; only this choice may expand or collapse the sidebar.
 */
export function sidebarCollapsedByChoice(host: AppSidebarRenderHost): boolean {
  return host.navigationCollapsedByChoice ?? host.navigationCollapsed;
}

/** The Sessions list is open beside the rail, so its agent row is on screen. */
export function sidebarSessionsListShown(host: AppSidebarRenderHost): boolean {
  return (
    host.navigationVisible &&
    !host.onExitSettings &&
    !host.navigationCollapsed &&
    host.navigationView === "sessions" &&
    !host.contextualSidebar
  );
}

/** Home opens the selected agent's main conversation in the dock, in either list mode. */
export function SidebarRailHome(props: { host: AppSidebarRenderHost }) {
  const host = () => props.host;
  const dock = createMemo(() => {
    const source = host().sessionDataContext?.assistantDock;
    return source && projectOwner(source, (owner) => owner.homeOpen);
  });
  const open = () => dock()?.read() ?? false;
  // The agent row carries the conversation's activity while the list is open.
  const home = () =>
    sidebarSessionsListShown(host()) ? null : host().visibleHomeSession(host().expandedAgentId());
  return (
    <openclaw-tooltip>
      <span slot="content">
        <ShortcutHint
          label={t("assistantPanel.toggle")}
          combo={KEYBOARD_SHORTCUT_COMBOS.homePanel}
        />
      </span>
      <button
        type="button"
        class="sidebar-rail__button sidebar-rail__home"
        aria-label={t("assistantPanel.toggle")}
        aria-pressed={open() ? "true" : "false"}
        disabled={!isHomePanelAvailable(host().sessionDataContext?.gateway)}
        onClick={(event) => {
          window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
          if (
            !isMobileNavLayout() &&
            !host().navigationCollapsed &&
            shouldHandleNavigationClick(event)
          ) {
            host().onToggleSidebar?.();
          }
        }}
      >
        <Show when={home()} fallback={<Icon name="house" filled={open()} />}>
          {(session) => {
            const running = () =>
              (session().isRunVisuallyActive ?? session().hasActiveRun) ||
              session().runningChildCount > 0;
            return (
              <>
                {/* Home is navigation, not an interactive session-attention target. */}
                <SessionGlyph
                  content={<Icon name="house" filled={open()} />}
                  running={running()}
                  queued={session().status === "queued" && session().runningChildCount === 0}
                  badge={
                    <Show when={session().unread && !running()}>{renderSessionUnreadBadge()}</Show>
                  }
                />
                <SessionRowBadges
                  outboxAttentionCount={session().outboxAttentionCount}
                  hasComposerDraft={session().hasComposerDraft}
                />
              </>
            );
          }}
        </Show>
      </button>
    </openclaw-tooltip>
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
  };
}

export function SidebarNewSessionAction(props: {
  host: Pick<
    AppSidebarRenderHost,
    "basePath" | "expandedAgentId" | "readNewSessionAccess" | "requestOpenNewSession"
  >;
  class: string;
}) {
  const disabledReason = createMemo(() => {
    const access = props.host.readNewSessionAccess();
    return access.allowed ? undefined : access.reason;
  });
  return (
    <NewSessionLink
      basePath={props.host.basePath}
      agentId={props.host.expandedAgentId()}
      class={props.class}
      label={t("agentChip.newConversation")}
      showShortcut
      disabledReason={disabledReason()}
      onOpen={(agentId) => props.host.requestOpenNewSession(agentId)}
    />
  );
}

export function renderAppSidebarFooterBar(host: AppSidebarRenderHost): SolidJSX.Element {
  const context = useApplication();
  const profileGateway = projectGateway(context.gateway);
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
              label={t("chat.openCommandPalette")}
              combo={KEYBOARD_SHORTCUT_COMBOS.commandPalette}
            />
          </span>
          <button
            type="button"
            class="sidebar-rail__button sidebar-brand__search sidebar-brand__desktop-control"
            aria-label={t("chat.openCommandPalette")}
            disabled={!host.onOpenPalette}
            onClick={() => host.onOpenPalette?.()}
          >
            <Icon name="search" />
          </button>
        </openclaw-tooltip>
        <Show when={host.newSessionInRail}>
          <SidebarNewSessionAction host={host} class="sidebar-rail__button sidebar-new-session" />
        </Show>
        <SidebarAttention
          cachedCount={host.sidebarSnapshot?.issuesCount}
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
          title={flagOpen() ? "" : (statusLabel() ?? "")}
          data-connection-status={connectionStatus() ?? (host.connected ? "connected" : undefined)}
          aria-label={identityLabel()}
          onClick={(event) => host.sidebarMenus.toggleIdentityMenu(event.currentTarget)}
        >
          <span class="sidebar-identity-card__avatar">
            <Show
              when={!host.connectionPending}
              fallback={<GatewayIdentityPlaceholder kind="user" />}
            >
              <openclaw-viewer-avatar prop:user={avatarUser()} variant="footer" />
            </Show>
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

export function renderAppSidebarPluginTab(
  host: AppSidebarRenderHost,
  tab: () => GatewayControlUiPluginTab,
  triggerRef?: (element: HTMLAnchorElement) => void,
): SolidJSX.Element {
  const routeId = createMemo(() => {
    const placement = tab().placement;
    const route = placement?.startsWith("route:") ? placement.slice("route:".length) : "";
    return isRouteId(route) ? route : null;
  });
  const location = createMemo(() => pluginTabLocation(tab(), host.basePath));
  const iconName = createMemo(() => {
    const icon = tab().icon;
    return icon && Object.hasOwn(iconData, icon)
      ? (icon as IconName) // SAFETY: The preceding own-key guard admits only keys of iconData.
      : "plug";
  });
  const active = () =>
    host.activeRouteId === "plugin" && host.activePluginTabId === pluginTabKey(tab());
  const link = (
    <SidebarNavLink
      ref={triggerRef}
      href={`${location().pathname}${location().search}`}
      icon={<Icon name={iconName()} filled={active()} />}
      label={tab().label}
      active={active()}
      onNavigate={() => host.onNavigate?.("plugin", location())}
    />
  );
  return (
    <Show when={routeId()} fallback={link} keyed>
      {(route) => host.sidebarMenus.renderRoute(route, host)}
    </Show>
  );
}
