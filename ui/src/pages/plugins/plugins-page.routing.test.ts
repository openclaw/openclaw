/* @vitest-environment jsdom */

import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ToolsCatalogResult } from "../../api/types.ts";
import { configMocks } from "../../e2e/plugins-settings-admin.test-support.ts";
import { i18n } from "../../i18n/index.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginListResult,
} from "../../lib/plugins/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createClient,
  createContext,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  createRuntimeConfigHarness,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

const SETTINGS_URL = "/settings/plugins/workboard?view=settings";
const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });

function discoveryDetail(
  plugin: PluginCatalogItem & { catalogId: string },
): PluginDiscoveryDetailResult {
  return {
    plugin: {
      id: plugin.catalogId,
      catalog: { name: plugin.name, official: true, categories: ["productivity"] },
      local: {
        present: plugin.installed,
        installed: plugin.installed,
        enabled: plugin.enabled,
        state: plugin.state,
        pluginId: plugin.id,
        action: plugin.installed ? "manage" : "install",
      },
    },
    detail: {
      origin: "clawhub",
      packageName: plugin.id,
      topics: [],
      configuration: [],
      mcpServers: [],
      skills: [],
      versions: [],
    },
  };
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
  const routeData = createPluginsRouteData(
    harness.gateway,
    result,
    createPluginsRouteLocation(url),
  );
  return { context, routeData, ...(await mountPage(context, routeData)) };
}

async function settlePage(page: { updateComplete: Promise<boolean> }) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await page.updateComplete;
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(resetPluginsPageTestState);

it("a chat install link opens uninstalled plugin details without installing", async () => {
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
  const { request, harness } = pageGateway({ "plugins.catalog.get": () => detail });
  const { page, context } = await mountRoute(
    harness,
    inventory,
    "/plugins/ch_d2hhdHNhcHA?action=install",
  );
  await vi.waitFor(() =>
    expect(context.replace).toHaveBeenCalledWith("plugins", {
      pathname: "/plugins/ch_d2hhdHNhcHA",
      search: "",
    }),
  );
  await vi.waitFor(() => expect(page.querySelector("h1")).not.toBeNull());
  expect(page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__install")?.disabled).toBe(
    false,
  );
  expect(page.textContent).not.toContain("Accounts");
  expect(page.textContent).not.toContain("Credentials");
  expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(false);
  expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(false);
});

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
  await vi.waitFor(() =>
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

it("commits the focused numeric field before Escape dismisses settings", async () => {
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
  await vi.waitFor(() => expect(page.querySelector(selector)).not.toBeNull());
  const input = page.querySelector<HTMLInputElement>(selector)!;
  input.focus();
  input.value = "30";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(runtimeConfig.runtimeConfig.patchForm).not.toHaveBeenCalled();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await page.updateComplete;
  expect(page.querySelector(".plugin-editor")).toBeNull();
  expect(runtimeConfig.runtimeConfig.patchForm).toHaveBeenCalledExactlyOnceWith(
    ["plugins", "entries", "workboard", "config", "refreshMinutes"],
    30,
  );
  expect(runtimeConfig.runtimeConfig.flushFormChanges).toHaveBeenCalledOnce();
  expect(context.replace).toHaveBeenCalledWith("plugin-settings", {
    pathname: "/settings/plugins",
  });
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
  const { page } = await mountRoute(
    harness,
    result,
    "/settings/plugins/workboard#configuration",
    runtimeConfig,
  );
  await vi.waitFor(() => expect(catalogs).toBe(1));
  await vi.waitFor(() =>
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
  await vi.waitFor(() => expect(catalogs).toBe(2));
  page.routeData = createPluginsRouteData(
    harness.gateway,
    result,
    createPluginsRouteLocation("/settings/plugins/workboard"),
  );
  await page.updateComplete;
  const rows = () =>
    [...page.querySelectorAll(".plugin-capability__copy strong")].map((row) => row.textContent);
  expect(rows()).toEqual(["Current skill"]);

  catalog.resolve(discoveryDetail(plugin));
  await catalog.promise;
  await settlePage(page);

  expect(rows()).toEqual(["Current skill"]);
  expect(request.mock.calls.filter(([method]) => method === "plugins.inspect")).toHaveLength(2);
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
  await vi.waitFor(() =>
    expect(page.querySelector('[aria-label="Install Calendar"]')).not.toBeNull(),
  );
  page.querySelector<HTMLButtonElement>('[aria-label="Install Calendar"]')!.click();
  await vi.waitFor(() => expect(page.textContent).toContain("Plugin availability changed"));
  expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(false);
  expect(page.querySelector<HTMLButtonElement>('[aria-label="Install Calendar"]')?.disabled).toBe(
    false,
  );
});

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
    await vi.waitFor(() =>
      expect(page.querySelectorAll(".plugin-catalog-card__install")).toHaveLength(2),
    );
    page.querySelector<HTMLButtonElement>('[aria-label="Install Alpha"]')!.click();
    page.querySelector<HTMLButtonElement>('[aria-label="Install Beta"]')!.click();
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "plugins.catalog.get"),
      ).toHaveLength(2),
    );
    betaRead.resolve(beta!);
    await vi.waitFor(() =>
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

    expect(request.mock.calls.filter(([method]) => method === "plugins.install")).toHaveLength(1);
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
    const { page } = await mountRoute(harness, result, "/settings/plugins/workboard");

    await vi.waitFor(() =>
      expect(
        [...page.querySelectorAll(".plugin-capability__static strong")].map((row) =>
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
      expect(page.querySelector(".plugin-catalog-detail__panel .oc-banner-warning")).toBeNull();
      expect(
        page.querySelector<HTMLAnchorElement>(
          '.plugin-catalog-detail__actions a[aria-label="Settings"]',
        )?.href,
      ).toContain("view=settings");
    } else {
      expect(page.querySelector('[aria-label="Connect account"]')).not.toBeNull();
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
    await vi.waitFor(() => expect(page.querySelector(".plugin-metadata__loading")).toBeNull());
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
    await vi.waitFor(() => expect(page.textContent).toContain("Full board search description"));
    expect(page.textContent).toContain("board_create");
  },
);

it("uses a late local inventory while catalog metadata is pending", async () => {
  const plugin = { ...createPlugin(), catalogId: "ch_d29ya2JvYXJk" };
  const result = createResult(plugin);
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
  const { page } = await mountRoute(harness, null, `/plugins/${plugin.catalogId}`);
  await vi.waitFor(() => expect(catalogs).toBe(1));
  local.resolve(result);
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: plugin.id }),
  );
  expect(page.querySelector('[aria-label="Enable Workboard"]')).not.toBeNull();
  expect(page.querySelector(".plugin-catalog-detail__install")).toBeNull();
  remote.resolve(discoveryDetail({ ...plugin, installed: false }));
  await remote.promise;
  await settlePage(page);
  expect(page.querySelector('[aria-label="Enable Workboard"]')).not.toBeNull();
  expect(page.querySelector(".plugin-catalog-detail__install")).toBeNull();
});
