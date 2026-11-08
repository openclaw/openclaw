import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ToolsCatalogResult } from "../../api/types.ts";
import { registerModalSurface } from "../../components/overlay-registry.ts";
import { configMocks } from "../../e2e/plugins-settings-admin.test-support.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginListResult,
} from "../../lib/plugins/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createRouteLoaderOptions } from "../../test-helpers/route-loader-options.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createClient,
  createContext,
  createDiscoveryDetail,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  createRuntimeConfigHarness,
  methodCalls,
  mountPage,
  resetPluginsPageTestState,
  settlePlugins,
} from "./plugins-page.test-support.ts";
import { pages } from "./route.tsx";

const SETTINGS_URL = "/settings/plugins/workboard?view=settings";
const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });

function discoveryDetail(
  plugin: PluginCatalogItem & { catalogId: string },
): PluginDiscoveryDetailResult {
  const result = createDiscoveryDetail(plugin);
  result.plugin.id = plugin.catalogId;
  result.plugin.catalog = { name: plugin.name, official: true, categories: ["productivity"] };
  result.plugin.local.pluginId = plugin.id;
  result.detail.packageName = plugin.id;
  return result;
}

function browseResult(params: unknown, details: PluginDiscoveryDetailResult[]) {
  return {
    items: asNullableRecord(params)?.intent === "all" ? details.map(({ plugin }) => plugin) : [],
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

function pageGateway(
  responses: Record<string, (params: unknown) => unknown>,
  fallback?: () => unknown,
) {
  const { client, request } = createClient(async (method, params) => {
    const response = responses[method] ?? fallback;
    if (!response) {
      throw new Error(`Unexpected method: ${method}`);
    }
    return response(params);
  });
  return { client, request, harness: createGateway(client) };
}

async function mountRoute(
  harness: ReturnType<typeof createGateway>,
  result: PluginListResult | null,
  url: string,
  runtimeConfig?: ReturnType<typeof createRuntimeConfigHarness>,
) {
  const context = createContext(harness.gateway, undefined, undefined, runtimeConfig);
  const data = createPluginsRouteData(harness.gateway, result, createPluginsRouteLocation(url));
  return { context, routeData: data, ...(await mountPage(context, data)) };
}

async function settlePage(page: { updateComplete: Promise<boolean> }) {
  await settlePlugins();
  await page.updateComplete;
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  resetPluginsPageTestState();
  for (const capability of capabilities) {
    capability.dispose();
  }
  capabilities.clear();
});

it.each(["connected", "held", "failed"] as const)(
  "a chat install link opens uninstalled plugin details without installing (inventory=%s)",
  async (inventoryState) => {
    const connected = inventoryState === "connected";
    const pending = deferred<PluginListResult>();
    onTestFinished(() => pending.resolve(createResult([])));
    const detail = discoveryDetail({
      ...createPlugin({
        id: "@openclaw/whatsapp",
        name: "WhatsApp",
        installed: false,
        state: "not-installed",
      }),
      catalogId: "ch_d2hhdHNhcHA",
    });
    detail.plugin.catalog.categories = [];
    delete detail.plugin.local.pluginId;
    const inventory = createResult(
      createPlugin({
        id: "whatsapp",
        catalogId: detail.plugin.id,
        installed: false,
        state: "not-installed",
      }),
    );
    const { client, request, harness } = pageGateway({
      "plugins.list": () => (connected ? inventory : pending.promise),
      "plugins.catalog.get": () => detail,
    });
    if (!connected) {
      harness.emit(client, false);
    }
    const { page, context } = await mountRoute(
      harness,
      connected ? inventory : null,
      "/plugins/ch_d2hhdHNhcHA?action=install",
    );
    if (!connected) {
      expect(request).not.toHaveBeenCalled();
      harness.emit(client, true);
    }
    await waitForSolid(() =>
      expect(context.replace).toHaveBeenCalledWith("plugins", {
        pathname: "/plugins/ch_d2hhdHNhcHA",
        search: "",
      }),
    );
    await waitForSolid(() => expect(page.querySelector("h1")).not.toBeNull());
    if (!connected) {
      expect(
        page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__install")?.disabled,
      ).toBe(true);
      expect(page.textContent).toContain("Loading plugins");
      if (inventoryState === "failed") {
        pending.reject(new Error("Inventory unavailable"));
        await waitForSolid(() => expect(page.textContent).toContain("Inventory unavailable"));
        expect(page.textContent).toContain("WhatsApp");
        expect(
          page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__install")?.disabled,
        ).toBe(true);
      } else {
        pending.resolve(inventory);
      }
    }
    if (inventoryState !== "failed") {
      await waitForSolid(() =>
        expect(
          page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__install")?.disabled,
        ).toBe(false),
      );
    }
    expect(page.textContent).not.toContain("Accounts");
    expect(page.textContent).not.toContain("Credentials");
    expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(false);
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(false);
    expect(methodCalls(request, "plugins.catalog.get")).toHaveLength(1);
  },
);

it.each([true, false])("retries failed configuration recovery (write=%s)", async (write) => {
  const result = createResult();
  const { client, harness } = pageGateway(
    { "plugins.inspect": () => createInspectResult() },
    () => result,
  );
  const refresh = vi.fn(async () => undefined);
  const configState = {
    configFormDirty: write,
    lastError: write ? "Save failed" : "Configuration load failed",
    configForm: write
      ? { plugins: { entries: { workboard: { config: { token: "pending" } } } } }
      : null,
    configUiHints: {},
    configSchema: write
      ? objectSchema({
          plugins: objectSchema({
            entries: {
              type: "object",
              additionalProperties: objectSchema({ config: { type: "object" } }),
            },
          }),
        })
      : null,
  };
  const runtimeConfig = createRuntimeConfigHarness(refresh, configState, () => client);
  const { page } = await mountRoute(harness, result, SETTINGS_URL, runtimeConfig);
  await waitForSolid(() =>
    expect(page.querySelector(".plugin-editor .callout button")).not.toBeNull(),
  );
  const retry = [...page.querySelectorAll<HTMLElement>(".plugin-editor .callout")]
    .find((element) => element.textContent?.includes(configState.lastError))
    ?.querySelector<HTMLButtonElement>("button");
  expect(retry?.textContent?.trim()).toBe("Retry");
  retry?.click();
  expect(runtimeConfig.runtimeConfig.retry).toHaveBeenCalledTimes(write ? 1 : 0);
  expect(runtimeConfig.runtimeConfig.refreshSchema).toHaveBeenCalledTimes(write ? 0 : 1);
  expect(refresh).toHaveBeenCalledTimes(write ? 0 : 1);
});

it("closes menus before Escape commits the focused field and bubbles to the shell", async () => {
  const result = createResult();
  const { harness } = pageGateway({
    "plugins.inspect": () => createInspectResult(),
    "plugins.list": () => result,
  });
  const configState = {
    connected: true,
    configFormDirty: false,
    lastError: null,
    configForm: structuredClone(configMocks["config.get"].config),
    configSchema: configMocks["config.schema"].schema,
    configUiHints: configMocks["config.schema"].uiHints,
  };
  const runtimeConfig = createRuntimeConfigHarness(
    vi.fn(async () => undefined),
    configState,
  );
  const { page, context } = await mountRoute(harness, result, SETTINGS_URL, runtimeConfig);
  const selector = 'input[aria-label="Refresh interval (minutes)"]';
  await waitForSolid(() => expect(page.querySelector(selector)).not.toBeNull());
  const input = page.querySelector<HTMLInputElement>(selector)!;
  const row = input.closest(".plugin-editor__row")!;
  const trigger = row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  const menuItem = row.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')!;
  // JSDOM omits layout scrolling; the real menu still owns focus and Escape.
  for (const item of row.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
    item.scrollIntoView = vi.fn();
  }
  vi.mocked(context.replace).mockClear();
  for (const focus of [menuItem, trigger]) {
    trigger.click();
    await settlePlugins();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(menuItem);
    focus.focus();
    focus.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await settlePlugins();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(page.querySelector(".plugin-editor")).not.toBeNull();
    expect(context.replace).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  }
  input.focus();
  input.value = "30";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(runtimeConfig.runtimeConfig.patchForm).not.toHaveBeenCalled();
  const drawer = document.createElement("div");
  drawer.className = "shell-nav";
  drawer.setAttribute("aria-modal", "true");
  document.body.append(drawer);
  const releaseDrawer = registerModalSurface(drawer);
  try {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(page.querySelector(".plugin-editor")).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(runtimeConfig.runtimeConfig.patchForm).not.toHaveBeenCalled();
    expect(context.replace).not.toHaveBeenCalled();
  } finally {
    releaseDrawer();
    drawer.remove();
  }
  const shellEscape = vi.fn();
  document.addEventListener("keydown", shellEscape);
  onTestFinished(() => document.removeEventListener("keydown", shellEscape));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(shellEscape).toHaveBeenCalledOnce();
  await page.updateComplete;
  expect(page.querySelector(".plugin-editor")).not.toBeNull();
  expect(runtimeConfig.runtimeConfig.patchForm).toHaveBeenCalledExactlyOnceWith(
    ["plugins", "entries", "workboard", "config", "refreshMinutes"],
    30,
  );
  expect(runtimeConfig.runtimeConfig.flushFormChanges).toHaveBeenCalledOnce();
  expect(context.replace).not.toHaveBeenCalled();
});

it("keeps the autosaved inspection when an older optional catalog completes", async () => {
  const plugin = { ...createPlugin(), catalogId: "ch_d29ya2JvYXJk", version: "1.2.3" };
  const result = createResult(plugin);
  const catalog = deferred<PluginDiscoveryDetailResult>();
  let inspections = 0;
  let catalogs = 0;
  const { client, request, harness } = pageGateway({
    "plugins.inspect": () => {
      const inspection = createInspectResult();
      inspection.components.skills = [++inspections === 1 ? "Original skill" : "Current skill"];
      return inspection;
    },
    "plugins.catalog.get": () => {
      if (++catalogs === 1) {
        return catalog.promise;
      }
      throw new Error("Optional catalog unavailable");
    },
    "plugins.list": () => result,
  });
  const configState = {
    connected: true,
    configFormDirty: false,
    lastError: null,
    configAutoSaveStatus: "idle",
    configForm: { plugins: { entries: { workboard: { config: { greeting: "Before" } } } } },
    configUiHints: {},
    configSchema: objectSchema({
      plugins: objectSchema({
        entries: objectSchema({
          workboard: objectSchema({
            config: objectSchema({ greeting: { type: "string", title: "Greeting" } }),
          }),
        }),
      }),
    }),
  };
  const runtimeConfig = createRuntimeConfigHarness(
    vi.fn(async () => undefined),
    configState,
    () => client,
  );
  const { page } = await mountRoute(harness, result, "/settings/plugins", runtimeConfig);
  await waitForSolid(() => expect(page.textContent).toContain("Workboard"));
  page.routeData = createPluginsRouteData(
    harness.gateway,
    result,
    createPluginsRouteLocation("/settings/plugins/workboard#configuration"),
  );
  await waitForSolid(() => expect(catalogs).toBe(1));
  await waitForSolid(() =>
    expect(page.querySelector('.plugin-editor input[aria-label="Greeting"]')).not.toBeNull(),
  );
  const input = page.querySelector<HTMLInputElement>(
    '.plugin-editor input[aria-label="Greeting"]',
  )!;
  input.focus();
  input.value = "After";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(runtimeConfig.runtimeConfig.patchForm).not.toHaveBeenCalled();
  input.blur();
  expect(runtimeConfig.runtimeConfig.flushFormChanges).toHaveBeenCalledOnce();
  expect(runtimeConfig.runtimeConfig.patchForm).toHaveBeenCalledWith(
    ["plugins", "entries", "workboard", "config", "greeting"],
    "After",
  );
  configState.configForm.plugins.entries.workboard.config.greeting = "After";
  configState.configAutoSaveStatus = "saving";
  runtimeConfig.notify();
  configState.configAutoSaveStatus = "saved";
  runtimeConfig.notify();
  await waitForSolid(() => expect(catalogs).toBe(2));
  page.routeData = createPluginsRouteData(
    harness.gateway,
    result,
    createPluginsRouteLocation("/settings/plugins/workboard"),
  );
  await page.updateComplete;
  const rows = () =>
    [...page.querySelectorAll(".plugin-capabilities .settings-row__title")].map(
      (row) => row.textContent,
    );
  expect(rows()).toEqual(["Current skill"]);

  catalog.resolve(discoveryDetail(plugin));
  await settlePage(page);

  expect(rows()).toEqual(["Current skill"]);
  expect(methodCalls(request, "plugins.inspect")).toHaveLength(2);
});

it("keeps the first inspection failure until retry after inventory adoption", async () => {
  const result = createResult();
  let inspections = 0;
  const { request, harness } = pageGateway({
    "plugins.list": () => result,
    "plugins.inspect": () => {
      if (++inspections === 1) {
        throw new Error("Inspection unavailable");
      }
      return createInspectResult();
    },
  });
  const { page } = await mountRoute(harness, result, "/settings/plugins");
  await waitForSolid(() => expect(page.textContent).toContain("Workboard"));
  page.routeData = createPluginsRouteData(
    harness.gateway,
    result,
    createPluginsRouteLocation("/settings/plugins/workboard"),
  );
  await waitForSolid(() => expect(page.textContent).toContain("Inspection unavailable"));
  expect(methodCalls(request, "plugins.inspect")).toHaveLength(1);

  page.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
  await waitForSolid(() =>
    expect(page.querySelector('[aria-label="Enable Workboard"]')).not.toBeNull(),
  );
  expect(page.textContent).not.toContain("Inspection unavailable");
  expect(methodCalls(request, "plugins.inspect")).toHaveLength(2);
});

it("reports when a listed install becomes unavailable", async () => {
  const offered = discoveryDetail({
    ...createPlugin({
      id: "calendar",
      name: "Calendar",
      installed: false,
      state: "not-installed",
    }),
    catalogId: "ch_Y2FsZW5kYXI",
  });
  const current = structuredClone(offered);
  current.plugin.local.action = "unavailable";
  const { request, harness } = pageGateway({
    "plugins.catalog.browse": (params) => browseResult(params, [offered]),
    "plugins.catalog.categories": () => ({ categories: [] }),
    "plugins.catalog.get": () => current,
  });
  const { page } = await mountRoute(harness, createResult(), "/plugins");
  await waitForSolid(() =>
    expect(page.querySelector('[aria-label="Install Calendar"]')).not.toBeNull(),
  );
  page.querySelector<HTMLButtonElement>('[aria-label="Install Calendar"]')!.click();
  await waitForSolid(() => expect(page.textContent).toContain("Plugin availability changed"));
  expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(false);
  expect(page.querySelector<HTMLButtonElement>('[aria-label="Install Calendar"]')?.disabled).toBe(
    false,
  );
});

it.each([
  { outcome: "success", detail: false },
  { outcome: "failure", detail: false },
  { outcome: "failure", detail: true },
  { outcome: "success", detail: "return" },
] as const)(
  "browses while inventory is pending and retains catalog on $outcome (detail=$detail)",
  async ({ outcome, detail }) => {
    const inventory = deferred<PluginListResult>();
    const offered = discoveryDetail({
      ...createPlugin({
        id: "calendar",
        name: "Calendar",
        installed: false,
        state: "not-installed",
      }),
      catalogId: "ch_Y2FsZW5kYXI",
    });
    let inventoryReads = 0;
    const { request, harness } = pageGateway({
      "plugins.list": () =>
        ++inventoryReads <= (detail === "return" ? 2 : 1) ? inventory.promise : createResult([]),
      "plugins.catalog.browse": (params) => browseResult(params, [offered]),
      "plugins.catalog.categories": () => ({ categories: [] }),
      "plugins.catalog.get": () => offered,
    });
    const context = createContext(harness.gateway);
    const loader = pages[0].loader!;
    const routeData = await loader(
      context,
      createRouteLoaderOptions(
        createPluginsRouteLocation(detail ? "/plugins/ch_Y2FsZW5kYXI" : "/plugins"),
      ),
    );
    if ("type" in routeData) {
      throw new Error("Expected the discovery route to load");
    }
    expect(inventoryReads).toBe(0);
    const { page } = await mountPage(context, routeData);
    expect(inventoryReads).toBe(1);
    if (detail === "return") {
      await waitForSolid(() =>
        expect(page.querySelector("#plugin-catalog-detail-title")).not.toBeNull(),
      );
      const hub = await loader(
        context,
        createRouteLoaderOptions(createPluginsRouteLocation("/plugins")),
      );
      if ("type" in hub) {
        throw new Error("Expected the discovery hub to load");
      }
      page.routeData = hub;
    }
    const showingDetail = detail === true;
    const install = () =>
      page.querySelector<HTMLButtonElement>(
        showingDetail ? ".plugin-catalog-detail__install" : '[aria-label="Install Calendar"]',
      );
    await waitForSolid(() => expect(install()).not.toBeNull());
    expect(install()!.disabled).toBe(true);
    expect(page.querySelector('#plugins-hub-panel > [role="status"]')?.textContent).toBe(
      "Loading plugins…",
    );
    const contentSelector = showingDetail
      ? "#plugin-catalog-detail-title"
      : '[data-plugin-id="ch_Y2FsZW5kYXI"]';
    const content = page.querySelector(contentSelector);
    expect(content).not.toBeNull();
    if (!showingDetail) {
      expect(page.querySelector<HTMLInputElement>('[type="search"]')!.disabled).toBe(false);
    }
    if (outcome === "success") {
      inventory.resolve(createResult([]));
      await waitForSolid(() => expect(install()!.disabled).toBe(false));
    } else {
      inventory.reject(new Error("Installed inventory unavailable"));
      await waitForSolid(() =>
        expect(page.textContent).toContain("Installed inventory unavailable"),
      );
      expect(install()!.disabled).toBe(true);
    }
    expect(page.querySelector('#plugins-hub-panel > [role="status"]')).toBeNull();
    expect(page.querySelector(contentSelector)).toBe(content);
    expect(methodCalls(request, "plugins.catalog.browse")).toHaveLength(showingDetail ? 0 : 1);
    expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(false);
    if (outcome === "failure") {
      [...page.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Try again")!
        .click();
      await waitForSolid(() => expect(install()!.disabled).toBe(false));
      expect(inventoryReads).toBe(2);
      expect(page.textContent).not.toContain("Installed inventory unavailable");
    }
  },
);

it.each(["success", "failure", "metadata", "replacement", "reconnect"])(
  "refreshes installed inventory at page adoption with %s",
  async (outcome) => {
    const inventory = deferred<PluginListResult>();
    let reads = 0;
    const { client, request, harness } = pageGateway({
      "plugins.list": () =>
        ++reads === 1 ? inventory.promise : createResult(createPlugin({ name: "Fresh plugin" })),
    });
    const context = createContext(harness.gateway);
    const route = await pages[1].loader!(
      context,
      createRouteLoaderOptions(createPluginsRouteLocation()),
    );
    expect(request).not.toHaveBeenCalled();
    if ("type" in route) {
      throw new Error("Expected the installed Plugins route to load");
    }
    const { page } = await mountPage(context, route);
    expect(reads).toBe(1);
    if (outcome === "metadata") {
      harness.emit(client, true, { hello: harness.gateway.snapshot.hello });
    }
    if (outcome === "replacement") {
      const fresh = createClient(async () => createResult(createPlugin({ name: "Fresh plugin" })));
      harness.emit(fresh.client, true);
    }
    if (outcome === "reconnect") {
      harness.emit(client, false);
      harness.emit(client, true, { hello: gatewayHelloForMethods(["plugins.list"]) });
    }
    if (outcome === "replacement" || outcome === "reconnect") {
      await waitForSolid(() => expect(page.textContent).toContain("Fresh plugin"));
      inventory.resolve(createResult(createPlugin({ name: "Retired plugin" })));
      await inventory.promise;
      await settlePage(page);
      expect(page.textContent).not.toContain("Retired plugin");
    } else {
      expect(page.querySelector('.settings-loading-skeleton[aria-busy="true"]')).not.toBeNull();
      if (outcome === "failure") {
        inventory.reject(new Error("Inventory unavailable"));
        await waitForSolid(() => expect(page.textContent).toContain("Inventory unavailable"));
      } else {
        inventory.resolve(createResult());
        await waitForSolid(() => expect(page.textContent).toContain("Workboard"));
      }
    }
    expect(methodCalls(request, "plugins.list")).toHaveLength(outcome === "reconnect" ? 2 : 1);
  },
);

it.each(["denied", "cancelled"])(
  "does not load Plugins inventory before page adoption when %s",
  async (reason) => {
    const { client, request, harness } = pageGateway({ "plugins.list": () => createResult() });
    if (reason === "denied") {
      harness.emit(client, true, { hello: gatewayHelloForMethods([], ["operator.sessions.read"]) });
    }
    const context = createContext(harness.gateway);
    const route = await pages[1].loader!(context, {
      ...createRouteLoaderOptions(createPluginsRouteLocation()),
      shouldRun: () => reason !== "cancelled",
    });
    if (reason === "denied" && !("type" in route)) {
      await mountPage(context, route);
    }
    expect(request).not.toHaveBeenCalled();
  },
);

it("keeps the latest Install request while an older catalog detail is pending", async () => {
  const details = ["Alpha", "Beta"].map((name) =>
    discoveryDetail({
      ...createPlugin({
        id: name.toLowerCase(),
        name,
        installed: false,
        state: "not-installed",
      }),
      catalogId: name === "Alpha" ? "ch_YWxwaGE" : "ch_YmV0YQ",
    }),
  );
  const [alpha, beta] = details;
  const alphaRead = deferred<PluginDiscoveryDetailResult>();
  const betaRead = deferred<PluginDiscoveryDetailResult>();
  const installation = deferred<unknown>();
  const { request, harness } = pageGateway({
    "plugins.catalog.browse": (params) => browseResult(params, details),
    "plugins.catalog.categories": () => ({ categories: [] }),
    "plugins.catalog.get": (params) =>
      asNullableRecord(params)?.id === alpha!.plugin.id ? alphaRead.promise : betaRead.promise,
    "plugins.install": () => installation.promise,
    "plugins.list": () => createResult(),
  });
  const { page } = await mountRoute(harness, createResult(), "/plugins");
  try {
    await waitForSolid(() =>
      expect(page.querySelectorAll(".plugin-catalog-card__install")).toHaveLength(2),
    );
    page.querySelector<HTMLButtonElement>('[aria-label="Install Alpha"]')!.click();
    page.querySelector<HTMLButtonElement>('[aria-label="Install Beta"]')!.click();
    await waitForSolid(() => expect(methodCalls(request, "plugins.catalog.get")).toHaveLength(2));
    betaRead.resolve(beta!);
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith(
        "plugins.install",
        {
          source: "clawhub",
          packageName: "beta",
        },
        expect.objectContaining({ onSent: expect.any(Function) }),
      ),
    );
    alphaRead.resolve(alpha!);
    await alphaRead.promise;
    await settlePage(page);

    expect(methodCalls(request, "plugins.install")).toHaveLength(1);
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
  } finally {
    alphaRead.resolve(alpha!);
    betaRead.resolve(beta!);
    installation.resolve({
      ok: true,
      plugin: createPlugin({ id: "beta", name: "Beta", enabled: true, state: "enabled" }),
      restartRequired: false,
    });
    await settlePage(page);
  }
});

it.each(["disabled", "needs-setup"] as const)(
  "renders %s local settings controls while optional metadata settles",
  async (state) => {
    const plugin = {
      ...createPlugin({
        clawhubPackage: "@openclaw/workboard",
        version: "1.2.3",
        state,
      }),
      catalogId: "ch_QG9wZW5jbGF3L3dvcmtib2FyZA",
    };
    const result = createResult(plugin);
    const catalog = discoveryDetail(plugin);
    catalog.plugin.catalog.packageName = catalog.detail.packageName = "@openclaw/workboard";
    catalog.plugin.catalog.categories = ["tools"];
    const tools = deferred<ToolsCatalogResult>();
    const catalogPending = deferred<PluginDiscoveryDetailResult>();
    const { client, request, harness } = pageGateway(
      {
        "plugins.inspect": () => {
          const inspection = createInspectResult();
          inspection.declared.tools = ["board_create"];
          if (state === "disabled") {
            inspection.mcpAuth = [{ serverName: "account", state: "unauthenticated" }];
            inspection.credentials = [
              {
                path: ["plugins", "entries", "workboard", "config", "apiKey"],
                label: "API key",
                envVars: ["SERVICE_KEY"],
                status: "missing",
              },
            ];
          }
          return inspection;
        },
        "tools.catalog": () => tools.promise,
        "plugins.catalog.get": () => catalogPending.promise,
      },
      () => result,
    );
    harness.emit(client, true, {
      hello: gatewayHelloForMethods(["plugins.inspect", "plugins.setEnabled", "tools.catalog"]),
    });
    const { page, context } = await mountRoute(
      harness,
      result,
      "/settings/plugins/workboard?from=plugins",
    );

    await waitForSolid(() =>
      expect(
        [...page.querySelectorAll(".plugin-capabilities .settings-row__title")].map((row) =>
          row.textContent?.trim(),
        ),
      ).toContain("board_create"),
    );
    expect(page.querySelector("h1")?.textContent).toContain("Workboard");
    const enable = page.querySelector('[aria-label="Enable Workboard"]');
    expect(enable).not.toBeNull();
    expect(enable?.getAttribute("aria-disabled")).toBe(state === "needs-setup" ? "true" : null);
    if (state === "needs-setup") {
      expect(page.querySelector(".plugins-settings-detail-setup")).toBeNull();
      expect(page.querySelector('[role="tablist"]')).toBeNull();
      expect(page.querySelector(".plugins-row-message--warning")).toBeNull();
      expect(
        page.querySelector<HTMLAnchorElement>(
          '.plugin-catalog-detail__actions a[aria-label="Settings"]',
        )?.href,
      ).toContain("view=settings");
    } else {
      expect(page.querySelector('[aria-label="Sign in to account"]')).not.toBeNull();
      expect(page.textContent).toContain("Credentials");
    }
    expect(page.querySelector(".plugin-catalog-detail__sidebar")?.textContent).toContain("1.2.3");
    expect(page.querySelector(".plugin-metadata__loading[role=status]")).not.toBeNull();
    expect(request).toHaveBeenCalledWith(
      "plugins.catalog.get",
      {
        id: plugin.catalogId,
        version: "1.2.3",
      },
      undefined,
    );

    catalogPending.resolve(catalog);
    await waitForSolid(() => expect(page.querySelector(".plugin-metadata__loading")).toBeNull());
    expect(page.querySelector(".plugin-metadata__categories .chip")?.textContent).toBe("tools");
    expect(page.querySelector(".plugin-catalog-detail__sidebar")?.textContent).toContain("1.2.3");
    tools.resolve({
      agentId: "main",
      profiles: [],
      groups: [
        {
          id: "plugin:workboard",
          label: "Workboard",
          source: "plugin",
          pluginId: plugin.id,
          tools: [
            {
              id: "board_search",
              label: "Search board",
              description: "Summary",
              fullDescription: "Full board search description",
              source: "plugin",
              pluginId: plugin.id,
              defaultProfiles: [],
            },
          ],
        },
      ],
    });
    await waitForSolid(() => expect(page.textContent).toContain("Full board search description"));
    expect(page.textContent).toContain("board_create");
    if (state === "disabled") {
      const breadcrumb = page.querySelector<HTMLAnchorElement>(
        ".plugins-settings-breadcrumb__parent",
      );
      expect(breadcrumb?.textContent).toBe("Plugins");
      expect(breadcrumb?.getAttribute("href")).toBe("/plugins");
      breadcrumb?.click();
      expect(context.navigate).toHaveBeenCalledWith("plugins", { pathname: "/plugins" });
    }
  },
);

it.each(["installed", "removed"] as const)(
  "uses a late %s local inventory while catalog metadata is pending",
  async (outcome) => {
    const plugin = { ...createPlugin(), catalogId: "ch_d29ya2JvYXJk" };
    const result = createResult(outcome === "installed" ? plugin : []);
    const local = deferred<typeof result>();
    const remote = deferred<PluginDiscoveryDetailResult>();
    let catalogs = 0;
    const { request, harness } = pageGateway({
      "plugins.list": () => local.promise,
      "plugins.inspect": () => createInspectResult(),
      "plugins.catalog.get": () => {
        if (++catalogs === 1) {
          return remote.promise;
        }
        throw new Error("ClawHub unavailable");
      },
    });
    const { page, context } = await mountRoute(harness, null, `/plugins/${plugin.catalogId}`);
    await waitForSolid(() => expect(catalogs).toBe(1));
    local.resolve(result);
    await settlePage(page);
    if (outcome === "installed") {
      expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: plugin.id });
      await waitForSolid(() =>
        expect(page.querySelector('[aria-label="Enable Workboard"]')).not.toBeNull(),
      );
    }
    remote.resolve(discoveryDetail({ ...plugin, installed: outcome === "removed" }));
    await remote.promise;
    await settlePage(page);
    if (outcome === "removed") {
      expect(context.replace).toHaveBeenCalledWith("plugins", { pathname: "/plugins" });
      expect(request).not.toHaveBeenCalledWith("plugins.inspect", { pluginId: plugin.id });
      expect(page.querySelector(".plugin-catalog-detail")).toBeNull();
    } else {
      expect(page.querySelector('[aria-label="Enable Workboard"]')).not.toBeNull();
    }
    expect(page.querySelector(".plugin-catalog-detail__install")).toBeNull();
  },
);

const hello = gatewayHelloForMethods([
  "config.get",
  "config.schema",
  "plugins.list",
  "plugins.inspect",
]);
const capabilities = new Set<ReturnType<typeof createRuntimeConfigCapability>>();

it.each([
  ["/settings/plugins", false],
  ["/settings/plugins/workboard", false],
  ["/settings/plugins?tab=advanced", true],
  ["/settings/plugins/workboard?view=settings", true],
  ["/settings/plugins/workboard#configuration", true],
] as const)(
  "loads schema after adopting configuration surfaces at %s",
  async (url, schemaNeeded) => {
    const { harness } = pageGateway({
      "plugins.list": () => createResult(),
      "plugins.inspect": () => createInspectResult(),
    });
    const context = createContext(harness.gateway);
    const loader = pages[1].loader;
    if (!loader) {
      throw new Error("Plugin Settings route has no loader");
    }

    const route = await loader(context, createRouteLoaderOptions(createPluginsRouteLocation(url)));
    if ("type" in route) {
      throw new Error("Expected the Plugin Settings route to load");
    }
    expect(context.runtimeConfig.ensureLoaded).toHaveBeenCalledOnce();
    expect(context.runtimeConfig.ensureSchemaLoaded).not.toHaveBeenCalled();
    await mountPage(context, route);
    expect(context.runtimeConfig.ensureSchemaLoaded).toHaveBeenCalledTimes(schemaNeeded ? 1 : 0);
  },
);

async function mountSettings(options: {
  connected: boolean;
  location?: string;
  schema?: () => Promise<unknown>;
}) {
  const inventory = createResult();
  const { client, request } = createClient(async (method) => {
    switch (method) {
      case "config.get":
        return configMocks["config.get"];
      case "config.schema":
        return options.schema ? options.schema() : configMocks["config.schema"];
      case "plugins.list":
        return inventory;
      case "plugins.inspect":
        return createInspectResult();
      default:
        throw new Error(`Unexpected method: ${method}`);
    }
  });
  const gateway = createGateway(client, options.connected);
  gateway.emit(client, options.connected, { hello });
  const runtimeConfig = createRuntimeConfigCapability(gateway.gateway);
  capabilities.add(runtimeConfig);
  const schemaLoads = vi.spyOn(runtimeConfig, "ensureSchemaLoaded");
  const { page } = await mountPage(
    { ...createContext(gateway.gateway), runtimeConfig },
    createPluginsRouteData(
      gateway.gateway,
      options.connected ? inventory : null,
      createPluginsRouteLocation(options.location ?? "/settings/plugins?tab=advanced"),
    ),
  );
  return {
    page,
    request,
    runtimeConfig,
    connect: () => gateway.emit(client, true, { hello }),
    async navigate(location: string) {
      page.routeData = createPluginsRouteData(
        gateway.gateway,
        inventory,
        createPluginsRouteLocation(location),
      );
      await page.updateComplete;
    },
    async settle() {
      await runtimeConfig.ensureLoaded();
      await Promise.all(schemaLoads.mock.results.map((result) => result.value));
      await page.updateComplete;
    },
  };
}

it.each([
  ["inventory", "/settings/plugins", "/settings/plugins?tab=advanced"],
  ["overview", "/settings/plugins/workboard", SETTINGS_URL],
] as const)(
  "keeps %s schema-free after connecting until configuration opens",
  async (_, start, next) => {
    const harness = await mountSettings({ connected: false, location: start });
    await harness.settle();
    harness.connect();
    await harness.settle();
    await waitForSolid(() => expect(harness.page.textContent).toContain("Workboard"));
    expect(harness.request.mock.calls.some(([method]) => method === "config.schema")).toBe(false);

    await harness.navigate(next);
    await harness.settle();

    await waitForSolid(() =>
      expect(
        harness.page.querySelector("[data-setting], #plugin-settings-advanced input"),
      ).not.toBeNull(),
    );
    expect(methodCalls(harness.request, "config.schema")).toHaveLength(1);
  },
);

async function expectAdvancedFields(page: HTMLElement) {
  await waitForSolid(() => {
    const advanced = page.querySelector("#plugin-settings-advanced");
    expect(advanced?.textContent).toContain("Plugin system enabled");
    expect(advanced?.textContent).toContain("Allowed plugin IDs");
    expect(advanced?.textContent).toContain("Blocked plugin IDs");
    expect(advanced?.textContent).not.toContain("Plugin settings schema is unavailable");
  });
}

it("renders global plugin settings when the Gateway connects after the page mounts", async () => {
  const harness = await mountSettings({ connected: false });
  await harness.settle();
  expect(harness.request).not.toHaveBeenCalledWith("config.schema", {});

  harness.connect();
  await harness.settle();

  await expectAdvancedFields(harness.page);
  expect(methodCalls(harness.request, "config.schema")).toHaveLength(1);
});

it.each(["Reload", "Retry"])("recovers a failed schema read through %s", async (action) => {
  const first = deferred<(typeof configMocks)["config.schema"]>();
  const retry = deferred<(typeof configMocks)["config.schema"]>();
  let attempts = 0;
  const harness = await mountSettings({
    connected: true,
    schema: () => (++attempts === 1 ? first.promise : retry.promise),
  });
  await harness.runtimeConfig.ensureLoaded();
  first.reject(new Error("Schema temporarily unavailable"));
  await harness.settle();
  const alert = () => harness.page.querySelector('[role="alert"]');
  expect(alert()?.textContent).toContain("Schema temporarily unavailable");
  const reload = harness.page.querySelector<HTMLButtonElement>('[aria-label="Reload"]');
  const reloads = vi.spyOn(harness.runtimeConfig, "discardDraft");
  const trigger =
    action === "Reload" ? reload : alert()?.querySelector<HTMLButtonElement>("button");
  expect(trigger).not.toBeNull();
  trigger?.click();
  await waitForSolid(() => {
    expect(attempts).toBe(2);
    if (action === "Retry") {
      expect(alert()).toBeNull();
      expect(reload?.disabled).toBe(true);
    }
  });
  retry.resolve(configMocks["config.schema"]);
  await Promise.all(reloads.mock.results.map((result) => result.value));
  await harness.settle();
  await expectAdvancedFields(harness.page);
  expect(attempts).toBe(2);
  expect(harness.request.mock.calls.some(([method]) => method === "config.set")).toBe(false);
});
