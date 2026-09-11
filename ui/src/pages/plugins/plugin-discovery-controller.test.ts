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
  const trending = entry(2);
  trending.catalog.trending = true;
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

it("loads one bounded catalog page without following its cursor", async () => {
  const matches = Array.from({ length: 101 }, (_, index) => entry(index));
  const { controller, request } = setup([
    { items: matches.slice(0, 100), nextCursor: "catalog-page-2" },
    { items: matches.slice(100) },
  ]);

  await controller.refresh();
  expect(controller.result?.items).toHaveLength(100);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    "plugins.catalog.browse",
    { intent: "all", pageSize: 100 },
    expect.anything(),
  );
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

it("surfaces partial ClawHub failures on the Featured shelf", async () => {
  const { controller } = setup([
    { items: [], remoteError: "ClawHub is unavailable; local plugins remain available." },
  ]);

  await controller.refresh();

  expect(controller.featuredError).toBe("ClawHub is unavailable; local plugins remain available.");
});
