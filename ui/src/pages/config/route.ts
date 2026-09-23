import type { RouteLocation } from "@openclaw/uirouter";
import { definePage, redirect } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { pathForRoute, routePageSpec, type RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { isNativeEmbedHost } from "../../app/native-web-chrome.ts";
import type { ConfigPageId } from "./config-sections.ts";
import {
  configRouteData,
  configTargetIdFromHash,
  SETTINGS_ROUTE_TARGETS,
  type ConfigRouteData,
} from "./route-data.ts";

// Sections relocated by the settings restructure, keyed by "<oldPage>:<section>".
// Kept so pre-restructure bookmarks and generated links still land somewhere
// sensible instead of silently opening the old page's default section.
const MOVED_SECTION_ROUTES: Record<
  string,
  { routeId: RouteId; keepSection: boolean; search?: string; advanced?: boolean }
> = {
  "communications:__notifications__": { routeId: "notifications", keepSection: false },
  "communications:channels": { routeId: "channels", keepSection: false },
  "communications:broadcast": { routeId: "advanced", keepSection: true },
  "communications:talk": { routeId: "talk", keepSection: true },
  "appearance:wizard": { routeId: "advanced", keepSection: true },
  "advanced:transcripts": { routeId: "communications", keepSection: true, advanced: true },
  "automation:approvals": { routeId: "security", keepSection: true },
  "automation:plugins": {
    routeId: "plugin-settings",
    keepSection: false,
    search: "?tab=advanced",
  },
  "ai-agents:memory": { routeId: "memory", keepSection: true },
  "ai-agents:models": { routeId: "model-providers", keepSection: false },
};

function loadConfigRoute(
  context: ApplicationContext,
  location: RouteLocation,
  pageId: ConfigPageId,
) {
  const route = configRouteData(location);
  const movedRoute = route.section ? MOVED_SECTION_ROUTES[`${pageId}:${route.section}`] : undefined;
  if (route.section && movedRoute) {
    return redirect({
      pathname: pathForRoute(movedRoute.routeId, context.basePath),
      search:
        movedRoute.search ??
        (movedRoute.keepSection
          ? `?section=${encodeURIComponent(route.section)}${movedRoute.advanced ? "&advanced=1" : ""}`
          : ""),
      hash: route.hash,
    });
  }
  const agentSelectionIntent =
    pageId === "memory"
      ? {
          owner: context.settingsAgentSelection,
          revision: context.settingsAgentSelection.intentRevision,
        }
      : undefined;
  const primaryLoad = context.runtimeConfig.ensureLoaded();
  if (pageId !== "updates") {
    void primaryLoad.then(() => context.runtimeConfig.ensureSchemaLoaded()).catch(() => undefined);
  }
  return {
    ...route,
    ...(agentSelectionIntent ? { agentSelectionIntent } : {}),
  };
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
    loader: (context: ApplicationContext, { location }) => loadConfigRoute(context, location, id),
    component: () =>
      import("./config-page.ts").then(() => ({
        header: true,
        render: (data: ConfigRouteData | undefined) => html`
          <openclaw-config-page .pageId=${id} .routeData=${data ?? null}></openclaw-config-page>
        `,
      })),
  });
}

const removedGeneralRedirectPage = definePage({
  ...routePageSpec("config"),
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    `${location.pathname}\u0000${location.search}\u0000${location.hash}`,
  loader: (context: ApplicationContext, { location }) => {
    const target =
      configTargetIdFromHash(location.hash) === "settings-general-model"
        ? SETTINGS_ROUTE_TARGETS.modelBehavior
        : SETTINGS_ROUTE_TARGETS.appearanceLanguage;
    return redirect({
      pathname: pathForRoute(target.routeId, context.basePath),
      search: "search" in target ? target.search : "",
      hash: target.hash,
    });
  },
  // Redirect routes still require a module by contract, but never render page content.
  component: async () => ({ header: true, render: () => nothing }),
});

export const pages = [
  definePage({
    ...routePageSpec("settings"),
    loader: (context: ApplicationContext, { location }) =>
      isNativeEmbedHost()
        ? undefined
        : redirect({ ...location, pathname: pathForRoute("chat", context.basePath) }),
    // The shell reuses its lazy settings navigation as the embedded list page.
    component: async () => ({ render: () => nothing }),
  }),
  removedGeneralRedirectPage,
  configPage("communications"),
  configPage("appearance"),
  configPage("notifications"),
  configPage("security"),
  configPage("automation"),
  configPage("mcp"),
  configPage("memory"),
  configPage("talk"),
  configPage("infrastructure"),
  configPage("updates"),
  configPage("ai-agents"),
  configPage("advanced"),
] as const;
