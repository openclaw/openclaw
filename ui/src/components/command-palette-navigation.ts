import {
  pathForAgentPanel,
  pathForPluginCatalogEntry,
  pathForPluginSettings,
  pathForRoute,
  type RouteId,
} from "../app-route-paths.ts";
import type { CommandPaletteItem } from "./command-palette-catalog-search.ts";
import { SESSION_ACTION_PREFIX } from "./command-palette-session-search.ts";
import type { CommandPaletteState } from "./command-palette-state.ts";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
} from "./panel-toggle-contract.ts";

type CommandPaletteProps = ReturnType<CommandPaletteState["readProps"]>;

export function pageDestination(item: CommandPaletteItem, basePath: string) {
  if (!item.action.startsWith("nav:") || item.action === "nav:new-session") {
    return undefined;
  }
  // SAFETY: the palette catalog builds every nav: action from a RouteId value.
  const routeId = item.action.slice(4) as RouteId;
  const pathname = item.agentId
    ? pathForAgentPanel(item.agentId, null, basePath)
    : item.catalogId
      ? pathForPluginCatalogEntry(item.catalogId, basePath)
      : item.pluginId && routeId === "plugin-settings"
        ? pathForPluginSettings(item.pluginId, basePath)
        : undefined;
  const { search, hash } = item;
  return {
    routeId,
    options: pathname || search || hash ? { pathname, search, hash } : undefined,
    href: `${pathname ?? pathForRoute(routeId, basePath)}${search ?? ""}${hash ?? ""}`,
  };
}

export function selectItem(item: CommandPaletteItem, props: CommandPaletteProps) {
  if (props.draft.submitting || props.searchDebouncing) {
    return;
  }
  if (item.action === "nav:new-session") {
    props.onModeChange("compose");
    return;
  }
  const page = pageDestination(item, props.basePath);
  if (page) {
    if (page.options) {
      props.onNavigate?.(page.routeId, page.options);
    } else {
      props.onNavigate?.(page.routeId);
    }
  } else if (item.action.startsWith(SESSION_ACTION_PREFIX)) {
    props.onSelectSession?.(item.action.slice(SESSION_ACTION_PREFIX.length));
  } else if (item.action === "panel:desktop") {
    window.dispatchEvent(new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
  } else if (item.action === "panel:custodian") {
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
  } else {
    props.onSlashCommand?.(item.action);
  }
  props.onToggle();
}
