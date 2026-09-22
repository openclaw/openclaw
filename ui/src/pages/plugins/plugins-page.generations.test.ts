/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createClient,
  createContext,
  createDiscoveryDetail,
  createInspectResult,
  createGateway,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

beforeEach(() => i18n.setLocale("en"));
afterEach(resetPluginsPageTestState);

it.each([false, true])(
  "refreshes a published plugin generation with a delayed route: %s",
  async (delayed) => {
    const result = {
      ...createResult(createPlugin({ enabled: true, state: "enabled" })),
      generation: 1,
    };
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.list") {
        return result;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client);
    const route = createPluginsRouteData(harness.gateway, { ...createResult(), generation: 0 });
    const { page } = await mountPage(
      createContext(harness.gateway),
      delayed ? undefined : route,
      "settings",
    );
    const connect = vi.spyOn(harness.gateway, "connect");
    const before = harness.gateway.snapshot;
    harness.emit(client, true, {
      hello: before.hello,
      pluginCapabilities: {
        ok: true,
        generation: 1,
        descriptors: [],
        methods: [],
        controlUiTabs: [],
        controlUiWidgetKinds: [],
        pluginSurfaceUrls: {},
      },
    });
    if (delayed) {
      page.routeData = route;
      await page.updateComplete;
    }
    await waitForFast(() =>
      expect(
        page.querySelector('[data-plugin-id="workboard"] [data-plugin-state="enabled"]'),
      ).not.toBeNull(),
    );
    expect(page.result?.generation).toBe(1);
    expect(request).toHaveBeenCalledWith(
      "plugins.list",
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(connect).not.toHaveBeenCalled();
  },
);

it.each([
  { path: "/plugins", surface: "discovery", selector: ".plugin-catalog-card" },
  { path: "/plugins/catalog-workboard", surface: "discovery", selector: ".plugin-catalog-detail" },
  { path: "/settings/plugins/workboard", surface: "settings", selector: ".plugin-catalog-detail" },
] as const)(
  "opens $path when its preload arrives after publication",
  async ({ path, surface, selector }) => {
    const plugin = createPlugin({ name: "Fresh route plugin" });
    const result = { ...createResult(plugin), generation: 1 };
    const detail = createDiscoveryDetail(plugin);
    detail.plugin.id = "catalog-workboard";
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.list") {
        return result;
      }
      if (method === "plugins.catalog.browse") {
        return { items: [detail.plugin] };
      }
      if (method === "plugins.catalog.get") {
        return detail;
      }
      if (method === "plugins.inspect") {
        return createInspectResult({
          plugin: {
            id: plugin.id,
            name: plugin.name,
            origin: "global",
            installed: true,
            enabled: false,
          },
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client);
    const route = createPluginsRouteData(
      harness.gateway,
      { ...createResult(), generation: 0 },
      createPluginsRouteLocation(path),
    );
    const { page } = await mountPage(createContext(harness.gateway), undefined, surface);
    const connect = vi.spyOn(harness.gateway, "connect");
    harness.emit(client, true, {
      hello: harness.gateway.snapshot.hello,
      pluginCapabilities: {
        ok: true,
        generation: 1,
        descriptors: [],
        methods: [],
        controlUiTabs: [],
        controlUiWidgetKinds: [],
        pluginSurfaceUrls: {},
      },
    });
    await page.updateComplete;
    page.routeData = route;
    await page.updateComplete;
    await waitForFast(() =>
      expect(page.querySelector(selector)?.textContent).toContain(plugin.name),
    );
    expect(page.result?.generation).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(
      request.mock.calls.some(
        ([method]) =>
          method ===
          (surface === "settings"
            ? "plugins.inspect"
            : path === "/plugins"
              ? "plugins.catalog.browse"
              : "plugins.catalog.get"),
      ),
    ).toBe(true);
  },
);

it.each(["pending", "failed"] as const)(
  "targets the selected installed route while its stale inventory refresh is %s",
  async (refreshState) => {
    const alpha = createPlugin({ id: "alpha", name: "Alpha" });
    const beta = createPlugin({ id: "beta", name: "Beta" });
    const inventory = { ...createResult([alpha, beta]), generation: 1 };
    const refresh = deferred<typeof inventory>();
    const { client, request } = createClient(async (method, params) => {
      if (method === "plugins.list") {
        return refresh.promise;
      }
      if (method === "plugins.inspect") {
        const plugin = (params as { pluginId: string }).pluginId === alpha.id ? alpha : beta;
        return createInspectResult({
          plugin: {
            id: plugin.id,
            name: plugin.name,
            origin: "global",
            installed: true,
            enabled: false,
          },
        });
      }
      if (method === "plugins.reload") {
        throw new Error("Synthetic reload refused");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client);
    harness.emit(client, true, {
      hello: harness.gateway.snapshot.hello,
      pluginCapabilities: {
        ok: true,
        generation: 1,
        descriptors: [],
        methods: ["plugins.reload"],
        controlUiTabs: [],
        controlUiWidgetKinds: [],
        pluginSurfaceUrls: {},
      },
    });
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(
        harness.gateway,
        inventory,
        createPluginsRouteLocation("/settings/plugins/alpha#lifecycle"),
      ),
    );
    await waitForFast(() => expect(page.detail?.inspection?.plugin.id).toBe(alpha.id));
    try {
      page.routeData = createPluginsRouteData(
        harness.gateway,
        { ...inventory, generation: 0 },
        createPluginsRouteLocation("/settings/plugins/beta#lifecycle"),
      );
      await page.updateComplete;
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === "plugins.list")).toBe(true),
      );
      if (refreshState === "failed") {
        refresh.reject(new Error("Inventory unavailable"));
        await waitForFast(() => expect(page.loading).toBe(false));
        await page.updateComplete;
      }
      const reload = page.querySelector<HTMLButtonElement>(".plugins-reload");
      expect(reload).not.toBeNull();
      reload!.click();
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === "plugins.reload")).toBe(true),
      );
      expect(request.mock.calls.filter(([method]) => method === "plugins.reload")).toEqual([
        ["plugins.reload", { plugins: [{ pluginId: beta.id }] }],
      ]);
      expect(page.detail?.pluginId).toBe(beta.id);
      expect(page.querySelector(".plugin-catalog-detail")?.textContent).toContain(beta.name);
      await waitForFast(() => expect(page.busy["plugin:beta"]).toBeUndefined());
    } finally {
      refresh.resolve(inventory);
      await waitForFast(() => {
        expect(page.loading).toBe(false);
        expect(Object.keys(page.busy)).toEqual([]);
      });
      await page.updateComplete;
    }
  },
);
