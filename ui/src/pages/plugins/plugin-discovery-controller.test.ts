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

function setup(responses: PluginDiscoveryResult[]) {
  const host = {
    addController() {},
    removeController() {},
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost;
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi.spyOn(client, "request").mockImplementation(async (method) => {
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

it("pages through retained unified-search overflow without another request", async () => {
  vi.useFakeTimers();
  const matches = Array.from({ length: 101 }, (_, index) => entry(index));
  const { controller, request } = setup([{ items: matches }]);

  controller.updateQuery("plugin");
  await vi.runAllTimersAsync();
  expect(controller.result?.items).toHaveLength(100);

  await controller.nextPage();
  expect(controller.result?.items.map((item) => item.id)).toEqual(["plugin-100"]);

  await controller.previousPage();
  expect(controller.result?.items).toHaveLength(100);
  expect(request).toHaveBeenCalledTimes(1);
});

it("consumes cursorless Bundled overflow without requesting the first page again", async () => {
  const bundled = Array.from({ length: 101 }, (_, index) => entry(index));
  const { controller, request } = setup([{ items: bundled }]);
  controller.intent = "bundled";

  await controller.refresh();
  expect(controller.result?.items).toHaveLength(100);

  await controller.nextPage();
  expect(controller.result?.items.map((item) => item.id)).toEqual(["plugin-100"]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("publishes visible entry changes on fetched and cached page transitions", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    entry(index, `https://cdn.example.test/${index}.png`),
  );
  const secondPage = [entry(100, "https://cdn.example.test/100.png")];
  const { controller, onEntriesChanged } = setup([
    { items: firstPage, nextCursor: "page-2" },
    { items: secondPage },
  ]);

  await controller.refresh();
  expect(onEntriesChanged).toHaveBeenCalledTimes(1);

  await controller.nextPage();
  expect(controller.result?.items.map((item) => item.id)).toEqual(["plugin-100"]);
  expect(onEntriesChanged).toHaveBeenCalledTimes(2);

  await controller.previousPage();
  expect(controller.result?.items).toHaveLength(100);
  expect(onEntriesChanged).toHaveBeenCalledTimes(3);
});

it("retains a failed page cursor for explicit retry without auto-following it", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => entry(index));
  const recoveredPage = [entry(100)];
  const { controller, request } = setup([
    { items: firstPage, nextCursor: "page-2" },
    {
      items: [],
      nextCursor: "page-2",
      remoteError: "ClawHub is unavailable; local plugins remain available.",
    },
    { items: recoveredPage },
  ]);

  await controller.refresh();
  await controller.nextPage();

  expect(request).toHaveBeenCalledTimes(2);
  expect(controller.remoteError).toBe("ClawHub is unavailable; local plugins remain available.");
  expect(controller.canGoNext).toBe(true);
  expect(controller.result?.items).toHaveLength(100);

  await controller.nextPage();

  expect(request).toHaveBeenCalledTimes(3);
  expect(controller.result?.items.map((item) => item.id)).toEqual(["plugin-100"]);
});

it("retains a repeated page cursor for explicit retry instead of auto-following it", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => entry(index));
  const { controller, request } = setup([
    { items: firstPage, nextCursor: "page-2" },
    { items: [], nextCursor: "page-2" },
    { items: [entry(100)] },
  ]);

  await controller.refresh();
  await controller.nextPage();

  expect(request).toHaveBeenCalledTimes(2);
  expect(controller.canGoNext).toBe(true);
  expect(controller.result?.items).toHaveLength(100);

  await controller.nextPage();

  expect(request).toHaveBeenCalledTimes(3);
  expect(controller.result?.items.map((item) => item.id)).toEqual(["plugin-100"]);
});

it("surfaces partial ClawHub failures on the Featured shelf", async () => {
  const { controller } = setup([
    { items: [], remoteError: "ClawHub is unavailable; local plugins remain available." },
  ]);

  await controller.refreshFeatured();

  expect(controller.featuredError).toBe("ClawHub is unavailable; local plugins remain available.");
});

it("clears cached catalog attribution when discovery ownership changes", async () => {
  const attributed = entry(1);
  attributed.local.pluginId = "local-plugin";
  attributed.catalog.author = "first-gateway";
  const { controller } = setup([{ items: [attributed] }]);
  await controller.refresh();
  expect(controller.attributions.get("local-plugin")?.author).toBe("first-gateway");

  controller.invalidate();

  expect(controller.attributions.size).toBe(0);
});
