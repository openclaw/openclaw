import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createEffect, createMemo, For, onSettled, Show } from "solid-js";
import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import type { AgentsListResult } from "../api/types.ts";
import {
  isSettingsNavigationRouteVisible,
  navigationIconForRoute,
  SETTINGS_SEARCHABLE_SUBPAGE_ROUTES,
  subtitleForRoute,
  titleForRoute,
  visibleSettingsNavigationGroups,
  type SettingsSearchBlock,
} from "../app-navigation.ts";
import { pathForRoute, type RouteId } from "../app-route-paths.ts";
import type { AgentSelectionCapability } from "../app/agent-selection.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import type { NativeDeviceSettingsCapability } from "../app/native-device-settings.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../app/theme-branding.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../lib/agents/display.ts";
import type { AgentIdentityCapability } from "../lib/agents/identity.ts";
import type { GatewayStatus as GatewayStatusKind } from "../lib/gateway-status.ts";
import { isComposingKeyboardEvent } from "../lib/ime.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { projectAgentSelection } from "../lib/reactive/application.ts";
import { i18nRevision, t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { liveValue } from "../lib/reactive/live-value.ts";
import { projectOwner, projectSource } from "../lib/reactive/projection.ts";
import { cancelRoutePreload, scheduleRoutePreload } from "../lib/route-preload.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  settingsNavigationLabelForRoute,
  settingsNavigationOwnerRoute,
  settingsSearchTextMatches,
} from "../lib/settings-navigation.ts";
import { findSettingsSearchBlocks } from "../pages/config/settings-search.ts";
import type { GatewayStatusProps } from "./gateway-status.ts";
import type { SettingsSaveIndicatorProps } from "./settings-save-indicator.tsx";
import { GatewayStatus } from "./solid/gateway-status.tsx";
import { Icon } from "./solid/icon.tsx";
import { Kbd } from "./solid/kbd.tsx";
import { ThemeBrandingIcon } from "./theme-brand-icon.tsx";
import "./agent-select-registration.ts";
import "./settings-save-indicator.tsx";
import "../styles/settings.css";
import "./sidebar-build-chip.tsx";

registerSettingsEnglish();

type AgentRosterRow = AgentsListResult["agents"][number];

export type SettingsSidebarProps = {
  presentation?: "sidebar" | "embed-list" | "embed-page";
  basePath: string;
  activeRouteId: RouteId;
  agents: readonly AgentRosterRow[];
  agentIdentity: AgentIdentityCapability;
  settingsAgentSelection: AgentSelectionCapability;
  activePathname?: string;
  activeSearch?: string;
  activeHash?: string;
  connectionStatus: GatewayStatusKind | null;
  footerStatus?: GatewayStatusProps | null;
  lastError: string | null;
  gatewayVersion: string;
  searchQuery: string;
  searchBlockMatches?: readonly SettingsSearchBlock[];
  searchParams?: Parameters<typeof findSettingsSearchBlocks>[0];
  onExit: () => void;
  onRetryConnect: () => void;
  onNavigate: (routeId: RouteId, options?: ApplicationNavigationOptions) => void;
  onPreload?: (routeId: RouteId) => Promise<void> | void;
  onSearchQueryChange: (query: string) => void;
  preloadTimers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>;
  saveIndicator: SettingsSaveIndicatorProps;
  canAdmin?: boolean;
  nativeDeviceSettings?: NativeDeviceSettingsCapability | null;
};

type SettingsNavigationGroupView = {
  labelKey: string | null;
  items: readonly SettingsNavigationItemView[];
};

type SettingsNavigationItemView = {
  routeId: RouteId;
  blocks: readonly SettingsSearchBlock[];
};

function isRedundantRouteBlock(routeId: RouteId, block: SettingsSearchBlock): boolean {
  if (block.pathname) {
    return false;
  }
  const blockLabel = normalizeLowercaseStringOrEmpty(block.label);
  return [settingsNavigationLabelForRoute(routeId), titleForRoute(routeId)].some(
    (label) => normalizeLowercaseStringOrEmpty(label) === blockLabel,
  );
}

function filterSettingsNavigationGroups(
  searchQuery: string,
  blockMatches: readonly SettingsSearchBlock[],
  canAdmin: boolean,
  nativeDeviceSettings: NativeDeviceSettingsCapability | null,
): readonly SettingsNavigationGroupView[] {
  const navigationGroups = visibleSettingsNavigationGroups(canAdmin, nativeDeviceSettings);
  const visibleBlockMatches = blockMatches.filter((block) =>
    isSettingsNavigationRouteVisible(block.routeId, canAdmin, nativeDeviceSettings),
  );
  const query = normalizeLowercaseStringOrEmpty(searchQuery);
  if (!query) {
    return navigationGroups.map((group) => ({
      labelKey: group.labelKey,
      items: group.routes.map((routeId) => ({ routeId, blocks: [] })),
    }));
  }
  const sidebarRoutes = navigationGroups.flatMap((group) => group.routes);
  const searchableRoutes = [
    ...new Set([
      ...sidebarRoutes,
      ...SETTINGS_SEARCHABLE_SUBPAGE_ROUTES.filter((routeId) =>
        isSettingsNavigationRouteVisible(routeId, canAdmin, nativeDeviceSettings),
      ),
      ...visibleBlockMatches.map((block) => block.routeId),
    ]),
  ];
  const directRoutes = searchableRoutes.filter((routeId) =>
    [
      settingsNavigationLabelForRoute(routeId),
      titleForRoute(routeId),
      subtitleForRoute(routeId),
    ].some((value) => settingsSearchTextMatches(value, query)),
  );
  const includedRoutes = new Set<RouteId>(directRoutes);
  const groupRoutes = navigationGroups.flatMap((group) => {
    const groupMatches = group.labelKey && settingsSearchTextMatches(t(group.labelKey), query);
    if (!groupMatches) {
      return [];
    }
    return group.routes.filter((routeId) => {
      if (includedRoutes.has(routeId)) {
        return false;
      }
      includedRoutes.add(routeId);
      return true;
    });
  });
  const blocksByRoute = new Map<RouteId, SettingsSearchBlock[]>();
  const seenBlocks = new Set<string>();
  for (const block of visibleBlockMatches) {
    const blockKey = `${block.routeId}\u0000${block.pathname ?? ""}\u0000${block.search ?? ""}\u0000${block.hash}`;
    if (seenBlocks.has(blockKey)) {
      continue;
    }
    seenBlocks.add(blockKey);
    const routeBlocks = blocksByRoute.get(block.routeId) ?? [];
    routeBlocks.push(block);
    blocksByRoute.set(block.routeId, routeBlocks);
  }
  const pageRoutes = [...directRoutes, ...groupRoutes];
  return [
    {
      labelKey: null,
      items: pageRoutes.map((routeId) => ({
        routeId,
        blocks: (blocksByRoute.get(routeId) ?? []).filter(
          (block) => !isRedundantRouteBlock(routeId, block),
        ),
      })),
    },
    ...searchableRoutes
      .filter((routeId) => !includedRoutes.has(routeId) && blocksByRoute.has(routeId))
      .map((routeId) => ({
        labelKey: null,
        items: [{ routeId, blocks: blocksByRoute.get(routeId) ?? [] }],
      })),
  ].filter((group) => group.items.length > 0);
}

function buildAgentRosterTree(agents: AgentRosterRow[]) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenById = new Map<string, AgentRosterRow[]>();
  const roots: AgentRosterRow[] = [];
  for (const agent of agents) {
    const creatorAgentId = agent.creatorAgentId;
    if (creatorAgentId && creatorAgentId !== agent.id && agentById.has(creatorAgentId)) {
      const children = childrenById.get(creatorAgentId) ?? [];
      children.push(agent);
      childrenById.set(creatorAgentId, children);
    } else {
      roots.push(agent);
    }
  }
  const entries: Array<{ agent: AgentRosterRow; creatorAgentId?: string }> = [];
  const visited = new Set<string>();
  const append = (agent: AgentRosterRow, depth: number): void => {
    if (visited.has(agent.id)) {
      return;
    }
    visited.add(agent.id);
    entries.push({
      agent,
      ...(depth > 0 && agent.creatorAgentId ? { creatorAgentId: agent.creatorAgentId } : {}),
    });
    for (const child of childrenById.get(agent.id) ?? []) {
      append(child, depth + 1);
    }
  };
  roots.forEach((agent) => append(agent, 0));
  // Match the CLI tree: malformed cycles cannot make configured agents disappear.
  agents.forEach((agent) => append(agent, 0));
  return entries;
}

function SettingsNavigationItem(props: {
  sidebar: SettingsSidebarProps;
  routeId: RouteId;
  branding: ThemeBranding;
}) {
  const active = () => settingsNavigationOwnerRoute(props.sidebar.activeRouteId) === props.routeId;
  const preload = (event: Event, touch = false) =>
    scheduleRoutePreload(
      props.sidebar.preloadTimers,
      props.routeId,
      event,
      props.sidebar.onPreload,
      active(),
      touch,
    );
  let anchor!: HTMLAnchorElement;
  onSettled(() => listen(anchor, "touchstart", (event) => preload(event, true), { passive: true }));
  return (
    <a
      ref={(element) => {
        anchor = element;
      }}
      href={pathForRoute(props.routeId, props.sidebar.basePath)}
      class={["settings-sidebar__item", { "settings-sidebar__item--active": active() }]}
      aria-current={active() ? "page" : undefined}
      onFocus={preload}
      onBlur={(event) => cancelRoutePreload(props.sidebar.preloadTimers, event)}
      onPointerEnter={preload}
      onPointerLeave={(event) => cancelRoutePreload(props.sidebar.preloadTimers, event)}
      onClick={(event) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        props.sidebar.onNavigate(props.routeId);
      }}
    >
      <span class="settings-sidebar__item-icon" aria-hidden="true">
        <Show
          when={props.routeId === "custodian"}
          fallback={<Icon name={navigationIconForRoute(props.routeId)} />}
        >
          <ThemeBrandingIcon branding={props.branding} />
        </Show>
      </span>
      <span class="settings-sidebar__item-label">
        {
          (i18nRevision(),
          props.branding,
          settingsNavigationLabelForRoute(
            props.routeId,
            props.sidebar.nativeDeviceSettings?.snapshot,
          ))
        }
      </span>
      <Show when={props.sidebar.presentation === "embed-list"}>
        <span class="settings-row__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </Show>
    </a>
  );
}

function SettingsBlockItem(props: { sidebar: SettingsSidebarProps; block: SettingsSearchBlock }) {
  const pathname = () =>
    props.block.pathname ?? pathForRoute(props.block.routeId, props.sidebar.basePath);
  const active = () =>
    props.sidebar.activeRouteId === props.block.routeId &&
    (props.block.pathname === undefined || props.sidebar.activePathname === props.block.pathname) &&
    props.sidebar.activeHash === props.block.hash &&
    (props.block.search === undefined || props.sidebar.activeSearch === props.block.search);
  return (
    <a
      href={pathname() + (props.block.search ?? "") + props.block.hash}
      class={["settings-sidebar__subitem", { "settings-sidebar__subitem--active": active() }]}
      aria-current={active() ? "location" : undefined}
      onClick={(event) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        props.sidebar.onNavigate(props.block.routeId, {
          ...(props.block.pathname ? { pathname: props.block.pathname } : {}),
          ...(props.block.search ? { search: props.block.search } : {}),
          hash: props.block.hash,
        });
      }}
    >
      <span class="settings-sidebar__subitem-label">{props.block.label}</span>
    </a>
  );
}

function SettingsAgentSelector(props: SettingsSidebarProps) {
  const identitySource = createMemo(() => props.agentIdentity);
  const selectionSource = createMemo(() => props.settingsAgentSelection);
  const identities = createMemo(() => projectOwner(identitySource(), (source) => source.entries()));
  const selection = createMemo(() => projectAgentSelection(selectionSource()));
  createEffect(
    () => [identitySource(), selection().read().state.selectedId] as const,
    ([source, agentId]) => {
      void source.ensure([agentId]);
    },
  );
  const agents = createMemo(() =>
    listSelectableAgents(props.agents).map((agent) =>
      Object.assign({}, agent, {
        id: normalizeAgentId(agent.id),
        creatorAgentId: agent.creatorAgentId
          ? normalizeAgentId(agent.creatorAgentId)
          : agent.creatorAgentId,
      }),
    ),
  );
  const options = createMemo(() =>
    buildAgentRosterTree(agents()).map(({ agent, creatorAgentId }) => ({
      value: agent.id,
      label: normalizeAgentLabel(agent),
      agent,
      description: creatorAgentId ? t("agents.createdBy", { id: creatorAgentId }) : undefined,
    })),
  );
  return (
    <div class="settings-sidebar__agent">
      <openclaw-agent-select
        prop:options={options()}
        prop:identityById={Object.fromEntries(
          identities()
            .read()
            .map((identity) => [identity.agentId, identity]),
        )}
        prop:value={selection().read().state.selectedId ?? ""}
        prop:accessibleLabel={t("agentScope.label")}
        prop:menuLabel={t("agentScope.label")}
        prop:disabled={options().length <= 1}
        prop:onSelect={(agentId: string) => props.settingsAgentSelection.set(agentId)}
        onOverlay-show={() => void props.agentIdentity.ensure(agents().map((agent) => agent.id))}
      />
    </div>
  );
}

function SettingsConnectionStatus(props: SettingsSidebarProps) {
  return (
    <Show
      when={props.connectionStatus !== null}
      fallback={<openclaw-settings-save-indicator prop:props={props.saveIndicator} />}
    >
      <GatewayStatus
        kind={props.connectionStatus}
        lastError={props.lastError}
        onRetry={props.onRetryConnect}
        announce
      />
    </Show>
  );
}

function EmbeddedSettingsHeader(props: SettingsSidebarProps) {
  return (
    <header class="native-embed-header">
      <Show when={props.presentation === "embed-page"}>
        <button
          class="native-embed-header__back btn btn--ghost"
          type="button"
          aria-label={t("common.back")}
          onClick={() => props.onExit()}
        >
          <span aria-hidden="true">
            <Icon name="chevronLeft" />
          </span>
          {t("common.back")}
        </button>
      </Show>
      <h1 class="page-title">
        {props.presentation === "embed-list"
          ? t("nav.settings")
          : settingsNavigationLabelForRoute(
              props.activeRouteId,
              props.nativeDeviceSettings?.snapshot,
            )}
      </h1>
      <SettingsConnectionStatus {...props} />
    </header>
  );
}

export function renderSettingsSidebar(props: SettingsSidebarProps) {
  const query = createMemo(() => props.searchQuery);
  let searchInput: HTMLInputElement | undefined;
  function SettingsNavigation() {
    const branding = projectSource(null, {
      read: currentThemeBranding,
      subscribe: (_source, notify) => subscribeThemeBranding(notify),
      equality: Object.is,
    });
    const groups = createMemo(() => {
      i18nRevision();
      branding.read();
      return filterSettingsNavigationGroups(
        props.searchQuery,
        props.searchBlockMatches ??
          (props.searchParams ? findSettingsSearchBlocks(props.searchParams) : []),
        props.canAdmin !== false,
        props.nativeDeviceSettings ?? null,
      );
    });
    return (
      <nav
        class="settings-sidebar__nav"
        aria-label={t("common.settingsSections")}
        onScroll={(event) =>
          searchInput?.parentElement?.classList.toggle(
            "settings-sidebar__search--scrolled",
            event.currentTarget.scrollTop > 0,
          )
        }
      >
        <Show
          when={groups().length > 0}
          fallback={
            <p class="settings-sidebar__empty" role="status">
              {t("nav.settingsSearchNoResults")}
            </p>
          }
        >
          <For each={groups()} keyed={false}>
            {(group) => (
              <div class="settings-sidebar__group">
                <Show when={group().labelKey}>
                  {(label) => <div class="settings-sidebar__group-label">{t(label())}</div>}
                </Show>
                <For each={group().items} keyed={false}>
                  {(item) => (
                    <>
                      <SettingsNavigationItem
                        sidebar={props}
                        routeId={item().routeId}
                        branding={branding.read()}
                      />
                      <For each={item().blocks} keyed={false}>
                        {(block) => <SettingsBlockItem sidebar={props} block={block()} />}
                      </For>
                    </>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </nav>
    );
  }
  return (
    <Show
      when={props.presentation !== "embed-page"}
      fallback={
        <>
          <EmbeddedSettingsHeader {...props} />
          <SettingsAgentSelector {...props} />
        </>
      }
    >
      <Show
        when={props.presentation !== "embed-list"}
        fallback={
          <section class="settings-embed-list">
            <EmbeddedSettingsHeader {...props} />
            <SettingsAgentSelector {...props} />
            <SettingsNavigation />
          </section>
        }
      >
        <aside class="settings-sidebar">
          <header class="settings-sidebar__header" onMouseDown={beginNativeWindowDragFromTopInset}>
            <button type="button" class="settings-sidebar__back" onClick={() => props.onExit()}>
              <span class="settings-sidebar__back-icon" aria-hidden="true">
                <Icon name="arrowLeft" />
              </span>
              {t("nav.exitSettings")}
              <Kbd keys="esc" class="settings-sidebar__esc" ariaHidden />
            </button>
            <h1 class="settings-sidebar__title">{t("nav.settings")}</h1>
          </header>
          <SettingsAgentSelector {...props} />
          <div class="settings-sidebar__search" role="search">
            <span class="settings-sidebar__search-icon" aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              class="settings-sidebar__search-input"
              type="search"
              autocomplete="off"
              spellcheck="false"
              aria-label={t("nav.settingsSearchLabel")}
              placeholder={t("nav.settingsSearchPlaceholder")}
              ref={[(element) => (searchInput = element), liveValue(query)]}
              onInput={(event) => props.onSearchQueryChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || isComposingKeyboardEvent(event)) {
                  return;
                }
                event.preventDefault();
                if (props.searchQuery) {
                  props.onSearchQueryChange("");
                } else {
                  props.onExit();
                }
              }}
            />
            <Show when={props.searchQuery}>
              <button
                type="button"
                class="settings-sidebar__search-clear"
                aria-label={t("nav.settingsSearchClear")}
                onClick={() => {
                  props.onSearchQueryChange("");
                  searchInput?.focus();
                }}
              >
                <Icon name="x" />
              </button>
            </Show>
          </div>
          <SettingsNavigation />
          <footer class="settings-sidebar__footer">
            <Show when={props.footerStatus}>
              {(status) => (
                <div class="sidebar-shell__footer">
                  <GatewayStatus {...status()} row />
                </div>
              )}
            </Show>
            <div class="settings-sidebar__connection">
              <openclaw-settings-save-indicator prop:props={props.saveIndicator} />
            </div>
            <openclaw-sidebar-build-chip
              prop:basePath={props.basePath}
              prop:gatewayVersion={props.gatewayVersion || null}
              prop:variant="settings"
              prop:onNavigate={() => props.onNavigate("about")}
            />
          </footer>
        </aside>
      </Show>
    </Show>
  );
}
