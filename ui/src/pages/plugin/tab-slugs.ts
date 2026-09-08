import {
  normalizeRouteBasePath as normalizeBasePath,
  normalizeRoutePath,
} from "@openclaw/uirouter";
import type { RouteLocation } from "@openclaw/uirouter";
import { APP_ROUTE_DEFINITIONS, NATIVE_ROUTE_SEGMENTS } from "../../app-route-definitions.ts";

export const INTERNAL_PLUGIN_PATH_PARAM = "__openclawPluginPath";
type PluginTab = { pluginId: string; id: string; slug?: string };
const tabsBySlug = new Map<string, PluginTab>();
const warnedSlugs = new Set<string>();

function pluginTabSlug(tab: PluginTab): string | undefined {
  const slug = tab.slug;
  if (!slug) {
    return undefined;
  }
  if (NATIVE_ROUTE_SEGMENTS.has(slug)) {
    if (!warnedSlugs.has(slug)) {
      warnedSlugs.add(slug);
      console.warn(`[openclaw] Plugin tab slug "${slug}" overlaps a native route; using /plugin.`);
    }
    return undefined;
  }
  return slug;
}

export function setPluginTabSlugs(tabs: readonly PluginTab[] = []): void {
  tabsBySlug.clear();
  for (const tab of tabs) {
    const slug = pluginTabSlug(tab);
    if (slug && !tabsBySlug.has(slug)) {
      tabsBySlug.set(slug, tab);
    }
  }
}

export function pluginSlugCandidate(pathname: string, basePath = ""): string | null {
  const path = normalizeRoutePath(pathname);
  const base = normalizeBasePath(basePath);
  if (!path.startsWith(`${base}/`)) {
    return null;
  }
  const slug = path.slice(base.length + 1);
  return slug.length <= 64 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
    !NATIVE_ROUTE_SEGMENTS.has(slug)
    ? slug
    : null;
}

export function pluginTabSlugFromPath(pathname: string, basePath = ""): PluginTab | null {
  return tabsBySlug.get(pluginSlugCandidate(pathname, basePath) ?? "") ?? null;
}

export function pluginTabLocation(tab: PluginTab, basePath = ""): RouteLocation {
  const slug = pluginTabSlug(tab);
  return {
    pathname: `${normalizeBasePath(basePath)}${slug ? `/${slug}` : APP_ROUTE_DEFINITIONS.plugin.path}`,
    search: slug ? "" : `?${new URLSearchParams({ plugin: tab.pluginId, id: tab.id })}`,
    hash: "",
  };
}

export function canonicalPluginTabLocation(location: RouteLocation, basePath = ""): RouteLocation {
  if (
    normalizeRoutePath(location.pathname) !==
    `${normalizeBasePath(basePath)}${APP_ROUTE_DEFINITIONS.plugin.path}`
  ) {
    return location;
  }
  const search = new URLSearchParams(location.search);
  const tab = [...tabsBySlug.values()].find(
    (entry) => entry.pluginId === search.get("plugin") && entry.id === search.get("id"),
  );
  if (!tab) {
    return location;
  }
  const params = new URLSearchParams([...search].filter(([key]) => key.startsWith("p.")));
  return {
    ...pluginTabLocation(tab, basePath),
    search: params.size ? `?${params}` : "",
    hash: location.hash,
  };
}
