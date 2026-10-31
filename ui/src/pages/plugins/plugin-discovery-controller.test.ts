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

function entry(
  index: number,
  catalog: Partial<PluginDiscoveryEntry["catalog"]> = {},
): PluginDiscoveryEntry {
  return {
    id: `plugin-${index}`,
    catalog: {
      name: `Plugin ${index}`,
      summary: `Plugin ${index} summary`,
      family: "code-plugin",
      official: false,
      categories: [],
      ...catalog,
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
  return { discovery, request, dispose, read: discovery.read };
}

async function settleQuery(
  discovery: ReturnType<typeof createPluginDiscovery>,
  query: string,
  delay = 250,
) {
  discovery.updateQuery(query);
  await vi.advanceTimersByTimeAsync(delay);
}

afterEach(() => {
  vi.useRealTimers();
});

it("settles empty categories, deduplicates warm loads, and retries errors explicitly", async () => {
  let fail = true;
  const { discovery, request, read } = setup([], async () => {
    if (fail) {
      throw new Error("Categories unavailable");
    }
    return { categories: [] };
  });
  await discovery.ensureCategories();
  expect(read().categoriesError).toContain("Categories unavailable");
  await discovery.ensureCategories();
  expect(request).toHaveBeenCalledOnce();
  fail = false;
  await discovery.ensureCategories(true);
  expect(read().categoriesError).toBeNull();
  await discovery.ensureCategories();
  expect(request).toHaveBeenCalledTimes(2);
});

it("uses overview categories when they arrive first without accepting a late category reply", async () => {
  const pending = createDeferred<{ categories: never[] }>();
  const categories = [
    { slug: "memory", label: "Memory", description: "Memory", icon: "brain", order: 0 },
  ];
  const { discovery, read } = setup([], async (method) =>
    method === "plugins.catalog.categories" ? pending.promise : { items: [], categories },
  );
  const loading = discovery.ensureCategories();
  await discovery.refresh();
  expect(read().categories).toEqual(categories);
  pending.resolve({ categories: [] });
  await loading;
  expect(read().categories).toEqual(categories);
});

it("discards category navigation and late responses across connection invalidation", async () => {
  const pending = createDeferred<{
    categories: { slug: string; label: string; description: string; icon: string; order: number }[];
  }>();
  const { discovery, read } = setup([], async () => pending.promise);
  const loading = discovery.ensureCategories();
  discovery.invalidate();
  pending.resolve({
    categories: [{ slug: "old", label: "Old", description: "Old", icon: "brain", order: 0 }],
  });
  await loading;
  expect(read().categories).toEqual([]);
});

it("cancels pending reads and the search debounce when its owner is disposed", async () => {
  vi.useFakeTimers();
  const pending = createDeferred<PluginDiscoveryResult>();
  const { discovery, request, dispose, read } = setup([{ items: [entry(1)] }, pending.promise]);
  await discovery.refresh();

  const loading = discovery.refresh();
  const signal = request.mock.lastCall?.[2]?.signal;
  const browseRead = discovery.read().reads.browse;
  discovery.updateQuery("memory");
  const debounceRead = discovery.read().reads.browse;
  dispose();
  // Readiness retires immediately, while run() retains the actual transport settlement.
  await expect(Promise.all([browseRead, debounceRead])).resolves.toEqual([null, null]);
  expect(signal?.aborted).toBe(true);
  pending.resolve({ items: [entry(2)] });
  await loading;
  await vi.advanceTimersByTimeAsync(250);
  expect(request).toHaveBeenCalledTimes(2);
  expect(read().result?.items).toEqual([entry(1)]);
});

it("populates the grouped home page and keeps it visible during a refresh", async () => {
  const featured = entry(1, {
    featured: true,
    trending: true,
    trendingRank: 1,
    official: true,
    downloads: 10_000,
  });
  const trending = entry(2, { trending: true, trendingRank: 0, downloads: 100 });
  const category = entry(3, { categories: ["memory"] });
  const categories = [
    { slug: "memory", label: "Memory", description: "Memory", icon: "database", order: 0 },
  ];
  const refresh = createDeferred<PluginDiscoveryResult>();
  const { discovery, request, read } = setup([
    { items: [featured, trending, category], categories },
    refresh.promise,
  ]);

  await discovery.refresh();

  expect(read().categories).toEqual(categories);
  expect(read().featured.map((item) => item.id)).toEqual([featured.id]);
  expect(read().trending).toEqual([trending, featured]);
  expect(read().result?.items[0]).toEqual(featured);
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    "plugins.catalog.browse",
    { intent: "all", pageSize: 100 },
    expect.anything(),
  );

  const loading = discovery.refresh();
  expect(read().featured).toEqual([featured]);
  expect(read().trending).toEqual([trending, featured]);
  refresh.resolve({ items: [category], categories });
  await loading;
  expect(read().result?.items).toEqual([category]);
  expect(read().featured).toEqual([]);
  expect(read().trending).toEqual([]);
});

it("counts only settled manual searches across refresh, filters and connection invalidation", async () => {
  vi.useFakeTimers();
  const { discovery, request, read } = setup([], async () => ({
    items: [entry(1)],
    nextCursor: "unsupported-search-page",
  }));
  await discovery.selectIntent("official");
  request.mockClear();
  discovery.updateQuery("m");
  expect(read().intent).toBe("all");
  await vi.advanceTimersByTimeAsync(250);
  expect(request.mock.lastCall?.[1]).not.toHaveProperty("searchSource");
  request.mockClear();

  await settleQuery(discovery, "mem", 200);
  await settleQuery(discovery, "memory", 249);
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.lastCall?.[1]).toEqual({
    intent: "all",
    query: "memory",
    pageSize: 100,
    searchSource: "openclaw-control-ui",
  });
  expect(read().result).toEqual({ items: [entry(1)] });

  for (const query of ["memory ", " memory", "memory"]) {
    request.mockClear();
    discovery.updateQuery(query);
    await vi.advanceTimersByTimeAsync(250);
    expect(request).not.toHaveBeenCalled();
    expect(read().result?.items).toEqual([entry(1)]);
  }

  request.mockClear();
  await discovery.refresh();
  await discovery.selectCategory("memory");
  await vi.advanceTimersByTimeAsync(0);
  await discovery.selectIntent("official");
  await vi.advanceTimersByTimeAsync(0);
  await settleQuery(discovery, "");
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
  const overview = entry(1, { featured: true, trending: true });
  const lateSearch = createDeferred<PluginDiscoveryResult>();
  const { discovery, request, read } = setup([
    { items: [overview] },
    { items: [entry(2)] },
    lateSearch.promise,
  ]);
  await discovery.refresh();
  await settleQuery(discovery, "test");
  expect(read().featured).toEqual([overview]);
  expect(read().trending).toEqual([overview]);
  await settleQuery(discovery, "memory");
  discovery.updateQuery("");

  expect(read().result?.items).toEqual([overview]);
  lateSearch.resolve({ items: [entry(3)] });
  await vi.advanceTimersByTimeAsync(250);
  expect(read().result?.items).toEqual([overview]);
  expect(read().featured).toEqual([overview]);
  expect(read().trending).toEqual([overview]);
  expect(request).toHaveBeenCalledTimes(3);
});

it.each(["category", "featured"] as const)(
  "restores All when clearing a search before debounce from %s",
  async (filter) => {
    vi.useFakeTimers();
    const { discovery, request, read } = setup([{ items: [entry(2)] }, { items: [entry(1)] }]);
    if (filter === "category") {
      await discovery.selectCategory("memory");
    } else {
      await discovery.selectIntent(filter);
    }
    discovery.updateQuery("test");
    await settleQuery(discovery, "");

    expect(read().intent).toBe("all");
    expect(read().category).toBeNull();
    expect(read().result?.items).toEqual([entry(1)]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.lastCall?.[1]).toEqual({ intent: "all", pageSize: 100 });
  },
);

it.each(["refresh", "disconnect", "invalidate"] as const)(
  "reloads overview installation facts after %s while searching",
  async (boundary) => {
    vi.useFakeTimers();
    const available = entry(1, { featured: true, trending: true });
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
    const { discovery, request, read } = setup([
      { items: [available] },
      search,
      ...(boundary === "refresh" ? [search] : []),
      freshOverview.promise,
    ]);
    await discovery.refresh();
    await settleQuery(discovery, "memory");

    await discovery[boundary]();
    request.mockClear();
    discovery.updateQuery("");

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.lastCall?.[1]).toEqual({ intent: "all", pageSize: 100 });
    freshOverview.resolve({ items: [installed] });
    await vi.advanceTimersByTimeAsync(0);
    expect(read().result?.items).toEqual([installed]);
    expect(read().featured).toEqual([installed]);
    expect(read().trending).toEqual([installed]);
  },
);

it("retries a degraded overview when returning from search", async () => {
  vi.useFakeTimers();
  const incomplete = entry(1);
  const recovered = entry(2);
  const recovery = createDeferred<PluginDiscoveryResult>();
  const { discovery, request, read } = setup([
    { items: [incomplete], remoteError: "Catalog unavailable" },
    { items: [entry(3)] },
    recovery.promise,
  ]);
  await discovery.refresh();
  expect(read().remoteError).toBe("Catalog unavailable");
  await settleQuery(discovery, "memory");
  request.mockClear();
  discovery.updateQuery("");

  expect(request).toHaveBeenCalledOnce();
  recovery.resolve({ items: [incomplete, recovered] });
  await vi.advanceTimersByTimeAsync(0);
  expect(read().result?.items).toEqual([incomplete, recovered]);
  expect(read().remoteError).toBeNull();
});

it("loads bounded pages only on expansion and preserves category pin ordering", async () => {
  const pinned = entry(1, { categoryRanks: { tools: 0 } });
  const popular = entry(2, { downloads: 100 });
  const official = entry(0, { official: true, downloads: 10 });
  const promoted = entry(100, { official: true, downloads: 10_000 });
  const firstPage = [
    official,
    pinned,
    popular,
    ...Array.from({ length: 97 }, (_, i) => entry(i + 3)),
  ];
  const { discovery, request, read } = setup([
    { items: firstPage, nextCursor: "catalog-page-2" },
    { items: [promoted] },
  ]);
  await discovery.selectCategory("tools");
  expect(read().result?.items).toHaveLength(100);
  expect(read().result?.items.slice(0, 3)).toEqual([pinned, popular, official]);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "plugins.catalog.browse",
    { intent: "all", category: "tools", pageSize: 100 },
    expect.anything(),
  );
  await discovery.loadMore();
  expect(read().result?.items).toHaveLength(101);
  expect(read().result?.items.slice(0, 4)).toEqual([pinned, promoted, popular, official]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith(
    "plugins.catalog.browse",
    { intent: "all", category: "tools", cursor: "catalog-page-2", pageSize: 100 },
    expect.anything(),
  );
});

it("replaces a first-page local placeholder with later published Media metadata", async () => {
  const placeholder = entry(1, { family: undefined, categories: ["models", "media"] });
  const published = entry(1, {
    categories: ["models", "media"],
    author: "openclaw",
    official: true,
    downloads: 10_000,
  });
  const { discovery, read } = setup([
    { items: [placeholder], nextCursor: "catalog-page-2" },
    { items: [published] },
  ]);
  await discovery.selectCategory("media");
  await discovery.loadMore();
  expect(read().result?.items).toEqual([published]);
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
  const { discovery, read } = setup([], async (method) =>
    method === "plugins.catalog.categories" ? { categories } : { items: [entry(1)], categories },
  );

  await discovery.refresh();
  await discovery.selectCategory("channels");
  discovery.invalidate();
  expect(read().categories).toEqual([]);
  await discovery.ensureCategories();
  await discovery.refresh();

  expect(read().categories).toEqual(categories);
});
