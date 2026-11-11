import type { RouteLocation } from "@openclaw/uirouter";
import { definePage, redirect } from "@openclaw/uirouter";
import { pathForRoute, routePageSpec, type RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { isNativeEmbedHost } from "../../app/native-web-chrome.ts";
import { hasConfigPageDisplay, isAppearanceDataTarget } from "./config-page-reads.ts";
import { CONFIG_PAGE_IDS, normalizeConfigSelection, type ConfigPageId } from "./config-sections.ts";
import { canonicalGeneralSettingsLocation, configRouteData } from "./route-data.ts";

// Sections relocated by the settings restructure, keyed by "<oldPage>:<section>".
// Kept so pre-restructure bookmarks and generated links still land somewhere
// sensible instead of silently opening the old page's default section.
// An omitted query preserves the section; an empty query removes it.
const MOVED_SECTION_ROUTES: Record<string, readonly [routeId: RouteId, search?: string]> = {
  "communications:__notifications__": ["notifications", ""],
  "communications:channels": ["channels", ""],
  "communications:broadcast": ["advanced"],
  "communications:talk": ["talk"],
  "appearance:wizard": ["advanced"],
  "advanced:transcripts": ["communications", "?section=transcripts&advanced=1"],
  "automation:approvals": ["security"],
  "automation:plugins": ["plugin-settings", "?tab=advanced"],
  "ai-agents:memory": ["memory"],
  "ai-agents:models": ["model-providers", ""],
};

function movedSectionLocation(
  id: RouteId,
  route: Pick<ReturnType<typeof configRouteData>, "section" | "hash">,
  basePath: string,
): RouteLocation | undefined {
  const moved = MOVED_SECTION_ROUTES[`${id}:${route.section}`];
  return (
    moved && {
      pathname: pathForRoute(moved[0], basePath),
      search: moved[1] ?? `?section=${route.section}`,
      hash: route.hash,
    }
  );
}

/** Shared by app navigation and raw-router loader fallbacks. */
export function canonicalSettingsLocation(
  id: RouteId | null,
  location: RouteLocation,
  basePath: string,
): RouteLocation | undefined {
  if (id === "config") {
    return canonicalGeneralSettingsLocation(location, basePath);
  }
  if (id === "settings") {
    return isNativeEmbedHost()
      ? undefined
      : { ...location, pathname: pathForRoute("chat", basePath) };
  }
  return id && CONFIG_PAGE_IDS.some((pageId) => pageId === id)
    ? movedSectionLocation(id, configRouteData(location), basePath)
    : undefined;
}

function configPage(id: ConfigPageId) {
  return definePage({
    ...routePageSpec(id),
    loaderDeps: (context: ApplicationContext, location: RouteLocation) => {
      const route = configRouteData(location);
      const locationKey = `${route.pathname}\u0000${route.search}\u0000${route.hash}`;
      return id === "memory"
        ? `${locationKey}\u0000${context.settingsAgentSelection.intentRevision}`
        : locationKey;
    },
    loader: (context: ApplicationContext, { location }) => {
      const route = configRouteData(location);
      const moved = movedSectionLocation(id, route, context.basePath);
      if (moved) {
        return redirect(moved);
      }
      const agentSelectionIntent =
        id === "memory"
          ? {
              owner: context.settingsAgentSelection,
              revision: context.settingsAgentSelection.intentRevision,
            }
          : undefined;
      const appearanceDisplay =
        hasConfigPageDisplay(
          context.runtimeConfig,
          id,
          normalizeConfigSelection(id, route.section, null).activeSection,
        ) && !isAppearanceDataTarget(route.targetBlockId);
      if (!appearanceDisplay) {
        void context.runtimeConfig.ensureLoaded().catch(() => undefined);
        if (id !== "updates") {
          void context.runtimeConfig.ensureSchemaLoaded().catch(() => undefined);
        }
      }
      return {
        ...route,
        pageId: id,
        ...(agentSelectionIntent ? { agentSelectionIntent } : {}),
      };
    },
    component: async () => {
      // The sidebar is an independent lazy sibling; start it alongside the page.
      void import("../../components/settings-sidebar-shell.tsx").catch(() => undefined);
      const module = await import("./config-page.tsx");
      await module.preloadConfigPage(id);
      return {
        // Keep the current owner while another Settings subpage loads its data.
        renderOwnerKey: () => "settings-config",
        renderSolid: module.ConfigRoute,
      };
    },
  });
}

const removedGeneralRedirectPage = definePage({
  ...routePageSpec("config"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    `${location.pathname}\u0000${location.search}\u0000${location.hash}`,
  loader: (context: ApplicationContext, { location }) =>
    redirect(canonicalGeneralSettingsLocation(location, context.basePath)),
  // Redirect routes still require a module by contract, but never render page content.
  component: async () => ({ renderSolid: () => null }),
});

export const pages = [
  definePage({
    ...routePageSpec("settings"),
    loader: (context: ApplicationContext, { location }) => {
      const canonical = canonicalSettingsLocation("settings", location, context.basePath);
      return canonical && redirect(canonical);
    },
    // The shell reuses its lazy settings navigation as the embedded list page.
    component: async () => ({ renderSolid: () => null }),
  }),
  removedGeneralRedirectPage,
  ...CONFIG_PAGE_IDS.map(configPage),
] as const;
