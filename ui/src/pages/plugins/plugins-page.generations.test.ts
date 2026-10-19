/* @vitest-environment jsdom */

import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
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

function rpc(handlers: Record<string, (params: unknown) => unknown>) {
  return createClient(async (method, params) => {
    if (!Object.hasOwn(handlers, method)) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handlers[method](params);
  });
}

function routeData(
  harness: ReturnType<typeof createGateway>,
  path: string,
  result = createResult(),
) {
  return createPluginsRouteData(harness.gateway, result, createPluginsRouteLocation(path));
}

function objectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties };
}

function requests(request: ReturnType<typeof createClient>["request"], name: string) {
  return request.mock.calls.filter(([method]) => method === name);
}

async function waitForRequest(request: ReturnType<typeof createClient>["request"], name: string) {
  await waitForSolid(() => expect(requests(request, name).length).toBeGreaterThan(0));
}

function publishGeneration(
  harness: ReturnType<typeof createGateway>,
  generation: number,
  methods: string[] = [],
) {
  harness.emit(harness.gateway.snapshot.client, true, {
    hello: harness.gateway.snapshot.hello,
    pluginCapabilities: {
      ok: true,
      generation,
      descriptors: [],
      methods,
      controlUiTabs: [],
      controlUiWidgetKinds: [],
      pluginSurfaceUrls: {},
    },
  });
}

it("retains installed settings and an unfinished input across transport loss, but retires them for a new client", async () => {
  const refresh = deferred();
  const { client } = rpc({
    "plugins.list": async () => {
      await refresh.promise;
      return createResult();
    },
    "plugins.inspect": () => createInspectResult(),
  });
  const harness = createGateway(client);
  const context = createContext(harness.gateway);
  context.runtimeConfig.state.connected = true;
  context.runtimeConfig.state.configForm = {
    plugins: { entries: { workboard: { config: { greeting: "Saved greeting" } } } },
  };
  context.runtimeConfig.state.configSchema = objectSchema({
    plugins: objectSchema({
      entries: objectSchema({
        workboard: objectSchema({ config: objectSchema({ greeting: { type: "string" } }) }),
      }),
    }),
  });
  const { page } = await mountPage(
    context,
    routeData(harness, "/settings/plugins/workboard?view=settings"),
  );
  try {
    await waitForSolid(() =>
      expect(page.querySelector('[data-setting="greeting"] input')).not.toBeNull(),
    );
    const input = page.querySelector<HTMLInputElement>('[data-setting="greeting"] input')!;
    input.value = "Unfinished greeting";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    harness.emit(client, false);
    await page.updateComplete;
    expect(page.querySelector('[data-setting="greeting"] input')).toBe(input);
    expect(input.value).toBe("Unfinished greeting");
    harness.emit(client, true);
    await page.updateComplete;
    expect(page.querySelector('[data-setting="greeting"] input')).toBe(input);
    expect(input.value).toBe("Unfinished greeting");
    const replacement = createClient(async () => refresh.promise);
    harness.emit(replacement.client, true);
    await page.updateComplete;
    expect(page.contains(input)).toBe(false);
  } finally {
    refresh.resolve();
  }
});

it.each([
  { access: "admin", granted: ["operator.admin"], revoked: ["operator.read"] },
  { access: "read", granted: ["operator.read"], revoked: [] },
])(
  "retires a pending inventory refresh when $access access is revoked on the same client",
  async ({ granted, revoked }) => {
    const pending = deferred<ReturnType<typeof createResult>>();
    let inventory = pending.promise;
    const { client, request } = rpc({
      "plugins.list": () => inventory,
      "plugins.inspect": () => createInspectResult(),
    });
    const harness = createGateway(client);
    harness.emit(client, true, {
      hello: {
        ...harness.gateway.snapshot.hello!,
        auth: { role: "operator", scopes: granted },
      },
    });
    const location = createPluginsRouteLocation("/settings/plugins/workboard");
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, createResult(), location),
    );
    await waitForSolid(() => expect(page.querySelector(".plugin-catalog-detail")).not.toBeNull());
    harness.publishPlugins();
    await waitForSolid(() => expect(requests(request, "plugins.list")).toHaveLength(1));
    const snapshot = harness.gateway.snapshot;
    harness.emit(client, true, {
      ...snapshot,
      hello: {
        ...snapshot.hello!,
        auth: { role: "operator", scopes: revoked },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".plugin-catalog-detail")).toBeNull();
    if (revoked.length === 0) {
      expect(page.textContent).not.toContain("Workboard");
    }

    pending.resolve(createResult(createPlugin({ name: "Retired inventory" })));
    await setImmediate();
    await settlePlugins();
    expect(page.querySelector(".plugin-catalog-detail")).toBeNull();
    expect(page.textContent).not.toContain("Retired inventory");
    expect(requests(request, "plugins.inspect")).toHaveLength(1);

    inventory = Promise.resolve({ ...createResult(), generation: 1 });
    harness.emit(client, true, snapshot);
    page.routeData = createPluginsRouteData(
      harness.gateway,
      { ...createResult(), generation: 1 },
      location,
    );
    await waitForSolid(() =>
      expect(page.querySelector(".plugin-catalog-detail")?.textContent).toContain("Workboard"),
    );
  },
);

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
    const { client, request } = rpc({
      "plugins.list": () => result,
      "plugins.catalog.browse": () => ({
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
      }),
      "plugins.catalog.get": () => detail,
      "plugins.inspect": () =>
        createInspectResult({
          plugin: {
            id: plugin.id,
            name: plugin.name,
            origin: "global",
            installed: true,
            enabled: false,
          },
        }),
    });
    const harness = createGateway(client);
    const route = createPluginsRouteData(
      harness.gateway,
      { ...createResult(), generation: 0 },
      createPluginsRouteLocation(path),
    );
    const { page } = await mountPage(createContext(harness.gateway), undefined, surface);
    const connect = vi.spyOn(harness.gateway, "connect");
    publishGeneration(harness, 1);
    await page.updateComplete;
    page.routeData = route;
    await page.updateComplete;
    await waitForSolid(() => {
      expect(page.querySelector(selector)).not.toBeNull();
      expect(page.querySelector(selector)?.textContent).toContain(plugin.name);
    });
    expect(requests(request, "plugins.list").length).toBeGreaterThan(0);
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
  const { client, request } = rpc({
    "plugins.list": () => refresh.promise,
    "plugins.inspect": (params) => {
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
    },
    "plugins.setEnabled": () => {
      throw new Error("Synthetic enable refused");
    },
  });
  const harness = createGateway(client);
  publishGeneration(harness, 1, ["plugins.setEnabled"]);
  const { page } = await mountPage(
    createContext(harness.gateway),
    routeData(harness, "/settings/plugins/alpha#lifecycle", inventory),
  );
  await waitForSolid(() => expect(page.querySelector("h1")?.textContent).toBe(alpha.name));
  try {
    page.routeData = routeData(harness, "/settings/plugins/beta#lifecycle", {
      ...inventory,
      generation: 0,
    });
    await page.updateComplete;
    await waitForRequest(request, "plugins.list");
    refresh.reject(new Error("Inventory unavailable"));
    await waitForSolid(() =>
      expect(page.querySelector('[aria-label="Enable Beta"]')).not.toBeNull(),
    );
    await page.updateComplete;
    const enable = page.querySelector<HTMLButtonElement>('[aria-label="Enable Beta"]');
    expect(enable).not.toBeNull();
    enable!.click();
    await waitForRequest(request, "plugins.setEnabled");
    expect(requests(request, "plugins.setEnabled")).toEqual([
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

it.each(["settings", "failure"] as const)(
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
    const { client, request } = rpc({
      "plugins.install": () => install.promise,
      "plugins.list": () => createResult(inventoryPlugin),
      "plugins.catalog.get": () => catalog,
      "plugins.inspect": () => createInspectResult({ plugin }),
      "plugins.setEnabled": () => {
        if (surface !== "failure") {
          throw new Error("Unexpected request: plugins.setEnabled");
        }
        inventoryPlugin = { ...plugin, enabled: false, state: "disabled" };
        return {
          ok: true,
          plugin: inventoryPlugin,
          restartRequired: false,
        };
      },
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway, () => refresh.promise),
      routeData(harness, "/plugins/catalog-calendar", createResult([])),
    );
    await waitForSolid(() =>
      expect(page.querySelector("openclaw-plugin-install-action")).not.toBeNull(),
    );
    await clickPluginAction(page, "Install");
    try {
      await waitForRequest(request, "plugins.install");
      const original = page.querySelector("openclaw-plugin-install-action");
      await settlePlugins();
      original?.querySelector("button")?.click();
      await settlePlugins();
      expect(original?.getAttribute("open")).toBe("");
      harness.publishPlugins();
      await waitForRequest(request, "plugins.inspect");
      expect([
        ...requests(request, "plugins.setEnabled"),
        ...requests(request, "plugins.uninstall"),
      ]).toEqual([]);
      if (surface === "settings") {
        page.surface = "settings";
        page.routeData = routeData(harness, `/settings/plugins/${plugin.id}`, createResult(plugin));
        await page.updateComplete;
      }
      const action = page.querySelector("openclaw-plugin-install-action");
      await settlePlugins();
      expect(action?.textContent).toContain("Installing");
      expect(page.querySelector('[aria-label="Disable Calendar Plus"]')).toBeNull();
      expect(page.querySelector('[aria-label="Uninstall Calendar Plus"]')).toBeNull();
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
  const { client } = rpc({
    "plugins.inspect": () => (++inspections === 1 ? initial : fresh.promise),
    "plugins.list": () => createResult(plugin),
  });
  const harness = createGateway(client);
  const { page } = await mountPage(
    createContext(harness.gateway),
    routeData(harness, "/settings/plugins/workboard", createResult(plugin)),
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
