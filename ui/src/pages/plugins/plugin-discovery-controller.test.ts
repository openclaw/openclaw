// @vitest-environment node
import type { ReactiveControllerHost } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { PluginDiscoveryEntry, PluginDiscoveryResult } from "../../lib/plugins/index.ts";
import { PluginDiscoveryController } from "./plugin-discovery-controller.ts";

function entry(index: number, imageUrl?: string): PluginDiscoveryEntry {
  return {
    id: `plugin-${index}`,
    catalog: {
      name: `Plugin ${index}`,
      summary: `Plugin ${index} summary`,
      family: "code-plugin",
      official: false,
      categories: [],
      ...(imageUrl ? { imageUrl } : {}),
    },
    local: {
      present: true,
      installed: false,
      enabled: false,
      state: "not-installed",
      action: "install",
    },
  };
}

function setup(
  responses: Array<PluginDiscoveryResult | Promise<PluginDiscoveryResult>>,
  responder?: (method: string, params: unknown) => Promise<unknown>,
) {
  const host = {
    addController() {},
    removeController() {},
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost;
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi.spyOn(client, "request").mockImplementation(async (method, params) => {
    if (responder) {
      return (await responder(method, params)) as never;
    }
    if (method !== "plugins.catalog.browse") {
      throw new Error(`unexpected method: ${method}`);
    }
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected catalog request");
    }
    return response;
  });
  const onEntriesChanged = vi.fn();
  const controller = new PluginDiscoveryController(host, {
    getClient: () => client,
    isConnected: () => true,
    onEntriesChanged,
  });
  return { controller, onEntriesChanged, request };
}

afterEach(() => {
  vi.useRealTimers();
});

it("populates the grouped home page from one overview response", async () => {
  const featured = entry(1);
  featured.catalog.featured = true;
  featured.catalog.featuredRank = 0;
  const trending = entry(2);
  trending.catalog.trending = true;
  trending.catalog.trendingRank = 0;
  const category = entry(3);
  category.catalog.categories = ["memory"];
  const categories = [
    { slug: "memory", label: "Memory", description: "Memory", icon: "database", order: 0 },
  ];
  const { controller, request } = setup([{ items: [featured, trending, category], categories }]);

  await controller.refresh();

  expect(controller.categories).toEqual(categories);
  expect(controller.featured.map((item) => item.id)).toEqual([featured.id]);
  expect(controller.trending.map((item) => item.id)).toEqual([trending.id]);
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    "plugins.catalog.browse",
    { intent: "all", pageSize: 100 },
    expect.anything(),
  );
});

it("switches filtered tabs to All when starting a unified search", async () => {
  vi.useFakeTimers();
  const { controller, request } = setup([{ items: [] }]);
  controller.intent = "official";

  controller.updateQuery("memory");
  await vi.runAllTimersAsync();

  expect(controller.intent).toBe("all");
  expect(request).toHaveBeenCalledWith(
    "plugins.catalog.browse",
    expect.objectContaining({ intent: "all", query: "memory" }),
    expect.anything(),
  );
});

it("preserves home navigation when a category completes during the search debounce", async () => {
  vi.useFakeTimers();
  const featured = entry(1);
  featured.catalog.featured = true;
  const trending = entry(2);
  trending.catalog.trending = true;
  const categories = [
    { slug: "channels", label: "Channels", description: "Channels", icon: "globe", order: 0 },
  ];
  const category = createDeferred<PluginDiscoveryResult>();
  const categoryItems = [entry(3)];
  const searchItems = [entry(4)];
  const { controller, request } = setup([
    { items: [featured, trending], categories },
    category.promise,
    { items: searchItems },
  ]);
  await controller.refresh();
  controller.selectCategory("channels");
  controller.updateQuery("calendar");

  category.resolve({ items: categoryItems });
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.lastCall?.[1]).toMatchObject({ category: "channels" });
  expect(controller.result?.items).toEqual(categoryItems);
  expect.soft(controller.categories).toEqual(categories);
  expect.soft(controller.featured).toEqual([featured]);
  expect.soft(controller.trending).toEqual([trending]);

  await vi.advanceTimersByTimeAsync(250);
  expect(request.mock.lastCall?.[1]).toMatchObject({ query: "calendar" });
  expect(controller.result?.items).toEqual(searchItems);
  expect.soft(controller.categories).toEqual(categories);
  expect.soft(controller.featured).toEqual([featured]);
  expect.soft(controller.trending).toEqual([trending]);
});

it("does not expose continuation for search results", async () => {
  vi.useFakeTimers();
  const { controller } = setup([{ items: [entry(1)], nextCursor: "unsupported-search-page" }]);

  controller.updateQuery("memory");
  await vi.runAllTimersAsync();

  expect(controller.result).toEqual({ items: [entry(1)] });
});

it("loads one bounded page initially and continues only after explicit expansion", async () => {
  const promotedMatch = entry(100);
  promotedMatch.catalog.official = true;
  promotedMatch.catalog.downloads = 10_000;
  const matches = [...Array.from({ length: 100 }, (_, index) => entry(index)), promotedMatch];
  const { controller, request } = setup([
    { items: matches.slice(0, 100), nextCursor: "catalog-page-2" },
    { items: matches.slice(100) },
  ]);
  controller.category = "tools";

  await controller.refresh();
  expect(controller.result?.items).toHaveLength(100);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    "plugins.catalog.browse",
    { intent: "all", category: "tools", pageSize: 100 },
    expect.anything(),
  );

  await controller.loadMore();

  expect(controller.result?.items).toHaveLength(101);
  expect(controller.result?.items[0]?.id).toBe(promotedMatch.id);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith(
    "plugins.catalog.browse",
    { intent: "all", category: "tools", cursor: "catalog-page-2", pageSize: 100 },
    expect.anything(),
  );
});

it("replaces a first-page local placeholder with later published metadata", async () => {
  const placeholder = entry(1);
  delete placeholder.catalog.family;
  const published = entry(1);
  published.catalog.author = "openclaw";
  published.catalog.official = true;
  published.catalog.downloads = 10_000;
  const { controller } = setup([
    { items: [placeholder], nextCursor: "catalog-page-2" },
    { items: [published] },
  ]);
  controller.category = "tools";

  await controller.refresh();
  await controller.loadMore();

  expect(controller.result?.items).toEqual([published]);
});

it("preserves independent Trending rank from the deduplicated overview", async () => {
  const official = entry(1);
  official.catalog.official = true;
  official.catalog.downloads = 10_000;
  official.catalog.trending = true;
  official.catalog.trendingRank = 1;
  const community = entry(2);
  community.catalog.downloads = 100;
  community.catalog.trending = true;
  community.catalog.trendingRank = 0;
  const { controller } = setup([{ items: [official, community] }]);

  await controller.refresh();

  expect(controller.result?.items.map((item) => item.id)).toEqual([official.id, community.id]);
  expect(controller.trending.map((item) => item.id)).toEqual([community.id, official.id]);
});

it("keeps unranked overview members after ranked entries", async () => {
  const ranked = entry(1);
  ranked.catalog.featured = true;
  ranked.catalog.featuredRank = 0;
  const unranked = entry(2);
  unranked.catalog.featured = true;
  const { controller } = setup([{ items: [unranked, ranked] }]);

  await controller.refresh();

  expect(controller.featured.map((item) => item.id)).toEqual([ranked.id, unranked.id]);
});

it("sorts a selected category within its bounded page", async () => {
  const installed = entry(0);
  installed.catalog.name = "Installed placeholder";
  delete installed.catalog.family;
  installed.local.installed = true;
  installed.local.action = "manage";
  const popular = entry(1);
  popular.catalog.name = "Popular official plugin";
  popular.catalog.official = true;
  popular.catalog.downloads = 10_000;
  const { controller } = setup([{ items: [installed, popular] }]);

  controller.category = "models";
  await controller.refresh();

  expect(controller.result?.items.map((item) => item.catalog.name)).toEqual([
    "Popular official plugin",
    "Installed placeholder",
  ]);
});

it("preserves category navigation when a filtered view reconnects", async () => {
  const categories = [
    {
      slug: "channels",
      label: "Channels",
      description: "Channels",
      icon: "message-circle",
      order: 0,
    },
  ];
  const { controller } = setup([{ items: [entry(1)], categories }, { items: [entry(2)] }]);

  await controller.refresh();
  controller.category = "channels";
  controller.invalidate();
  await controller.refresh();

  expect(controller.categories).toEqual(categories);
});

it("surfaces a partial ClawHub failure once for the overview", async () => {
  const { controller } = setup([
    { items: [], remoteError: "ClawHub is unavailable; local plugins remain available." },
  ]);

  await controller.refresh();

  expect(controller.remoteError).toBe("ClawHub is unavailable; local plugins remain available.");
});
