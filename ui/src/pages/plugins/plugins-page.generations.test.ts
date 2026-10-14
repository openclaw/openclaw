/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import type { PluginMutationResult } from "../../lib/plugins/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  clickPluginAction,
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
  settlePlugins,
} from "./plugins-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
});
afterEach(resetPluginsPageTestState);

it.each([
  ["/plugins", "discovery"],
  ["/plugins/catalog-workboard", "discovery"],
  ["/settings/plugins/workboard", "settings"],
] as const)(
  "refreshes published inventory after delayed preload on %s (%s)",
  async (path, surface) => {
    const selector = path === "/plugins" ? ".plugin-catalog-card" : ".plugin-catalog-detail";
    const plugin = createPlugin({ name: "Fresh route plugin" });
    const result = { ...createResult(plugin), generation: 1 };
    const detail = createDiscoveryDetail(plugin);
    detail.plugin.id = "catalog-workboard";
    detail.plugin.catalog.categories = ["productivity"];
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.list") {
        return result;
      }
      if (method === "plugins.catalog.browse") {
        return {
          items: [detail.plugin],
          categories: [
            {
              slug: "productivity",
              label: "Productivity",
              description: "Work tools",
              icon: "checkSquare",
              order: 1,
            },
          ],
        };
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
    await waitForSolid(() => {
      expect(page.querySelector(selector)).not.toBeNull();
      expect(page.querySelector(selector)?.textContent).toContain(plugin.name);
    });
    expect(request.mock.calls.some(([method]) => method === "plugins.list")).toBe(true);
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

it("targets the selected installed route after its stale inventory refresh fails", async () => {
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
    if (method === "plugins.setEnabled") {
      throw new Error("Synthetic enable refused");
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
      methods: ["plugins.setEnabled"],
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
  await waitForSolid(() => expect(page.querySelector("h1")?.textContent).toBe(alpha.name));
  try {
    page.routeData = createPluginsRouteData(
      harness.gateway,
      { ...inventory, generation: 0 },
      createPluginsRouteLocation("/settings/plugins/beta#lifecycle"),
    );
    await page.updateComplete;
    await waitForSolid(() =>
      expect(request.mock.calls.some(([method]) => method === "plugins.list")).toBe(true),
    );
    refresh.reject(new Error("Inventory unavailable"));
    await waitForSolid(() =>
      expect(page.querySelector('[aria-label="Enable Beta"]')).not.toBeNull(),
    );
    await page.updateComplete;
    const enable = page.querySelector<HTMLButtonElement>('[aria-label="Enable Beta"]');
    expect(enable).not.toBeNull();
    enable!.click();
    await waitForSolid(() =>
      expect(request.mock.calls.some(([method]) => method === "plugins.setEnabled")).toBe(true),
    );
    expect(request.mock.calls.filter(([method]) => method === "plugins.setEnabled")).toEqual([
      ["plugins.setEnabled", { pluginId: beta.id, enabled: true }],
    ]);
    expect(page.querySelector("h1")?.textContent).toBe(beta.name);
    expect(page.querySelector(".plugin-catalog-detail")?.textContent).toContain(beta.name);
    await waitForSolid(() => expect(page.querySelector(".btn__spinner")).toBeNull());
  } finally {
    refresh.resolve(inventory);
    await waitForSolid(() => {
      expect(page.querySelector(".btn__spinner")).toBeNull();
    });
    await page.updateComplete;
  }
});

it.each(["settings", "uninstall", "failure"] as const)(
  "keeps the pending install owner after inventory publication: %s",
  async (surface) => {
    const plugin = createPlugin({
      id: "calendar-runtime",
      catalogId: "catalog-calendar",
      name: "Calendar Plus",
      packageName: "community-calendar",
      enabled: true,
      state: "enabled",
      removable: true,
    });
    const catalog = createDiscoveryDetail({ ...plugin, installed: false });
    catalog.plugin.id = "catalog-calendar";
    const install = deferred<PluginMutationResult>();
    const refresh = deferred();
    let inventoryPlugin = plugin;
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.install") {
        return install.promise;
      }
      if (method === "plugins.list") {
        return createResult(inventoryPlugin);
      }
      if (method === "plugins.catalog.get") {
        return catalog;
      }
      if (method === "plugins.inspect") {
        return createInspectResult({ plugin });
      }
      if (method === "plugins.setEnabled" && surface === "failure") {
        inventoryPlugin = { ...plugin, enabled: false, state: "disabled" };
        return {
          ok: true,
          plugin: inventoryPlugin,
          restartRequired: false,
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway, () => refresh.promise),
      createPluginsRouteData(
        harness.gateway,
        createResult([]),
        createPluginsRouteLocation("/plugins/catalog-calendar"),
      ),
    );
    await waitForSolid(() =>
      expect(page.querySelector("openclaw-plugin-install-action")).not.toBeNull(),
    );
    await clickPluginAction(page, "Install");
    try {
      await waitForSolid(() =>
        expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(true),
      );
      const original = page.querySelector("openclaw-plugin-install-action");
      await settlePlugins();
      original?.querySelector("button")?.click();
      await settlePlugins();
      expect(original?.getAttribute("open")).toBe("");
      harness.publishPlugins();
      await waitForSolid(() =>
        expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(true),
      );
      if (surface === "uninstall") {
        const uninstall = page.querySelector<HTMLButtonElement>(
          '[aria-label="Uninstall Calendar Plus"]',
        );
        expect(uninstall).toBeNull();
        expect(
          request.mock.calls.filter(
            ([method]) => method === "plugins.setEnabled" || method === "plugins.uninstall",
          ),
        ).toEqual([]);
      } else {
        if (surface === "settings") {
          page.surface = "settings";
          page.routeData = createPluginsRouteData(
            harness.gateway,
            createResult(plugin),
            createPluginsRouteLocation(`/settings/plugins/${plugin.id}`),
          );
          await page.updateComplete;
        }
        const action = page.querySelector("openclaw-plugin-install-action");
        await settlePlugins();
        expect(action?.textContent).toContain("Installing");
        expect(page.querySelector('[aria-label="Disable Calendar Plus"]')).toBeNull();
        expect(page.querySelector('[aria-label="Uninstall Calendar Plus"]')).toBeNull();
      }
      if (surface === "failure") {
        install.reject(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Final installation check failed",
            details: { persistence: { operation: "install", pluginId: plugin.id } },
          }),
        );
        refresh.resolve();
        await waitForSolid(() =>
          expect(page.textContent).toContain("Final installation check failed"),
        );
        await clickPluginAction(page, "Disable Calendar Plus");
        expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
          pluginId: plugin.id,
          enabled: false,
        });
      } else {
        install.resolve({ ok: true, plugin, restartRequired: false });
      }
      await waitForSolid(() =>
        expect(
          page.querySelector(
            `[aria-label="${surface === "failure" ? "Enable" : "Disable"} Calendar Plus"]`,
          ),
        ).not.toBeNull(),
      );
      expect(page.querySelector("openclaw-plugin-install-action")).toBeNull();
    } finally {
      install.resolve({ ok: true, plugin, restartRequired: false });
      refresh.resolve();
      await settlePlugins();
    }
  },
);

it("retains same-plugin inspection after a failed refresh", async () => {
  const plugin = createPlugin();
  const fresh = deferred<ReturnType<typeof createInspectResult>>();
  const initial = createInspectResult();
  initial.components.skills = ["Known skill"];
  let inspections = 0;
  const { client } = createClient(async (method) => {
    if (method === "plugins.inspect") {
      return ++inspections === 1 ? initial : fresh.promise;
    }
    if (method === "plugins.list") {
      return createResult(plugin);
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const harness = createGateway(client);
  const { page } = await mountPage(
    createContext(harness.gateway),
    createPluginsRouteData(
      harness.gateway,
      createResult(plugin),
      createPluginsRouteLocation("/settings/plugins/workboard"),
    ),
  );
  await waitForSolid(() => expect(page.textContent).toContain("Known skill"));
  harness.publishPlugins();
  await waitForSolid(() => expect(inspections).toBe(2));
  await page.updateComplete;
  expect(page.textContent).toContain("Known skill");
  fresh.reject(new Error("Inspection unavailable"));
  await waitForSolid(() => expect(page.textContent).toContain("Inspection unavailable"));
  expect(page.textContent).toContain("Known skill");
});
