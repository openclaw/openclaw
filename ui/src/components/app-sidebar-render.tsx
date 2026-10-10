import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import { serializeSidebarEntry, titleForRoute, type SidebarZoneEntry } from "../app-navigation.ts";
import { isRouteId, isSessionRouteId, pluginTabLocation } from "../app-route-paths.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
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
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import { pluginTabKey } from "../pages/plugin/route.ts";
import { renderSidebarNavLink } from "./app-sidebar-nav-menus.tsx";
import { renderSidebarSessionFilter } from "./app-sidebar-session-filter-summary.tsx";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons, type IconName } from "./icons.ts";
// Tooltip still owns Lit contentTemplate rendering until its overlay port lands.
import { renderShortcutHint } from "./kbd.ts";
import { HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import { sessionAttentionTooltipLabel } from "./session-attention-presentation.ts";
import { formatSidebarBuildSubtitle } from "./sidebar-build-chip-format.ts";
import { renderSidebarReorderMenu } from "./sidebar-reorder.tsx";
import { renderGatewayStatus } from "./solid/gateway-status.tsx";
import { Icon } from "./solid/icon.tsx";
import { renderNewSessionLink } from "./solid/new-session-link.tsx";
import {
  renderSessionAttentionIcon,
  renderSessionGlyph,
  renderSessionUnreadBadge,
  renderSessionRowBadges,
} from "./solid/session-presentation.tsx";
import { renderThemeBrandIcon } from "./solid/theme-brand-icon.tsx";

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

function renderSidebarAgentCard(host: AppSidebarRenderHost): JSX.Element {
  const chipAgent = createMemo(() => host.activeChipAgent()),
    cardAgentId = createMemo(() => chipAgent().activeId),
    rosterAgent = createMemo(() => chipAgent().agent, { equals: false }),
    cardAgents = createMemo(() => chipAgent().agents, { equals: false }),
    cardIdentity = createMemo(() => chipAgent().identity, { equals: false });
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
  const menuUnread = createMemo(() =>
    cardAgents().some((entry) => {
      const agentId = normalizeAgentId(entry.id);
      return agentId !== cardAgentId() && host.agentUnreadCount(agentId) > 0;
    }),
  );
  const cardName = createMemo(() => {
    const agent = cardAgent();
    return agent ? normalizeAgentLabel(agent, cardIdentity()) : "";
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
    <Show when={cardAgent()} fallback={renderSidebarWorkspaceHeader(host)}>
      <openclaw-sidebar-agent-card
        prop:agentName={cardName()}
        prop:agentId={cardAgentId()}
        prop:avatarUrl={
          cardAgent() ? resolveAgentAvatarUrl(cardAgent()!, cardIdentity()) : undefined
        }
        prop:avatarAuthReady={avatarAuthReady()}
        prop:avatarText={cardAgent() ? resolveAgentTextAvatar(cardAgent()!, cardIdentity()) : null}
        prop:environment={host.sessionDataContext?.config?.current?.environment ?? null}
        prop:menuOpen={host.sidebarMenus.agentMenuPosition !== null}
        prop:menuUnread={menuUnread()}
        prop:switcherAvailable={cardAgents().length > 1}
        prop:onToggleMenu={(trigger: HTMLElement) => host.sidebarMenus.toggleAgentMenu(trigger)}
        prop:onMenuPointerMove={(trigger: HTMLElement, event: PointerEvent) =>
          host.sidebarMenus.scheduleAgentMenuHoverOpen(trigger, event)
        }
        prop:onMenuPointerLeave={() => host.sidebarMenus.handleAgentMenuTriggerPointerLeave()}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          if (host.sidebarMenus.agentMenuPosition !== null) {
            return;
          }
          const card = event.currentTarget as HTMLElement;
          const trigger = card.querySelector<HTMLElement>(".sidebar-agent-card__main") ?? card;
          host.sidebarMenus.toggleAgentMenu(trigger);
        }}
      />
    </Show>
  );
}

function renderSidebarWorkspaceHeader(host: AppSidebarRenderHost): JSX.Element {
  const branding = createMemo(
    () => host.sessionDataContext?.theme.branding ?? currentThemeBranding(),
  );
  const name = createMemo(
    () => readSidebarNativeGateway(host)?.name.trim() || branding().brandName,
  );
  const menuOpen = createMemo(() => host.sidebarMenus.agentMenuPosition !== null);
  return (
    <div class="sidebar-workspace-header">
      <button
        type="button"
        class="sidebar-workspace-header__main"
        aria-haspopup="menu"
        aria-expanded={String(menuOpen())}
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
            {renderThemeBrandIcon(<Icon name="lobster" />, branding())}
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
  );
}

export function renderAppSidebarBrand(
  host: AppSidebarRenderHost,
  teamNewSession?: JSX.Element,
): JSX.Element {
  const newSessionAccess = createMemo(() => host.readNewSessionAccess());
  const collapseLabel = createMemo(() => t("nav.collapse"));
  return (
    <div class="sidebar-brand">
      {host.sidebarAgentsMode === "roster"
        ? renderSidebarWorkspaceHeader(host)
        : renderSidebarAgentCard(host)}
      <div class="sidebar-brand__actions">
        <openclaw-tooltip
          prop:content={`${collapseLabel()} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar)})`}
          prop:contentTemplate={renderShortcutHint(
            collapseLabel(),
            KEYBOARD_SHORTCUT_COMBOS.toggleSidebar,
          )}
        >
          <button
            type="button"
            class="sidebar-brand__icon sidebar-brand__header-control sidebar-brand__desktop-control sidebar-brand__collapse"
            aria-label={collapseLabel()}
            aria-expanded="true"
            disabled={!host.onToggleSidebar}
            onClick={() => host.onToggleSidebar?.()}
          >
            <Icon name="panelLeftClose" />
          </button>
        </openclaw-tooltip>
        <openclaw-tooltip
          prop:content={`${t("chat.openCommandPalette")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette)})`}
          prop:contentTemplate={renderShortcutHint(
            t("chat.openCommandPalette"),
            KEYBOARD_SHORTCUT_COMBOS.commandPalette,
          )}
        >
          <button
            type="button"
            class="sidebar-brand__icon sidebar-brand__header-control sidebar-brand__desktop-control sidebar-brand__search"
            aria-label={t("chat.openCommandPalette")}
            disabled={!host.onOpenPalette}
            onClick={() => host.onOpenPalette?.()}
          >
            <Icon name="search" />
          </button>
        </openclaw-tooltip>
        {host.sidebarAgentsMode === "roster"
          ? renderSidebarSessionFilter(host, "sidebar-brand__icon sidebar-brand__header-control")
          : undefined}
        {host.sidebarAgentsMode === "roster"
          ? teamNewSession
          : renderNewSessionLink({
              get basePath() {
                return host.basePath;
              },
              get agentId() {
                return host.expandedAgentId();
              },
              className:
                "sidebar-brand__icon sidebar-brand__header-control sidebar-brand__new-thread",
              get label() {
                return t("agentChip.newConversation");
              },
              showShortcut: true,
              get disabledReason() {
                const access = newSessionAccess();
                return access.allowed ? undefined : access.reason;
              },
              onOpen: (agentId, target) => host.requestOpenNewSession(agentId, target),
            })}
      </div>
    </div>
  );
}

/** Home: the first page. Opens the rolling main session on its saved face. */
export function renderAppSidebarHomeRow(host: AppSidebarRenderHost): JSX.Element {
  const agentId = createMemo(() => host.expandedAgentId());
  const mainKey = createMemo(() => host.selectedAgentMainSessionKey(agentId()));
  const mainRow = createMemo(() => host.mainSessionRow(agentId()), { equals: false });
  const session = createMemo(
    () => (mainRow() ? host.projectHomeSession(mainRow()!, agentId()) : null),
    { equals: false },
  );
  const attention = createMemo(
    () =>
      session()?.attention ?? host.resolveSessionAttention({ key: mainKey(), agentId: agentId() }),
  );
  const attentionLabel = createMemo(() => sessionAttentionTooltipLabel(attention()));
  const outboxAttentionCount = createMemo(
    () => host.storedOutboxes?.attentionCountForSession(mainKey()) ?? 0,
  );
  const active = createMemo(
    () =>
      isSessionRouteId(host.activeRouteId) &&
      areUiSessionKeysEquivalent(host.getRouteSessionKey(), mainKey()),
  );
  const hasComposerDraft = createMemo(
    () => host.storedOutboxes?.hasSessionDraft(mainKey()) ?? false,
  );
  const ownRun = createMemo(() => (mainRow() ? isSessionRunActive(mainRow()!) : false));
  const subagentsWorking = createMemo(() => (session()?.runningChildCount ?? 0) > 0);
  const running = createMemo(() => ownRun() || subagentsWorking());
  const queued = createMemo(
    () => ownRun() && mainRow()?.status === "queued" && !subagentsWorking(),
  );
  const unread = createMemo(
    () => (mainRow()?.unread === true || (session()?.unreadChildCount ?? 0) > 0) && !active(),
  );
  const activeRunLabel = createMemo(() =>
    running()
      ? t(
          subagentsWorking() && (!ownRun() || mainRow()?.status === "queued")
            ? "sessionsView.subagentsWorking"
            : queued()
              ? "sessionsView.statusQueued"
              : "sessionsView.activeRun",
        )
      : "",
  );
  const unreadLabel = createMemo(() => (unread() ? t("sessionsView.unread") : ""));
  const homeDescription = createMemo(() =>
    attentionLabel() || (activeRunLabel() && unreadLabel())
      ? [attentionLabel(), activeRunLabel(), unreadLabel()].filter(Boolean).join(" · ")
      : "",
  );
  const homeGlyph = createMemo(() =>
    renderSessionGlyph({
      get content() {
        return attention().kind === "none" ? (
          <span class="nav-item__icon" aria-hidden="true">
            <Icon name="home" />
          </span>
        ) : (
          renderSessionAttentionIcon(attention())
        );
      },
      get running() {
        return running();
      },
      get queued() {
        return queued();
      },
      get runningLabel() {
        return activeRunLabel();
      },
      get badge() {
        return unread() && !running() ? renderSessionUnreadBadge() : undefined;
      },
    }),
  );
  return (
    <Show when={host.sidebarAgentsMode !== "roster"}>
      <a
        href={
          sessionNavigationTarget({
            face: resolveSessionPreferredFace(mainRow()),
            sessionKey: mainKey(),
            fallbackAgentId: agentId(),
            basePath: host.basePath,
            row: mainRow() ?? undefined,
            mainKey: parseAgentSessionKey(mainKey())?.rest,
            preferenceDerivedFace: true,
          }).href
        }
        class={["nav-item nav-item--home", { "nav-item--active": active() }]}
        aria-label={homeDescription() ? `${t("nav.home")} · ${homeDescription()}` : undefined}
        aria-current={active() ? "page" : undefined}
        onClick={(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          host.openMainSession(agentId());
        }}
      >
        {homeGlyph()}
        <span class="nav-item__text">{t("nav.home")}</span>
        {outboxAttentionCount() > 0 || hasComposerDraft() ? (
          <span class="nav-item__state sidebar-home-session-states">
            {renderSessionRowBadges({
              get outboxAttentionCount() {
                return outboxAttentionCount();
              },
              get hasComposerDraft() {
                return hasComposerDraft();
              },
            })}
          </span>
        ) : undefined}
      </a>
    </Show>
  );
}

export function renderAppSidebarPagesHead(
  host: AppSidebarRenderHost,
  row: JSX.Element,
): JSX.Element {
  return (
    <div class="sidebar-nav__lead">
      {row}
      <span class="sidebar-recent-sessions__label-text sr-only">{t("nav.pages")}</span>
      <span class="sidebar-nav__head-slot">
        <button
          type="button"
          class="sidebar-nav__head-action"
          aria-haspopup="menu"
          aria-expanded={String(host.sidebarMenus.moreMenuPosition !== null)}
          aria-label={t("nav.customize")}
          onClick={(event: MouseEvent) =>
            host.sidebarMenus.togglePositionedMenu("more", event.currentTarget as HTMLElement)
          }
        >
          <Icon name="penLine" />
        </button>
      </span>
    </div>
  );
}

export function renderAppSidebarFooterBar(host: AppSidebarRenderHost): JSX.Element {
  const connectionStatus = createMemo(() => host.connectionStatus);
  const selfUser = createMemo(
    () =>
      host.sessionDataContext
        ? gatewayPresentationScope(host.sessionDataContext.gateway).displayUser
        : null,
    { equals: false },
  );
  const selfLabel = createMemo(() => selfUser()?.name ?? selfUser()?.email ?? t("nav.owner"));
  const avatarUser = createMemo(() => ({
    id: "owner",
    ...selfUser(),
    name: selfLabel(),
    watchedSessions: [],
  }));
  const gateway = () => readSidebarNativeGateway(host);
  const buildSubtitle = createMemo(() => formatSidebarBuildSubtitle(CONTROL_UI_BUILD_INFO));
  const gatewayPrimaryTag = createMemo(() =>
    gateway()?.isPrimary ? t("nav.gateway.primaryTag") : null,
  );
  const identityMenuLabel = createMemo(() =>
    t("profilePage.identity.menuButtonLabel", { name: selfLabel() }),
  );
  const statusLabel = createMemo(() =>
    connectionStatus() ? t(`connection.${connectionStatus()}`) : null,
  );
  const identityDetail = createMemo(() =>
    statusLabel()
      ? statusLabel()
      : gateway()
        ? `${gateway().name}${gatewayPrimaryTag() ? `, ${gatewayPrimaryTag()}` : ""}`
        : buildSubtitle(),
  );
  const announcement = createMemo(
    () => statusLabel() ?? (host.connected ? t("nav.gateway.connected") : ""),
  );
  return (
    <div class="sidebar-footer-bar sidebar-footer-bar--one-action">
      <button
        type="button"
        class="sidebar-identity-card"
        aria-haspopup="menu"
        aria-expanded={String(host.sidebarMenus.identityMenuPosition !== null)}
        aria-label={
          identityDetail() ? `${identityMenuLabel()}: ${identityDetail()}` : identityMenuLabel()
        }
        onClick={(event: MouseEvent) =>
          host.sidebarMenus.toggleIdentityMenu(event.currentTarget as HTMLElement)
        }
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
              <span class="sidebar-gateway-name">{gateway().name}</span>
              {gatewayPrimaryTag() ? (
                <span class="sidebar-gateway-primary">{gatewayPrimaryTag()}</span>
              ) : undefined}
            </span>
          ) : undefined}
        </span>
      </button>
      <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement()}
      </span>
      <span class="sidebar-footer-actions">
        {isHomePanelAvailable(host.sessionDataContext?.gateway) ? (
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
              onClick={() => window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT))}
            >
              <Icon name="home" />
            </button>
          </openclaw-tooltip>
        ) : undefined}
        <openclaw-sidebar-attention
          prop:activeRouteId={host.activeRouteId}
          prop:onNavigate={host.onNavigate}
          prop:watchUpdateProgress={host.watchUpdateProgress}
        />
      </span>
    </div>
  );
}

export function renderAppSidebarZoneEntry(
  host: AppSidebarRenderHost,
  entry: SidebarZoneEntry,
  sessionRows: () => ReadonlyMap<string, SidebarRecentSession>,
  pluginTabs: () => ReadonlyMap<string, GatewayControlUiPluginTab>,
  lead: () => boolean,
): JSX.Element {
  const serialized = createMemo(() => serializeSidebarEntry(entry));
  const dropPosition = createMemo(() =>
    host.sessionOrganizer.sidebarZoneDropTarget?.entry === serialized()
      ? host.sessionOrganizer.sidebarZoneDropTarget.position
      : null,
  );
  const pluginTab = createMemo(() =>
    entry.type === "plugin" ? pluginTabs().get(entry.key) : undefined,
  );
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
            prop:navigationMenus={host.sidebarMenus}
          />
        }
      >
        {(tab) => renderAppSidebarPluginTab(host, tab)}
      </Show>
    ) : (
      <Show when={pinnedSession()}>{(session) => host.renderPinnedSidebarSession(session)}</Show>
    );
  const draggable = entry.type === "route" || entry.type === "plugin";
  const label = createMemo(() =>
    entry.type === "route"
      ? titleForRoute(entry.route)
      : entry.type === "session"
        ? (sessionRows().get(entry.key)?.label ?? entry.key)
        : (pluginTab()?.label ??
          host.pluginNavigation().find((item) => item.key === entry.key)?.value.label ??
          entry.key),
  );
  return (
    <div
      class={[
        "sidebar-zone-entry",
        dropPosition() ? `sidebar-zone-entry--drop-${dropPosition()}` : undefined,
        {
          "sidebar-zone-entry--dragging":
            host.sessionOrganizer.draggingSidebarEntry === serialized(),
        },
      ]}
      data-sidebar-entry={serialized()}
      draggable={draggable ? "true" : "false"}
      onDragStart={
        entry.type === "route"
          ? (event: DragEvent) => host.sessionOrganizer.startSidebarRouteDrag(event, entry.route)
          : entry.type === "plugin"
            ? (event: DragEvent) => host.sessionOrganizer.startSidebarPluginDrag(event, entry.key)
            : undefined
      }
      onDragEnd={draggable ? () => host.sessionOrganizer.finishSidebarEntryDrag() : undefined}
      onDragOver={(event: DragEvent) =>
        host.sessionOrganizer.handleSidebarZoneDragOver(event, serialized())
      }
      onDrop={(event: DragEvent) =>
        host.sessionOrganizer.handleSidebarZoneDrop(event, serialized())
      }
    >
      {lead() ? renderAppSidebarPagesHead(host, content) : content}
      {renderSidebarReorderMenu({
        get label() {
          return label();
        },
        kind: "entry",
        onMove: async (target, position) => {
          host.sessionOrganizer.writeSidebarEntryAt(serialized(), target, position);
          host.requestUpdate();
          await host.updateComplete;
        },
      })}
    </div>
  );
}

function renderAppSidebarPluginTab(
  host: AppSidebarRenderHost,
  tab: () => GatewayControlUiPluginTab,
): JSX.Element {
  const ref = createMemo(() => ({ pluginId: tab().pluginId, id: tab().id }));
  const key = createMemo(() => pluginTabKey(ref()));
  const routePlacement = createMemo(() =>
    tab().placement?.startsWith("route:") ? tab().placement.slice("route:".length) : "",
  );
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
      return (
        <Icon
          name={tab().icon && Object.hasOwn(icons, tab().icon) ? (tab().icon as IconName) : "plug"}
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
