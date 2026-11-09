import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { foldSearchCase } from "../../../src/shared/search-case.js";
import {
  deviceSettingsGroupLabelKey,
  titleForRoute,
  type NavigationRouteId,
} from "../app-navigation.ts";
import { pathForRoute, pluginSettingsIdFromPath } from "../app-route-paths.ts";
import type { NativeDeviceSettingsSnapshot } from "../app/native-device-settings.ts";
import { askBrandLabel } from "../components/theme-brand-label.ts";
import { i18n, t } from "../i18n/index.ts";

const SETTINGS_SUBPAGE_OWNER_ROUTES: Partial<
  Readonly<Record<NavigationRouteId, NavigationRouteId>>
> = {
  "ai-agents": "agents",
  "model-setup": "model-providers",
  lobsterdex: "appearance",
};

export function settingsNavigationOwnerRoute(routeId: NavigationRouteId): NavigationRouteId {
  return SETTINGS_SUBPAGE_OWNER_ROUTES[routeId] ?? routeId;
}

/** The page one level up, or null when this page is already a top-level section. */
export function settingsParentRoute(
  routeId: NavigationRouteId,
  pathname = "",
  basePath = "",
): NavigationRouteId | null {
  if (routeId === "plugin-settings" && pluginSettingsIdFromPath(pathname, basePath)) {
    return "plugin-settings";
  }
  const owner = settingsNavigationOwnerRoute(routeId);
  return owner === routeId ? null : owner;
}

/** The location one level up for Back and Escape, including plugin detail subviews. */
export function settingsParentTarget(
  routeId: NavigationRouteId,
  location: { pathname: string; search: string } | undefined,
  basePath = "",
): { routeId: NavigationRouteId; pathname: string; search: string; hash: string } | null {
  const parent = settingsParentRoute(routeId, location?.pathname, basePath);
  if (!parent) {
    return null;
  }
  if (location && parent === "plugin-settings") {
    const search = new URLSearchParams(location.search);
    if (search.get("view") === "settings") {
      search.delete("view");
      return {
        routeId,
        pathname: location.pathname,
        search: search.size ? `?${search}` : "",
        hash: "",
      };
    }
    if (search.get("from") === "plugins") {
      return {
        routeId: "plugins",
        pathname: pathForRoute("plugins", basePath),
        search: "",
        hash: "",
      };
    }
  }
  return { routeId: parent, pathname: pathForRoute(parent, basePath), search: "", hash: "" };
}

export function settingsNavigationLabelForRoute(
  routeId: NavigationRouteId,
  snapshot?: NativeDeviceSettingsSnapshot | null,
): string {
  if (routeId === "device" && snapshot) {
    return t(deviceSettingsGroupLabelKey(snapshot));
  }
  if (routeId === "custodian") {
    return askBrandLabel();
  }
  return titleForRoute(routeId);
}

let settingsSearchSegmenterLocale = "";
let settingsSearchSegmenter: Intl.Segmenter | null = null;

function settingsSearchHasWordPrefix(value: string, query: string): boolean {
  const locale = i18n.getLocale();
  if (!settingsSearchSegmenter || settingsSearchSegmenterLocale !== locale) {
    settingsSearchSegmenterLocale = locale;
    settingsSearchSegmenter = new Intl.Segmenter(locale, { granularity: "word" });
  }
  for (const segment of settingsSearchSegmenter.segment(value)) {
    if (segment.isWordLike !== false && segment.segment.startsWith(query)) {
      return true;
    }
  }
  return false;
}

/** Lower ranks first: exact title, title prefix, title match, then no title match. */
export function settingsSearchTitleRank(titles: readonly string[], query: string): number {
  const normalizedQuery = normalizeLowercaseStringOrEmpty(query).normalize("NFC");
  const candidates = titles.map((title) => normalizeLowercaseStringOrEmpty(title).normalize("NFC"));
  if (candidates.includes(normalizedQuery)) {
    return 0;
  }
  if (candidates.some((title) => title.startsWith(normalizedQuery))) {
    return 1;
  }
  return titles.some((title) => settingsSearchTextMatches(title, query)) ? 2 : 3;
}

export function settingsSearchTextMatches(value: string, query: string): boolean {
  const candidate = foldSearchCase(normalizeLowercaseStringOrEmpty(value)).normalize("NFC");
  const normalizedQuery = foldSearchCase(normalizeLowercaseStringOrEmpty(query)).normalize("NFC");
  if (!normalizedQuery) {
    return false;
  }
  if (normalizedQuery.length > 2) {
    return candidate.includes(normalizedQuery);
  }
  return settingsSearchHasWordPrefix(candidate, normalizedQuery);
}
