// @vitest-environment node
import { createRoot } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { PluginDiscoveryEntry, PluginDiscoveryResult } from "../../lib/plugins/index.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { createPluginDiscovery } from "./plugin-discovery.ts";

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
  const request = createGatewayRequestMock(async (method, params) => {
    if (responder) {
      return responder(method, params);
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
  const client = createTestGatewayClient(request);
  let discovery!: ReturnType<typeof createPluginDiscovery>;
  const dispose = createRoot((stop) => {
    discovery = createPluginDiscovery(
      { getClient: () => client, isConnected: () => true },
      () => {},
    );
    return stop;
  });
  onTestFinished(dispose);
  return { discovery, request, dispose };
}

afterEach(() => {
  vi.useRealTimers();
});

it("loads category navigation without waiting for catalog cards", async () => {
  const browse = createDeferred<PluginDiscoveryResult>();
  const categories = [
    { slug: "memory", label: "Memory", description: "Memory", icon: "brain", order: 0 },
  ];
  const { discovery, request } = setup([], async (method) =>
    method === "plugins.catalog.categories" ? { categories } : browse.promise,
  );
  const loading = discovery.refresh();
  await discovery.ensureCategories();
  expect(request).toHaveBeenCalledWith("plugins.catalog.categories", {}, expect.anything());
  expect(discovery.read().categories).toEqual(categories);
  expect(discovery.read().loading).toBe(true);
  browse.resolve({ items: [] });
  await loading;
  expect(discovery.read().categories).toEqual(categories);
});

it("settles empty categories, deduplicates warm loads, and retries errors explicitly", async () => {
  let fail = true;
  const { discovery, request } = setup([], async () => {
    if (fail) {
      throw new Error("Categories unavailable");
    }
    return { categories: [] };
  });
  await discovery.ensureCategories();
  expect(discovery.read().categoriesLoading).toBe(false);
  expect(discovery.read().categoriesError).toContain("Categories unavailable");
  await discovery.ensureCategories();
  expect(request).toHaveBeenCalledOnce();
  fail = false;
  await discovery.ensureCategories(true);
  expect(discovery.read().categoriesError).toBeNull();
  expect(discovery.read().categoriesLoading).toBe(false);
  await discovery.ensureCategories();
  expect(request).toHaveBeenCalledTimes(2);
});

it("uses overview categories when they arrive first without accepting a late category reply", async () => {
  const pending = createDeferred<{ categories: never[] }>();
  const categories = [
    { slug: "memory", label: "Memory", description: "Memory", icon: "brain", order: 0 },
  ];
  const { discovery } = setup([], async (method) =>
    method === "plugins.catalog.categories" ? pending.promise : { items: [], categories },
  );
  const loading = discovery.ensureCategories();
  expect(discovery.read().categoriesLoading).toBe(true);
  await discovery.refresh();
  expect(discovery.read().categoriesLoading).toBe(false);
  expect(discovery.read().categories).toEqual(categories);
  pending.resolve({ categories: [] });
  await loading;
  expect(discovery.read().categories).toEqual(categories);
});

it("discards category navigation and late responses across connection invalidation", async () => {
  const pending = createDeferred<{
    categories: { slug: string; label: string; description: string; icon: string; order: number }[];
  }>();
  const { discovery } = setup([], async () => pending.promise);
  const loading = discovery.ensureCategories();
  discovery.invalidate();
  pending.resolve({
    categories: [{ slug: "old", label: "Old", description: "Old", icon: "brain", order: 0 }],
  });
  await loading;
  expect(discovery.read().categories).toEqual([]);
  expect(discovery.read().categoriesLoading).toBe(false);
});

it("cancels pending reads and the search debounce when its owner is disposed", async () => {
  vi.useFakeTimers();
  const pending = createDeferred<PluginDiscoveryResult>();
  const { discovery, request, dispose } = setup([{ items: [entry(1)] }, pending.promise]);
  await discovery.refresh();

  const loading = discovery.refresh();
  const signal = request.mock.lastCall?.[2]?.signal;
  discovery.updateQuery("memory");
  dispose();
  expect(signal?.aborted).toBe(true);
  pending.resolve({ items: [entry(2)] });
  await loading;
  await vi.advanceTimersByTimeAsync(250);
  expect(request).toHaveBeenCalledTimes(2);
  expect(discovery.read().result?.items).toEqual([entry(1)]);
});

it("populates the grouped home page and keeps it visible during a refresh", async () => {
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
  const refresh = createDeferred<PluginDiscoveryResult>();
  const { discovery, request } = setup([
    { items: [featured, trending, category], categories },
    refresh.promise,
  ]);

  await discovery.refresh();

  expect(discovery.read().categories).toEqual(categories);
  expect(discovery.read().featured.map((item) => item.id)).toEqual([featured.id]);
  expect(discovery.read().trending.map((item) => item.id)).toEqual([trending.id]);
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    "plugins.catalog.browse",
    { intent: "all", pageSize: 100 },
    expect.anything(),
  );

  const loading = discovery.refresh();
  expect(discovery.read().loading).toBe(false);
  expect(discovery.read().featured).toEqual([featured]);
  expect(discovery.read().trending).toEqual([trending]);
  refresh.resolve({ items: [category], categories });
  await loading;
  expect(discovery.read().result?.items).toEqual([category]);
  expect(discovery.read().featured).toEqual([]);
  expect(discovery.read().trending).toEqual([]);
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
  const search = createDeferred<PluginDiscoveryResult>();
  const categoryItems = [entry(3)];
  const searchItems = [entry(4)];
  const { discovery, request } = setup([
    { items: [featured, trending], categories },
    category.promise,
    search.promise,
  ]);
  await discovery.refresh();
  void discovery.selectCategory("channels");
  expect(discovery.read().loading).toBe(true);
  discovery.updateQuery("calendar");
  expect(discovery.read().loading).toBe(true);

  category.resolve({ items: categoryItems });
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.lastCall?.[1]).toMatchObject({ category: "channels" });
  expect(discovery.read().result?.items).toEqual(categoryItems);
  expect(discovery.read().loading).toBe(true);
  expect.soft(discovery.read().categories).toEqual(categories);
  expect.soft(discovery.read().featured).toEqual([featured]);
  expect.soft(discovery.read().trending).toEqual([trending]);

  await vi.advanceTimersByTimeAsync(250);
  expect(request.mock.lastCall?.[1]).toMatchObject({ query: "calendar" });
  expect(discovery.read().loading).toBe(true);
  search.resolve({ items: searchItems });
  await vi.advanceTimersByTimeAsync(0);
  expect(discovery.read().loading).toBe(false);
  expect(discovery.read().result?.items).toEqual(searchItems);
  expect.soft(discovery.read().categories).toEqual(categories);
  expect.soft(discovery.read().featured).toEqual([featured]);
  expect.soft(discovery.read().trending).toEqual([trending]);
});

it("does not expose continuation for search results", async () => {
  vi.useFakeTimers();
  const { discovery } = setup([{ items: [entry(1)], nextCursor: "unsupported-search-page" }]);

  discovery.updateQuery("memory");
  await vi.runAllTimersAsync();

  expect(discovery.read().result).toEqual({ items: [entry(1)] });
});

it("counts only settled manual searches across refresh, filters and connection invalidation", async () => {
  vi.useFakeTimers();
  const { discovery, request } = setup([], async () => ({ items: [entry(1)] }));
  await discovery.selectIntent("official");
  request.mockClear();
  discovery.updateQuery("m");
  expect(discovery.read().intent).toBe("all");
  await vi.advanceTimersByTimeAsync(250);
  expect(request.mock.lastCall?.[1]).not.toHaveProperty("searchSource");
  request.mockClear();

  discovery.updateQuery("mem");
  await vi.advanceTimersByTimeAsync(200);
  discovery.updateQuery("memory");
  await vi.advanceTimersByTimeAsync(249);
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.lastCall?.[1]).toEqual({
    intent: "all",
    query: "memory",
    pageSize: 100,
    searchSource: "openclaw-control-ui",
  });
  expect(discovery.read().result?.items).toEqual([entry(1)]);

  for (const query of ["memory ", " memory", "memory"]) {
    request.mockClear();
    discovery.updateQuery(query);
    await vi.advanceTimersByTimeAsync(250);
    expect(request).not.toHaveBeenCalled();
    expect(discovery.read().result?.items).toEqual([entry(1)]);
  }

  request.mockClear();
  await discovery.refresh();
  await discovery.selectCategory("memory");
  await vi.advanceTimersByTimeAsync(0);
  await discovery.selectIntent("official");
  await vi.advanceTimersByTimeAsync(0);
  discovery.updateQuery("");
  await vi.advanceTimersByTimeAsync(250);
  for (const [, params] of request.mock.calls) {
    expect(params).not.toHaveProperty("searchSource");
  }

  request.mockClear();
  discovery.updateQuery("calendar");
  discovery.invalidate();
  await vi.advanceTimersByTimeAsync(250);
  expect(request).not.toHaveBeenCalled();
  await discovery.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.lastCall?.[1]).toEqual({ intent: "all", query: "calendar", pageSize: 100 });
  request.mockClear();
  discovery.updateQuery("notion");
  discovery.disconnect();
  await vi.advanceTimersByTimeAsync(250);
  expect(request).not.toHaveBeenCalled();
});

it("restores the loaded overview immediately when clearing search and retires late results", async () => {
  vi.useFakeTimers();
  const overview = entry(1);
  overview.catalog.featured = true;
  overview.catalog.trending = true;
  const lateSearch = createDeferred<PluginDiscoveryResult>();
  const { discovery, request } = setup([
    { items: [overview] },
    { items: [entry(2)] },
    lateSearch.promise,
  ]);
  await discovery.refresh();
  discovery.updateQuery("test");
  await vi.advanceTimersByTimeAsync(250);
  discovery.updateQuery("memory");
  await vi.advanceTimersByTimeAsync(250);
  discovery.updateQuery("");

  expect(discovery.read().loading).toBe(false);
  expect(discovery.read().result?.items).toEqual([overview]);
  lateSearch.resolve({ items: [entry(3)] });
  await vi.advanceTimersByTimeAsync(250);
  expect(discovery.read().result?.items).toEqual([overview]);
  expect(request).toHaveBeenCalledTimes(3);
});

it.each(["category", "featured"] as const)(
  "restores All when clearing a search before debounce from %s",
  async (filter) => {
    vi.useFakeTimers();
    const { discovery, request } = setup([{ items: [entry(2)] }, { items: [entry(1)] }]);
    if (filter === "category") {
      await discovery.selectCategory("memory");
    } else {
      await discovery.selectIntent(filter);
    }
    discovery.updateQuery("test");
    discovery.updateQuery("");
    await vi.advanceTimersByTimeAsync(250);

    expect(discovery.read().intent).toBe("all");
    expect(discovery.read().category).toBeNull();
    expect(discovery.read().result?.items).toEqual([entry(1)]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.lastCall?.[1]).toEqual({ intent: "all", pageSize: 100 });
  },
);

it.each(["refresh", "disconnect", "invalidate"] as const)(
  "reloads overview installation facts after %s while searching",
  async (boundary) => {
    vi.useFakeTimers();
    const available = entry(1);
    available.catalog.featured = true;
    available.catalog.trending = true;
    const installed: PluginDiscoveryEntry = {
      ...available,
      local: {
        ...available.local,
        installed: true,
        enabled: true,
        state: "enabled",
        action: "manage",
      },
    };
    const search = { items: [entry(2)] };
    const freshOverview = createDeferred<PluginDiscoveryResult>();
    const { discovery, request } = setup([
      { items: [available] },
      search,
      ...(boundary === "refresh" ? [search] : []),
      freshOverview.promise,
    ]);
    await discovery.refresh();
    discovery.updateQuery("memory");
    await vi.advanceTimersByTimeAsync(250);

    await discovery[boundary]();
    request.mockClear();
    discovery.updateQuery("");

    expect(discovery.read().loading).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.lastCall?.[1]).toEqual({ intent: "all", pageSize: 100 });
    freshOverview.resolve({ items: [installed] });
    await vi.advanceTimersByTimeAsync(0);
    expect(discovery.read().result?.items).toEqual([installed]);
    expect(discovery.read().featured).toEqual([installed]);
    expect(discovery.read().trending).toEqual([installed]);
    expect(discovery.read().loading).toBe(false);
  },
);

it("retries a degraded overview when returning from search", async () => {
  vi.useFakeTimers();
  const incomplete = entry(1);
  const recovered = entry(2);
  const recovery = createDeferred<PluginDiscoveryResult>();
  const { discovery, request } = setup([
    { items: [incomplete], remoteError: "Catalog unavailable" },
    { items: [entry(3)] },
    recovery.promise,
  ]);
  await discovery.refresh();
  expect(discovery.read().remoteError).toBe("Catalog unavailable");
  discovery.updateQuery("memory");
  await vi.advanceTimersByTimeAsync(250);
  request.mockClear();
  discovery.updateQuery("");

  expect(discovery.read().loading).toBe(true);
  expect(request).toHaveBeenCalledOnce();
  recovery.resolve({ items: [incomplete, recovered] });
  await vi.advanceTimersByTimeAsync(0);
  expect(discovery.read().result?.items).toEqual([incomplete, recovered]);
  expect(discovery.read().remoteError).toBeNull();
  expect(discovery.read().loading).toBe(false);
});

it("loads one bounded page initially and continues only after explicit expansion", async () => {
  const promotedMatch = entry(100);
  promotedMatch.catalog.official = true;
  promotedMatch.catalog.downloads = 10_000;
  const matches = [...Array.from({ length: 100 }, (_, index) => entry(index)), promotedMatch];
  const { discovery, request } = setup([
    { items: matches.slice(0, 100), nextCursor: "catalog-page-2" },
    { items: matches.slice(100) },
  ]);
  await discovery.selectCategory("tools");
  expect(discovery.read().result?.items).toHaveLength(100);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    "plugins.catalog.browse",
    { intent: "all", category: "tools", pageSize: 100 },
    expect.anything(),
  );

  await discovery.loadMore();

  expect(discovery.read().result?.items).toHaveLength(101);
  expect(discovery.read().result?.items[0]?.id).toBe(promotedMatch.id);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith(
    "plugins.catalog.browse",
    { intent: "all", category: "tools", cursor: "catalog-page-2", pageSize: 100 },
    expect.anything(),
  );
});

it("replaces a first-page local placeholder with later published Media metadata", async () => {
  const placeholder = entry(1);
  delete placeholder.catalog.family;
  placeholder.catalog.categories = ["models", "media"];
  const published = entry(1);
  published.catalog.categories = [...placeholder.catalog.categories];
  published.catalog.author = "openclaw";
  published.catalog.official = true;
  published.catalog.downloads = 10_000;
  const { discovery } = setup([
    { items: [placeholder], nextCursor: "catalog-page-2" },
    { items: [published] },
  ]);
  await discovery.selectCategory("media");
  await discovery.loadMore();

  expect(discovery.read().result?.items).toEqual([published]);
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
  const { discovery } = setup([{ items: [official, community] }]);

  await discovery.refresh();

  expect(discovery.read().result?.items.map((item) => item.id)).toEqual([
    official.id,
    community.id,
  ]);
  expect(discovery.read().trending.map((item) => item.id)).toEqual([community.id, official.id]);
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
  const { discovery } = setup([], async (method) =>
    method === "plugins.catalog.categories" ? { categories } : { items: [entry(1)], categories },
  );

  await discovery.refresh();
  await discovery.selectCategory("channels");
  discovery.invalidate();
  expect(discovery.read().categories).toEqual([]);
  await discovery.ensureCategories();
  await discovery.refresh();

  expect(discovery.read().categories).toEqual(categories);
});

it("sorts category pins before downloads on the first page and after pagination", async () => {
  const pinned = entry(1);
  pinned.catalog.categoryRanks = { models: 0 };
  const official = entry(2);
  official.catalog.official = true;
  official.catalog.downloads = 10;
  const popular = entry(3);
  popular.catalog.downloads = 100;
  const { discovery } = setup([
    { items: [official, pinned], nextCursor: "next" },
    { items: [popular] },
  ]);
  await discovery.selectCategory("models");
  expect(discovery.read().result?.items.map((item) => item.id)).toEqual([pinned.id, official.id]);
  await discovery.loadMore();
  expect(discovery.read().result?.items.map((item) => item.id)).toEqual([
    pinned.id,
    popular.id,
    official.id,
  ]);
});
