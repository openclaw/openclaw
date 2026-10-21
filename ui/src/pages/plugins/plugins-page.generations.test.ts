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
import { pageFixture, queryWithin } from "./plugins-page.lifecycle-test-support.ts";
import {
  clickPluginAction,
  createClient,
  createDiscoveryDetail,
  createInspectResult,
  createPlugin,
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

function objectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties };
}

it("retains installed settings and an unfinished input across transport loss, but retires them for a new client", async () => {
  const refresh = deferred();
  const harness = pageFixture({
    "plugins.list": async () => {
      await refresh.promise;
      return createResult();
    },
    "plugins.inspect": () => createInspectResult(),
  });
  const { client, context } = harness;
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
  const { page, find } = await harness.mount("/settings/plugins/workboard?view=settings");
  try {
    await waitForSolid(() => expect(find('[data-setting="greeting"] input')).not.toBeNull());
    const input = find<HTMLInputElement>('[data-setting="greeting"] input')!;
    input.value = "Unfinished greeting";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    harness.emit(client, false);
    await page.updateComplete;
    expect(find('[data-setting="greeting"] input')).toBe(input);
    expect(input.value).toBe("Unfinished greeting");
    harness.emit(client, true);
    await page.updateComplete;
    expect(find('[data-setting="greeting"] input')).toBe(input);
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
    const harness = pageFixture({
      "plugins.list": () => inventory,
      "plugins.inspect": () => createInspectResult(),
    });
    const { client } = harness;
    harness.emit(client, true, {
      hello: {
        ...harness.gateway.snapshot.hello!,
        auth: { role: "operator", scopes: granted },
      },
    });
    const { page, find } = await harness.mount();
    await waitForSolid(() => expect(find(".plugin-catalog-detail")).not.toBeNull());
    harness.publishPlugins();
    await waitForSolid(() => expect(harness.calls("plugins.list")).toHaveLength(1));
    const snapshot = harness.gateway.snapshot;
    harness.emit(client, true, {
      ...snapshot,
      hello: {
        ...snapshot.hello!,
        auth: { role: "operator", scopes: revoked },
      },
    });
    await page.updateComplete;
    expect(find(".plugin-catalog-detail")).toBeNull();
    if (revoked.length === 0) {
      expect(page.textContent).not.toContain("Workboard");
    }

    pending.resolve(createResult(createPlugin({ name: "Retired inventory" })));
    await setImmediate();
    await settlePlugins();
    expect(find(".plugin-catalog-detail")).toBeNull();
    expect(page.textContent).not.toContain("Retired inventory");
    expect(harness.calls("plugins.inspect")).toHaveLength(1);

    inventory = Promise.resolve({ ...createResult(), generation: 1 });
    harness.emit(client, true, snapshot);
    page.routeData = harness.route("/settings/plugins/workboard", {
      ...createResult(),
      generation: 1,
    });
    await waitForSolid(() =>
      expect(find(".plugin-catalog-detail")?.textContent).toContain("Workboard"),
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
    const harness = pageFixture({
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
    const route = harness.route(path, { ...createResult(), generation: 0 });
    const { page } = await mountPage(harness.context, undefined, surface);
    const find = queryWithin(page);
    const connect = vi.spyOn(harness.gateway, "connect");
    harness.publishGeneration(1);
    await page.updateComplete;
    page.routeData = route;
    await page.updateComplete;
    await waitForSolid(() => {
      expect(find(selector)?.textContent).toContain(plugin.name);
    });
    expect(harness.calls("plugins.list").length).toBeGreaterThan(0);
    expect(connect).not.toHaveBeenCalled();
    expect(
      harness.request.mock.calls.some(
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
  const harness = pageFixture({
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
  harness.publishGeneration(1, ["plugins.setEnabled"]);
  const { page, find } = await harness.mount("/settings/plugins/alpha#lifecycle", inventory);
  await waitForSolid(() => expect(find("h1")?.textContent).toBe(alpha.name));
  try {
    page.routeData = harness.route("/settings/plugins/beta#lifecycle", {
      ...inventory,
      generation: 0,
    });
    await page.updateComplete;
    await harness.waitForCall("plugins.list");
    refresh.reject(new Error("Inventory unavailable"));
    await waitForSolid(() => expect(find('[aria-label="Enable Beta"]')).not.toBeNull());
    await page.updateComplete;
    const enable = find<HTMLButtonElement>('[aria-label="Enable Beta"]');
    expect(enable).not.toBeNull();
    enable!.click();
    await harness.waitForCall("plugins.setEnabled");
    expect(harness.calls("plugins.setEnabled")).toEqual([
      ["plugins.setEnabled", { pluginId: beta.id, enabled: true }],
    ]);
    expect(find("h1")?.textContent).toBe(beta.name);
    expect(find(".plugin-catalog-detail")?.textContent).toContain(beta.name);
    await waitForSolid(() => expect(find(".btn__spinner")).toBeNull());
  } finally {
    refresh.resolve(inventory);
    await waitForSolid(() => {
      expect(find(".btn__spinner")).toBeNull();
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
    const harness = pageFixture(
      {
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
      },
      () => refresh.promise,
    );
    const { page, find } = await harness.mount("/plugins/catalog-calendar", createResult([]));
    await waitForSolid(() => expect(find("openclaw-plugin-install-action")).not.toBeNull());
    await clickPluginAction(page, "Install");
    try {
      await harness.waitForCall("plugins.install");
      const original = find("openclaw-plugin-install-action");
      await settlePlugins();
      original?.querySelector("button")?.click();
      await settlePlugins();
      expect(original?.getAttribute("open")).toBe("");
      harness.publishPlugins();
      await harness.waitForCall("plugins.inspect");
      expect([
        ...harness.calls("plugins.setEnabled"),
        ...harness.calls("plugins.uninstall"),
      ]).toEqual([]);
      if (surface === "settings") {
        page.surface = "settings";
        page.routeData = harness.route(`/settings/plugins/${plugin.id}`, createResult(plugin));
        await page.updateComplete;
      }
      const action = find("openclaw-plugin-install-action");
      await settlePlugins();
      expect(action?.textContent).toContain("Installing");
      expect(find('[aria-label="Disable Calendar Plus"]')).toBeNull();
      expect(find('[aria-label="Uninstall Calendar Plus"]')).toBeNull();
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
        expect(harness.request).toHaveBeenCalledWith("plugins.setEnabled", {
          pluginId: plugin.id,
          enabled: false,
        });
      } else {
        install.resolve({ ok: true, plugin, restartRequired: false });
      }
      await waitForSolid(() =>
        expect(
          find(`[aria-label="${surface === "failure" ? "Enable" : "Disable"} Calendar Plus"]`),
        ).not.toBeNull(),
      );
      expect(find("openclaw-plugin-install-action")).toBeNull();
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
  const harness = pageFixture({
    "plugins.inspect": () => (++inspections === 1 ? initial : fresh.promise),
    "plugins.list": () => createResult(plugin),
  });
  const { page } = await harness.mount("/settings/plugins/workboard", createResult(plugin));
  await waitForSolid(() => expect(page.textContent).toContain("Known skill"));
  harness.publishPlugins();
  await waitForSolid(() => expect(inspections).toBe(2));
  await page.updateComplete;
  expect(page.textContent).toContain("Known skill");
  fresh.reject(new Error("Inspection unavailable"));
  await waitForSolid(() => expect(page.textContent).toContain("Inspection unavailable"));
  expect(page.textContent).toContain("Known skill");
});
