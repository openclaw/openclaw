// @vitest-environment node
import { expect, it } from "vitest";
import {
  SIDEBAR_NAV_ROUTES,
  formatDocumentTitle,
  isPluginsHubRoute,
  navigationIconForRoute,
  subtitleForRoute,
  titleForRoute,
  visibleSettingsNavigationGroups,
} from "./app-navigation.ts";
import {
  activityPersonFromPath,
  activityPersonLocation,
  dynamicRouteFromPath,
  inferBasePathFromPathname,
  normalizeBasePath,
  pathForWorkboardBoard,
  workboardBoardIdFromPath,
} from "./app-route-paths.ts";
import { routeIdFromPath, type RouteId } from "./app-routes.ts";
import { sessionRefFromPath } from "./app-session-route-paths.ts";
import { sessionNavigationTarget } from "./lib/sessions/route-navigation.ts";
import { settingsSearchTextMatches } from "./lib/settings-navigation.ts";
import { pluginTabKey, pluginTabRefFromSearch } from "./pages/plugin/route.tsx";

function expectBase(base: string, ...paths: string[]) {
  for (const path of paths) {
    expect(inferBasePathFromPathname(path), path).toBe(base);
  }
}

it("returns a fallback navigation icon for an unknown route", () => {
  expect(navigationIconForRoute("unknown" as RouteId)).toBe("folder");
});

it.each([
  ["CPU usage", "cp", true],
  ["MCP", "cp", false],
  ["外観設定", "設定", true],
  ["Cámara", "Ca\u0301mara", true],
] as const)("matches setting text %s against %s: %s", (text, query, matches) => {
  expect(settingsSearchTextMatches(text, query)).toBe(matches);
});

it.each([
  [{ context: "About", brandName: "Northstar", attentionCount: 2 }, "(2) About — Northstar"],
  [{ context: "Ask Northstar", brandName: "Northstar" }, "Ask Northstar"],
  [{ context: "Usage", attentionCount: 3 }, "(3) Usage — OpenClaw"],
] as const)("formats document title %j", (options, title) => {
  expect(formatDocumentTitle(options)).toBe(title);
});

it("keeps every navigation title and subtitle backed by an English translation", async () => {
  const { registerRouteSubtitlesEnglish } = await import("./i18n/locales/en-route-subtitles.ts");
  registerRouteSubtitlesEnglish();
  const routes: RouteId[] = [
    "chat",
    "custodian",
    "templates",
    ...SIDEBAR_NAV_ROUTES,
    "workboard",
    "skills",
    "skill-workshop",
    "worktrees",
    "memory-import",
    "ai-agents",
    "model-setup",
    "lobsterdex",
    ...visibleSettingsNavigationGroups(true).flatMap((group) => group.routes),
  ];
  const rawI18nKey = /^[a-z][a-zA-Z0-9]*\.[a-zA-Z]/;
  for (const routeId of routes) {
    expect(titleForRoute(routeId), routeId).not.toMatch(rawI18nKey);
    expect(subtitleForRoute(routeId), routeId).not.toMatch(rawI18nKey);
  }
});

it("normalizes base paths and trailing route slashes", () => {
  const bases = ["", "/", "ui", "/apps/openclaw/"];
  expect(bases.map(normalizeBasePath)).toEqual(["", "", "/ui", "/apps/openclaw"]);
  expect(routeIdFromPath("/chat/")).toBe("chat");
  expect(routeIdFromPath("/ui/chat/", "/ui/")).toBe("chat");
});

it("round-trips Workboard board paths", () => {
  expect(pathForWorkboardBoard("ops.v2")).toBe("/workboard/ops%2Ev2");
  expect(workboardBoardIdFromPath("/workboard/ops%2Ev2")).toBe("ops.v2");
  expectRoutedPath("/workboard/ops%2Ev2", "workboard");
  expect(pathForWorkboardBoard("ops", "/ui")).toBe("/ui/workboard/ops");
  expect(workboardBoardIdFromPath("/ui/workboard/ops", "/ui")).toBe("ops");
  expectRoutedPath("/ui/workboard/ops", "workboard", "/ui");
});

it.each([
  ["12345678-ABCD-4EF0-8123-456789ABCDEF", undefined, "12345678abcd", "12345678abcd"],
  ["release.js", "Alice", "release%2Ejs", "release.js"],
])("round-trips Activity links for %s", (personId, label, segment, reference) => {
  const pathname = `/ui/activity/${segment}`;
  expect(activityPersonLocation(personId, "/ui", label)).toEqual({
    pathname,
    search: "",
    href: pathname,
  });
  expect(activityPersonFromPath(pathname, "/ui")).toBe(reference);
  expectRoutedPath(pathname, "activity", "/ui");
});

it("preserves full Activity UUIDs and accepts longer collision-disambiguating prefixes", () => {
  const personId = "12345678-abcd-4ef0-8123-456789abcdef";
  const uuidShapedName = activityPersonLocation(personId, "", "deadbeef-cafe-4dad-8bad");
  expect(activityPersonFromPath(uuidShapedName.pathname)).toBe("12345678abcd");
  expect(activityPersonFromPath(`/activity/${personId}`)).toBe(personId);
  expect(activityPersonFromPath("/activity/josh-12345678abcd")).toBe("12345678abcd");
  expect(activityPersonLocation(personId, "", "Josh", 16).pathname).toBe(
    "/activity/josh-12345678abcd4ef0",
  );
  expect(activityPersonFromPath("/activity/renamed-josh-12345678/")).toBe("12345678");
  expect(inferBasePathFromPathname("/activity/josh-12345678")).toBe("");
  expect(inferBasePathFromPathname("/apps/openclaw/activity/josh-12345678")).toBe("/apps/openclaw");
});

it.each(["/activity/%", "/activity/%2E%2E"])("rejects Activity path %s", (path) => {
  expect(activityPersonFromPath(path)).toBeNull();
});

it("round-trips session navigation through the lazy contract seam", () => {
  const pathname = sessionNavigationTarget({
    face: "chat",
    sessionKey: "telegram:12345",
    fallbackAgentId: "research",
    basePath: "/ui",
  }).options.pathname;

  expect(pathname).toBe("/ui/chat/research/telegram/12345");
  expect(sessionRefFromPath(pathname, "/ui")).toMatchObject({
    kind: "literal",
    sessionKey: "agent:research:telegram:12345",
  });
  expectRoutedPath(pathname, "chat", "/ui");
});

it("handles direct routes, nested mounts, mount roots, and index.html", () => {
  expectBase("", "/", "/chat", "/custodian", "/settings/connection", "/typo", "/index.html");
  expectBase("/ui", "/ui/chat", "/ui/index.html");
  expectBase("/apps/openclaw", "/apps/openclaw/sessions", "/apps/openclaw/");
  expectBase("/__openclaw__", "/__openclaw__/");
});

it("never infers a route namespace as a mount base", () => {
  // Route aliases must not rescope stored gateway settings or asset URLs.
  expectBase(
    "",
    "/settings/config",
    "/custodian/config",
    "/settings/other/config",
    "/settings/",
    "/focus/terminal",
  );
  expectBase("/ui", "/ui/config", "/ui/settings/appearance");
  expectBase("/openclaw", "/openclaw/focus/dashboard/main");
  expectBase("/company/focus", "/company/focus/focus/terminal");
});

it("reads a namespaced tab reference from the generic URL", () => {
  const ref = { pluginId: "logbook", id: "logbook" };
  expect(pluginTabRefFromSearch("?plugin=logbook&id=logbook")).toEqual(ref);
  expect(pluginTabKey(ref)).toBe("logbook/logbook");
  // Distinct plugins with the same local tab id stay distinct.
  expect(pluginTabKey({ pluginId: "other", id: "logbook" })).not.toBe(pluginTabKey(ref));
});

it("recognizes plugin hub routes", () => {
  const routes = ["plugins", "skills", "skill-workshop", "skill-settings", "sessions"] as const;
  expect(routes.map(isPluginsHubRoute)).toEqual([true, true, true, false, false]);
});

function expectRoutedPath(path: string, route: RouteId, base = "") {
  expect(routeIdFromPath(path, base)).toBe(route);
  expect(dynamicRouteFromPath(path, base)?.[0]).toBe(route);
  expect(inferBasePathFromPathname(path)).toBe(base);
}
