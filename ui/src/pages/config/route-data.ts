import type { RouteLocation } from "@openclaw/uirouter";
import { INTERNAL_MEMORY_PATH_PARAM, pathForRoute } from "../../app-route-paths.ts";
import type { AgentSelectionCapability } from "../../app/agent-selection.ts";
import { configSettingSection } from "../../lib/config-form-utils.ts";

// Blocks on the Models page that older links and settings search name.
export const MODEL_SETTINGS_TARGET_IDS = {
  behavior: "settings-model-behavior",
  providers: "settings-model-providers",
} as const;

export const APPEARANCE_SETTINGS_TARGET_IDS = {
  language: "settings-language",
  theme: "settings-appearance-theme",
  background: "settings-appearance-background",
  accent: "settings-appearance-accent",
  typography: "settings-appearance-typography",
  tabIcon: "settings-appearance-tab-icon",
  textSize: "settings-appearance-text-size",
  sidebar: "settings-appearance-sidebar",
  chat: "settings-appearance-chat",
  devices: "settings-appearance-devices",
  sessionSources: "settings-session-sources",
} as const;

export const appearanceSettingsRouteTarget = (targetId: string) =>
  ({ routeId: "appearance", search: "?section=__appearance__", hash: `#${targetId}` }) as const;

export const SETTINGS_ROUTE_TARGETS = {
  modelBehavior: {
    routeId: "model-providers",
    hash: `#${MODEL_SETTINGS_TARGET_IDS.behavior}`,
  },
  appearanceLanguage: appearanceSettingsRouteTarget(APPEARANCE_SETTINGS_TARGET_IDS.language),
  appearanceSidebar: appearanceSettingsRouteTarget(APPEARANCE_SETTINGS_TARGET_IDS.sidebar),
  sessionSources: appearanceSettingsRouteTarget(APPEARANCE_SETTINGS_TARGET_IDS.sessionSources),
} as const;

export type ConfigRouteData = ReturnType<typeof configRouteData> & {
  /** Memory URL intent is applied only if a newer sidebar choice has not superseded it. */
  agentSelectionIntent?: { owner: AgentSelectionCapability; revision: number };
};

export type ConfigRouteSource = {
  read(): ConfigRouteData | null;
  subscribe(listener: () => void): () => void;
};

export function configTargetIdFromHash(hash: string): string | null {
  if (!hash) {
    return null;
  }
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

export function canonicalGeneralSettingsLocation(location: RouteLocation, basePath: string) {
  const target =
    configTargetIdFromHash(location.hash) === "settings-general-model"
      ? SETTINGS_ROUTE_TARGETS.modelBehavior
      : SETTINGS_ROUTE_TARGETS.appearanceLanguage;
  return {
    pathname: pathForRoute(target.routeId, basePath),
    search: "search" in target ? target.search : "",
    hash: target.hash,
  };
}

export function configRouteData(location: RouteLocation) {
  const searchParams = new URLSearchParams(location.search);
  const pathname = searchParams.get(INTERNAL_MEMORY_PATH_PARAM) ?? location.pathname;
  searchParams.delete(INTERNAL_MEMORY_PATH_PARAM);
  const search = searchParams.toString();
  const targetBlockId = configTargetIdFromHash(location.hash);
  // A link to one schema setting needs no `?section=` or `?advanced=1`: its ID names the
  // section, and the setting may sit in the advanced group or a closed object.
  const settingSection = configSettingSection(targetBlockId);
  const section = searchParams.get("section")?.trim() || settingSection;
  return {
    pathname,
    search: search ? `?${search}` : "",
    hash: location.hash,
    section,
    advanced: searchParams.get("advanced") === "1" || settingSection !== null,
    /** Raw `?tab=`; curated hub pages normalize it against their own tab set. */
    tab: searchParams.get("tab")?.trim() || null,
    targetBlockId,
  };
}
