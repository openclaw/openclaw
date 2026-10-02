// @vitest-environment node
import {
  createRouter,
  definePage,
  type PageDefinition,
  type RouteLoaderOptions,
  type RouteLocation,
  type RouterHistory,
} from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import { pathForRoute, routePageSpec, type RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { pages } from "./route.ts";

type RouteModule = Awaited<ReturnType<(typeof pages)[number]["component"]>>;
type Page = PageDefinition<RouteId, ApplicationContext, RouteModule>;

const page = (id: RouteId) => pages.find((candidate) => candidate.id === id) as Page;
const component = async () => ({ renderSolid: () => null });
const routerFor = (...routes: Page[]) =>
  createRouter<RouteId, ApplicationContext, RouteModule>({ routes });
const runtimeConfig = () => ({
  ensureLoaded: vi.fn(() => Promise.resolve()),
  ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
});

function memoryHistory(origin: RouteLocation) {
  const entries = [origin];
  let cursor = 0;
  let onPop: (location: RouteLocation) => void = () => undefined;
  const location = () => entries[cursor]!;
  const replace = vi.fn((next: RouteLocation) => {
    entries[cursor] = next;
  });
  const push = vi.fn((next: RouteLocation) => {
    entries.splice(++cursor, entries.length, next);
  });
  const history: RouterHistory = {
    location,
    push,
    replace,
    listen: (listener) => {
      onPop = listener;
      return () => undefined;
    },
  };
  const pop = (offset: number) => {
    cursor += offset;
    onPop(location());
  };
  return { entries, history, replace, push, pop };
}

function locationFromUrl(url: string): RouteLocation {
  const parsed = new URL(url, "https://control.test");
  return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
}

function loaderOptions(location: RouteLocation): RouteLoaderOptions {
  return createRouteLoaderOptions(
    location,
    `${location.pathname}\u0000${location.search}\u0000${location.hash}`,
  );
}

const targetPage = (id: RouteId) => definePage({ ...routePageSpec(id), component }) as Page;

it.each([
  [
    "/ui/settings/general?section=env#config-section-env",
    "/ui/settings/appearance?section=__appearance__#settings-language",
  ],
  ["/config#settings-general-model", "/settings/model-providers#settings-model-behavior"],
])("performs at most one replace for %s and never oscillates", async (sourceUrl, targetUrl) => {
  const { history, replace, push } = memoryHistory(locationFromUrl(sourceUrl));
  const router = routerFor(page("config"), targetPage("appearance"), targetPage("model-providers"));
  const basePath = sourceUrl.startsWith("/ui/") ? "/ui" : "";
  const context = { basePath } as ApplicationContext;

  try {
    await router.start(history, basePath, context);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await router.navigateLocation({ ...history.location() }, context);
    }

    expect(replace).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    expect(history.location()).toEqual(locationFromUrl(targetUrl));
  } finally {
    router.stop();
  }
});
it("loads readable config without requesting the admin-only schema", async () => {
  const config = runtimeConfig();
  const context = { runtimeConfig: config } as unknown as ApplicationContext;
  const location = locationFromUrl("/settings/updates");

  await page("updates").loader?.(context, loaderOptions(location));
  await Promise.resolve();

  expect(config.ensureLoaded).toHaveBeenCalledOnce();
  expect(config.ensureSchemaLoaded).not.toHaveBeenCalled();
});
it("captures intent before config loading and changes the cache key for a newer choice", async () => {
  const memoryPage = page("memory");
  const selection = { intentRevision: 3 };
  const context = {
    settingsAgentSelection: selection,
    runtimeConfig: {
      ...runtimeConfig(),
      ensureLoaded: vi.fn(() => {
        selection.intentRevision += 1;
        return Promise.resolve();
      }),
    },
  } as unknown as ApplicationContext;
  const location = locationFromUrl("/settings/memory?agent=research");
  const previousKey = memoryPage.loaderDeps?.(context, location);
  const data = await memoryPage.loader?.(context, loaderOptions(location));

  expect(data).toMatchObject({ agentSelectionIntent: { owner: selection, revision: 3 } });
  expect(memoryPage.loaderDeps?.(context, location)).not.toBe(previousKey);
});
const movedSections = [
  ["communications", "__notifications__", "notifications", ""],
  ["communications", "channels", "channels", ""],
  ["communications", "broadcast", "advanced", "?section=broadcast"],
  ["communications", "talk", "talk", "?section=talk"],
  ["appearance", "wizard", "advanced", "?section=wizard"],
  ["advanced", "transcripts", "communications", "?section=transcripts&advanced=1"],
  ["automation", "approvals", "security", "?section=approvals"],
  ["automation", "plugins", "plugin-settings", "?tab=advanced"],
  ["ai-agents", "memory", "memory", "?section=memory"],
  ["ai-agents", "models", "model-providers", ""],
] as const;

describe.each(["", "/ui"])("moved Settings sections with base path %j", (basePath) => {
  it.each(movedSections)(
    "replaces %s section %s and preserves Back/Forward",
    async (sourceId, section, targetId, search) => {
      const hash = `#config-section-${section}`;
      const origin = locationFromUrl(`${basePath}/settings/updates`);
      const destination = { pathname: pathForRoute(targetId, basePath), search, hash };
      const { entries, history, replace, pop } = memoryHistory(origin);
      const config = runtimeConfig();
      const context = { basePath, runtimeConfig: config } as unknown as ApplicationContext;
      const router = routerFor(
        { ...page(sourceId), component },
        targetPage("updates"),
        targetPage(targetId),
      );
      try {
        await router.start(history, basePath, context);
        await router.navigate(
          sourceId,
          context,
          { history: "push" },
          {
            pathname: pathForRoute(sourceId, basePath),
            search: `?section=${section}`,
            hash,
          },
        );
        expect(entries).toEqual([origin, destination]);
        expect(replace).toHaveBeenCalledOnce();
        expect(config.ensureLoaded).not.toHaveBeenCalled();
        expect(config.ensureSchemaLoaded).not.toHaveBeenCalled();
        expect(router.getState().resolvedLocation).toEqual(destination);

        pop(-1);
        await expect.poll(() => router.getState().resolvedLocation).toEqual(origin);
        pop(1);
        await expect.poll(() => router.getState().resolvedLocation).toEqual(destination);
      } finally {
        router.stop();
      }
    },
  );
});
