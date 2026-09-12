// @vitest-environment node
import type { ReactiveControllerHost } from "lit";
import { afterEach, expect, it, vi } from "vitest";
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
  responses: PluginDiscoveryResult[],
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
  const scope = { client, epoch: 0 };
  const controller = new PluginDiscoveryController(host, {
    getClient: () => client,
    isConnected: () => true,
    capture: () => scope,
    isCurrent: (candidate) => candidate === scope,
    onEntriesChanged,
  });
  return { controller, onEntriesChanged, request };
}

afterEach(() => {
  vi.useRealTimers();
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

it("hydrates grouped shelves from each category's top results", async () => {
  const globalFinance = entry(0);
  globalFinance.catalog.categories = ["finance-payments"];
  const financeSecond = entry(1);
  financeSecond.catalog.categories = [];
  financeSecond.catalog.official = true;
  const agentMail = entry(2);
  agentMail.catalog.categories = [];
  const { controller, request } = setup([], async (method, params) => {
    if (method === "plugins.catalog.categories") {
      return {
        categories: [
          {
            slug: "finance-payments",
            label: "Finance & payments",
            description: "Finance",
            icon: "package",
            order: 0,
          },
          {
            slug: "inbox-collaboration",
            label: "Inbox & collaboration",
            description: "Inbox",
            icon: "package",
            order: 1,
          },
        ],
      };
    }
    if (method !== "plugins.catalog.browse") {
      throw new Error(`unexpected method: ${method}`);
    }
    const category = (params as { category?: string }).category;
    if (!category) {
      return { items: [globalFinance] };
    }
    return {
      items:
        category === "finance-payments" ? [globalFinance, financeSecond, agentMail] : [agentMail],
    };
  });

  await controller.refresh();
  await controller.refreshCategories();

  expect(controller.result?.items.map((item) => item.id)).toEqual([
    financeSecond.id,
    globalFinance.id,
    agentMail.id,
  ]);
  expect(
    controller.result?.items.find((item) => item.id === financeSecond.id)?.catalog.categories,
  ).toContain("finance-payments");
  expect(
    controller.result?.items.find((item) => item.id === agentMail.id)?.catalog.categories,
  ).toEqual(["finance-payments", "inbox-collaboration"]);
  expect(request).toHaveBeenCalledWith(
    "plugins.catalog.browse",
    { intent: "all", category: "finance-payments", pageSize: 8 },
    expect.anything(),
  );
  expect(request).toHaveBeenCalledWith(
    "plugins.catalog.browse",
    { intent: "all", category: "inbox-collaboration", pageSize: 8 },
    expect.anything(),
  );
});

it("automatically loads every available catalog cursor page", async () => {
  const matches = Array.from({ length: 101 }, (_, index) => entry(index));
  const { controller, request } = setup([
    { items: matches.slice(0, 100), nextCursor: "catalog-page-2" },
    { items: matches.slice(100) },
  ]);

  await controller.refresh();
  expect(controller.result?.items).toHaveLength(101);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith(
    "plugins.catalog.browse",
    { intent: "all", cursor: "catalog-page-2", pageSize: 100 },
    expect.anything(),
  );
});

it("sorts a selected category after reconciling every cursor page", async () => {
  const installed = entry(0);
  installed.catalog.name = "Installed placeholder";
  delete installed.catalog.family;
  installed.local.installed = true;
  installed.local.action = "manage";
  const popular = entry(1);
  popular.catalog.name = "Popular official plugin";
  popular.catalog.official = true;
  popular.catalog.downloads = 10_000;
  const { controller } = setup([
    { items: [installed], nextCursor: "catalog-page-2" },
    { items: [popular] },
  ]);

  controller.category = "models";
  await controller.refresh();

  expect(controller.result?.items.map((item) => item.catalog.name)).toEqual([
    "Popular official plugin",
    "Installed placeholder",
  ]);
});

it("deduplicates identities across cursor pages while retaining catalog and local facts", async () => {
  const installed = entry(0);
  installed.id = "shared-plugin";
  installed.catalog.name = "Bundled placeholder";
  installed.catalog.summary = "Bundled placeholder summary";
  delete installed.catalog.family;
  installed.local.pluginId = "shared-plugin";
  installed.local.installed = true;
  installed.local.state = "enabled";
  installed.local.action = "manage";
  const published = entry(1, "https://cdn.example/plugin.png");
  published.id = installed.id;
  published.catalog.name = "Published plugin";
  published.catalog.summary = "Published plugin summary";
  published.catalog.official = true;
  published.catalog.author = "publisher";
  published.catalog.downloads = 42;
  const { controller } = setup([
    { items: [installed], nextCursor: "catalog-page-2" },
    { items: [published] },
  ]);

  await controller.refresh();

  expect(controller.result?.items).toHaveLength(1);
  expect(controller.result?.items[0]).toMatchObject({
    catalog: {
      name: "Published plugin",
      summary: "Published plugin summary",
      official: true,
      author: "publisher",
      downloads: 42,
      imageUrl: "https://cdn.example/plugin.png",
    },
    local: { installed: true, state: "enabled", action: "manage" },
  });
});

it("retains published presentation when a local placeholder arrives later", async () => {
  const published = entry(0, "https://cdn.example/plugin.png");
  published.id = "shared-plugin";
  published.catalog.name = "Published plugin";
  published.catalog.summary = "Published plugin summary";
  published.catalog.official = true;
  published.catalog.downloads = 42;
  const installed = entry(1);
  installed.id = published.id;
  installed.catalog.name = "Bundled placeholder";
  installed.catalog.summary = "Bundled placeholder summary";
  delete installed.catalog.family;
  installed.local.pluginId = "shared-plugin";
  installed.local.installed = true;
  installed.local.state = "enabled";
  installed.local.action = "manage";
  const { controller } = setup([
    { items: [published], nextCursor: "catalog-page-2" },
    { items: [installed] },
  ]);

  await controller.refresh();

  expect(controller.result?.items[0]).toMatchObject({
    catalog: {
      name: "Published plugin",
      summary: "Published plugin summary",
      official: true,
      downloads: 42,
      imageUrl: "https://cdn.example/plugin.png",
    },
    local: { installed: true, state: "enabled", action: "manage" },
  });
});

it("keeps loaded catalog pages when a later cursor request fails", async () => {
  let requestCount = 0;
  const firstPage = Array.from({ length: 100 }, (_, index) => entry(index));
  const { controller } = setup([], async (method) => {
    if (method !== "plugins.catalog.browse") {
      throw new Error(`unexpected method: ${method}`);
    }
    requestCount += 1;
    if (requestCount === 1) {
      return { items: firstPage, nextCursor: "catalog-page-2" };
    }
    throw new Error("ClawHub cursor unavailable");
  });

  await controller.refresh();

  expect(controller.result?.items).toEqual(
    firstPage.toSorted((left, right) => left.catalog.name.localeCompare(right.catalog.name)),
  );
  expect(controller.remoteError).toContain("ClawHub cursor unavailable");
});

it("surfaces rejected category shelf requests", async () => {
  const globalFinance = entry(0);
  globalFinance.catalog.categories = ["finance-payments"];
  const { controller } = setup([], async (method, params) => {
    if (method === "plugins.catalog.categories") {
      return {
        categories: [
          {
            slug: "finance-payments",
            label: "Finance & payments",
            description: "Finance",
            icon: "package",
            order: 0,
          },
        ],
      };
    }
    if (method !== "plugins.catalog.browse") {
      throw new Error(`unexpected method: ${method}`);
    }
    if ((params as { category?: string }).category) {
      throw new Error("category unavailable");
    }
    return { items: [globalFinance] };
  });

  await controller.refresh();
  await controller.refreshCategories();

  expect(controller.remoteError).toContain("category unavailable");
});

it("preserves enriched catalog facts from a fulfilled category fallback", async () => {
  const enriched = entry(0, "https://cdn.example/plugin.png");
  enriched.catalog.categories = [];
  enriched.catalog.official = true;
  enriched.catalog.author = "publisher";
  enriched.catalog.downloads = 42;
  const fallback = entry(1);
  fallback.id = enriched.id;
  fallback.catalog.name = enriched.catalog.name;
  fallback.local.pluginId = "plugin-0";
  fallback.local.installed = true;
  fallback.local.state = "enabled";
  fallback.local.action = "manage";
  const { controller } = setup([], async (method, params) => {
    if (method === "plugins.catalog.categories") {
      return {
        categories: [
          {
            slug: "tools",
            label: "Tools",
            description: "Tools",
            icon: "package",
            order: 0,
          },
        ],
      };
    }
    if (method !== "plugins.catalog.browse") {
      throw new Error(`unexpected method: ${method}`);
    }
    return (params as { category?: string }).category
      ? { items: [fallback], remoteError: "ClawHub unavailable" }
      : { items: [enriched] };
  });

  await controller.refresh();
  await controller.refreshCategories();

  expect(controller.result?.items).toHaveLength(1);
  expect(controller.result?.items[0]).toMatchObject({
    catalog: {
      official: true,
      author: "publisher",
      downloads: 42,
      imageUrl: "https://cdn.example/plugin.png",
      categories: ["tools"],
    },
    local: { installed: true, state: "enabled", action: "manage" },
  });
  expect(controller.remoteError).toBe("ClawHub unavailable");
});

it("surfaces partial ClawHub failures on the Featured shelf", async () => {
  const { controller } = setup([
    { items: [], remoteError: "ClawHub is unavailable; local plugins remain available." },
  ]);

  await controller.refreshFeatured();

  expect(controller.featuredError).toBe("ClawHub is unavailable; local plugins remain available.");
});
