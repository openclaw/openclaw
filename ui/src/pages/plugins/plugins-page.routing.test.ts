/* @vitest-environment jsdom */

import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ToolsCatalogResult } from "../../api/types.ts";
import { configMocks } from "../../e2e/plugins-settings-admin.test-support.ts";
import { i18n } from "../../i18n/index.ts";
import type { PluginCatalogItem, PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
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
import type { PluginsRouteData } from "./route-data.ts";

function discoveryDetail(
  plugin: PluginCatalogItem & { catalogId: string },
): PluginDiscoveryDetailResult {
  return {
    plugin: {
      id: plugin.catalogId,
      catalog: { name: plugin.name, official: true, categories: [] },
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

function clickHubTab(page: HTMLElement, tab: "plugins" | "skills" | "skill-workshop") {
  page
    .querySelector(`#plugins-tab-${tab}`)
    ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
}

async function switchToSettingsSurface(
  page: HTMLElement & {
    surface: "discovery" | "settings";
    routeData?: PluginsRouteData;
    updateComplete: Promise<boolean>;
  },
  routeData: PluginsRouteData,
) {
  page.surface = "settings";
  page.routeData = { ...routeData };
  await page.updateComplete;
}

describe("PluginsPage routing", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(resetPluginsPageTestState);

  it.each([false, true])(
    "a chat install link opens details without installing (installed=%s)",
    async (installed) => {
      const detail = {
        plugin: {
          id: "ch_d2hhdHNhcHA",
          catalog: { name: "WhatsApp", official: true, categories: [] },
          local: {
            present: installed,
            installed,
            enabled: false,
            state: installed ? "disabled" : "not-installed",
            action: installed ? "manage" : "install",
          },
        },
        detail: {
          origin: "clawhub",
          packageName: "@openclaw/whatsapp",
          topics: [],
          configuration: [],
          mcpServers: [],
          skills: [],
          versions: [],
        },
      };
      const inventory = createResult(
        createPlugin({
          id: "whatsapp",
          catalogId: detail.plugin.id,
          installed,
        }),
      );
      const { client, request } = createClient(async (method) =>
        method === "plugins.catalog.get"
          ? detail
          : method === "plugins.inspect"
            ? createInspectResult()
            : inventory,
      );
      const harness = createGateway(client);
      const context = createContext(harness.gateway);
      const routeData = createPluginsRouteData(
        harness.gateway,
        inventory,
        createPluginsRouteLocation("/plugins/ch_d2hhdHNhcHA?action=install"),
      );
      const { page } = await mountPage(context, routeData);
      await vi.waitFor(() =>
        expect(context.replace).toHaveBeenCalledWith("plugins", {
          pathname: "/plugins/ch_d2hhdHNhcHA",
          search: "",
        }),
      );
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(false);
    },
  );

  it("switches between Plugins, Skills, and Skill workshop without reviving catalog tabs", async () => {
    const { client } = createClient(async (method) => {
      if (method === "plugins.catalog.categories") {
        return { categories: [] };
      }
      return method === "plugins.catalog.browse" ? { items: [] } : createResult();
    });
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      createResult(),
      createPluginsRouteLocation("/plugins"),
    );
    const { page } = await mountPage(context, routeData);

    expect(page.querySelector("#plugins-tab-plugins")).not.toBeNull();
    expect(page.querySelector("#plugins-tab-skills")).not.toBeNull();
    expect(page.querySelector("#plugins-tab-installed")).toBeNull();
    expect(page.querySelector("#plugins-tab-discover")).toBeNull();
    expect(page.querySelector("openclaw-plugin-manager")).toBeNull();

    clickHubTab(page, "plugins");
    expect(context.navigate).not.toHaveBeenCalled();
    clickHubTab(page, "skills");
    expect(context.navigate).toHaveBeenCalledWith("skills");
    clickHubTab(page, "skill-workshop");
    expect(context.navigate).toHaveBeenCalledWith("skill-workshop");
  });

  it("retries a failed configuration write without discarding the pending draft", async () => {
    const result = createResult();
    const { client } = createClient(async (method) =>
      method === "plugins.inspect" ? createInspectResult() : result,
    );
    const harness = createGateway(client);
    const refresh = vi.fn(async () => undefined);
    const runtimeConfig = createRuntimeConfigHarness(
      refresh,
      {
        configFormDirty: true,
        lastError: "Save failed",
        configForm: { plugins: { entries: { workboard: { config: { token: "pending" } } } } },
        configUiHints: {},
        configSchema: {
          type: "object",
          properties: {
            plugins: {
              type: "object",
              properties: {
                entries: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: { config: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      } as never,
      () => client,
    );
    const context = createContext(harness.gateway, refresh, undefined, runtimeConfig);
    const routeData = createPluginsRouteData(
      harness.gateway,
      result,
      createPluginsRouteLocation("/settings/plugins/workboard?view=settings"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    await vi.waitFor(() =>
      expect(page.querySelector(".plugin-editor .callout button")).not.toBeNull(),
    );
    const retry = Array.from(page.querySelectorAll<HTMLElement>(".plugin-editor .callout"))
      .find((element) => element.textContent?.includes("Save failed"))
      ?.querySelector<HTMLButtonElement>("button");
    expect(retry?.textContent?.trim()).toBe("Retry");
    retry?.click();

    expect(runtimeConfig.runtimeConfig.retry).toHaveBeenCalledOnce();
    expect(runtimeConfig.runtimeConfig.refreshSchema).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("retries missing configuration reads without dispatching a write", async () => {
    const result = createResult();
    const { client } = createClient(async (method) =>
      method === "plugins.inspect" ? createInspectResult() : result,
    );
    const harness = createGateway(client);
    const refresh = vi.fn(async () => undefined);
    const runtimeConfig = createRuntimeConfigHarness(
      refresh,
      {
        configFormDirty: false,
        lastError: "Configuration load failed",
        configForm: null,
      } as never,
      () => client,
    );
    const context = createContext(harness.gateway, refresh, undefined, runtimeConfig);
    const routeData = createPluginsRouteData(
      harness.gateway,
      result,
      createPluginsRouteLocation("/settings/plugins/workboard?view=settings"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    await vi.waitFor(() =>
      expect(page.querySelector(".plugin-editor .callout button")).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>(".plugin-editor .callout button")?.click();

    expect(refresh).toHaveBeenCalledOnce();
    expect(runtimeConfig.runtimeConfig.refreshSchema).toHaveBeenCalledOnce();
    expect(runtimeConfig.runtimeConfig.retry).not.toHaveBeenCalled();
  });

  it("refreshes the selected inspection after configuration autosave", async () => {
    const result = createResult();
    let inspectionCount = 0;
    const nextInspection = deferred<ReturnType<typeof createInspectResult>>();
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.inspect") {
        inspectionCount += 1;
        return inspectionCount === 1
          ? createInspectResult({ reviewToken: "review-token-1" })
          : nextInspection.promise;
      }
      return result;
    });
    const harness = createGateway(client);
    const runtimeConfig = createRuntimeConfigHarness(
      vi.fn(async () => undefined),
      {
        configFormDirty: true,
        lastError: null,
        configAutoSaveStatus: "saving",
      } as never,
      () => client,
    );
    const context = createContext(harness.gateway, undefined, undefined, runtimeConfig);
    const routeData = createPluginsRouteData(
      harness.gateway,
      result,
      createPluginsRouteLocation("/settings/plugins/workboard"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);
    await vi.waitFor(() => expect(page.detail?.inspection?.reviewToken).toBe("review-token-1"));

    page.pluginConfigEditPending = true;
    (
      runtimeConfig.runtimeConfig.state as never as { configAutoSaveStatus: string }
    ).configAutoSaveStatus = "saved";
    runtimeConfig.notify();

    await vi.waitFor(() => expect(inspectionCount).toBe(2));
    expect(page.detail?.inspection?.reviewToken).toBe("review-token-1");
    nextInspection.resolve(createInspectResult({ reviewToken: "review-token-2" }));
    await vi.waitFor(() => expect(page.detail?.inspection?.reviewToken).toBe("review-token-2"));
    expect(request.mock.calls.filter(([method]) => method === "plugins.inspect")).toHaveLength(2);
  });

  it("keeps the installed detail mounted during a background catalog refresh", async () => {
    const result = createResult();
    const nextCatalog = deferred<typeof result>();
    const { client } = createClient(async (method) => {
      if (method === "plugins.inspect") {
        return createInspectResult();
      }
      if (method === "plugins.list") {
        return nextCatalog.promise;
      }
      return result;
    });
    const harness = createGateway(client);
    const routeData = createPluginsRouteData(
      harness.gateway,
      result,
      createPluginsRouteLocation("/settings/plugins/workboard"),
    );
    const { page } = await mountPage(createContext(harness.gateway), routeData);
    await switchToSettingsSurface(page, routeData);
    await vi.waitFor(() => expect(page.querySelector("h1")?.textContent).toContain("Workboard"));

    const refresh = page.refreshCatalog();
    await vi.waitFor(() => expect(page.loading).toBe(true));
    expect(page.querySelector("h1")?.textContent).toContain("Workboard");

    nextCatalog.resolve(result);
    await refresh;
  });

  it.each([
    {
      label: "Workspace label",
      key: "workspaceLabel",
      text: "Revised planning",
      value: "Revised planning",
    },
    { label: "Refresh interval (minutes)", key: "refreshMinutes", text: "30", value: 30 },
  ])(
    "commits the focused $label before Escape dismisses settings",
    async ({ label, key, text, value }) => {
      const result = createResult();
      const { client } = createClient(async (method) => {
        if (method === "plugins.inspect") {
          return createInspectResult();
        }
        if (method === "plugins.list") {
          return result;
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const harness = createGateway(client);
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
      const context = createContext(harness.gateway, undefined, undefined, runtimeConfig);
      const { page } = await mountPage(
        context,
        createPluginsRouteData(
          harness.gateway,
          result,
          createPluginsRouteLocation("/settings/plugins/workboard?view=settings"),
        ),
      );
      await vi.waitFor(() =>
        expect(page.querySelector(`input[aria-label="${label}"]`)).not.toBeNull(),
      );
      const input = page.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      input.focus();
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(runtimeConfig.runtimeConfig.patchForm).not.toHaveBeenCalled();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await page.updateComplete;
      expect(page.querySelector(".plugin-editor")).toBeNull();
      expect(runtimeConfig.runtimeConfig.patchForm).toHaveBeenCalledExactlyOnceWith(
        ["plugins", "entries", "workboard", "config", key],
        value,
      );
      expect(runtimeConfig.runtimeConfig.flushFormChanges).toHaveBeenCalledOnce();
      expect(context.replace).toHaveBeenCalledWith("plugin-settings", {
        pathname: "/settings/plugins",
      });
    },
  );

  it("keeps the autosaved inspection when an older optional catalog completes", async () => {
    const plugin = { ...createPlugin(), catalogId: "ch_d29ya2JvYXJk", version: "1.2.3" };
    const result = createResult(plugin);
    const catalog = deferred<PluginDiscoveryDetailResult>();
    let inspections = 0;
    let catalogs = 0;
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.inspect") {
        const inspection = createInspectResult();
        return {
          ...inspection,
          components: {
            ...inspection.components,
            skills: [++inspections === 1 ? "Original skill" : "Current skill"],
          },
        };
      }
      if (method === "plugins.catalog.get") {
        if (++catalogs === 1) {
          return catalog.promise;
        }
        throw new Error("Optional catalog unavailable");
      }
      if (method === "plugins.list") {
        return result;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const harness = createGateway(client);
    const configState = {
      connected: true,
      configFormDirty: false,
      lastError: null,
      configAutoSaveStatus: "idle",
      configForm: { plugins: { entries: { workboard: { config: { greeting: "Before" } } } } },
      configUiHints: {},
      configSchema: {
        type: "object",
        properties: {
          plugins: {
            type: "object",
            properties: {
              entries: {
                type: "object",
                properties: {
                  workboard: {
                    type: "object",
                    properties: {
                      config: {
                        type: "object",
                        properties: { greeting: { type: "string", title: "Greeting" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const runtimeConfig = createRuntimeConfigHarness(
      vi.fn(async () => undefined),
      configState,
      () => client,
    );
    const { page } = await mountPage(
      createContext(harness.gateway, undefined, undefined, runtimeConfig),
      createPluginsRouteData(
        harness.gateway,
        result,
        createPluginsRouteLocation("/settings/plugins/workboard#configuration"),
      ),
    );
    await vi.waitFor(() => expect(catalogs).toBe(1));
    await vi.waitFor(() =>
      expect(page.querySelector('.plugin-editor input[aria-label="Greeting"]')).not.toBeNull(),
    );
    const input = page.querySelector<HTMLInputElement>(
      '.plugin-editor input[aria-label="Greeting"]',
    );
    expect(input).not.toBeNull();
    input!.focus();
    input!.value = "After";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(runtimeConfig.runtimeConfig.patchForm).not.toHaveBeenCalled();
    input!.blur();
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
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await page.updateComplete;

    expect(rows()).toEqual(["Current skill"]);
    expect(request.mock.calls.filter(([method]) => method === "plugins.inspect")).toHaveLength(2);
  });

  it.each(["installed", "unavailable"])(
    "reports when a listed install becomes %s",
    async (change) => {
      const offered = discoveryDetail({
        ...createPlugin({
          id: "calendar",
          name: "Calendar",
          installed: false,
          state: "not-installed",
        }),
        catalogId: "ch_Y2FsZW5kYXI",
      });
      const current = {
        ...offered,
        plugin: {
          ...offered.plugin,
          local: {
            ...offered.plugin.local,
            installed: change === "installed",
            action: change === "installed" ? ("manage" as const) : ("unavailable" as const),
          },
        },
      };
      const { client, request } = createClient(async (method, params) => {
        if (method === "plugins.catalog.browse") {
          return { items: asNullableRecord(params)?.intent === "all" ? [offered.plugin] : [] };
        }
        if (method === "plugins.catalog.categories") {
          return { categories: [] };
        }
        if (method === "plugins.catalog.get") {
          return current;
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const harness = createGateway(client);
      const { page } = await mountPage(
        createContext(harness.gateway),
        createPluginsRouteData(
          harness.gateway,
          createResult(),
          createPluginsRouteLocation("/plugins"),
        ),
      );
      await vi.waitFor(() =>
        expect(page.querySelector('[aria-label="Install Calendar"]')).not.toBeNull(),
      );
      page.querySelector<HTMLButtonElement>('[aria-label="Install Calendar"]')!.click();
      await vi.waitFor(() => expect(page.textContent).toContain("Plugin availability changed"));
      expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(false);
      expect(
        page.querySelector<HTMLButtonElement>('[aria-label="Install Calendar"]')?.disabled,
      ).toBe(false);
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
    const { client, request } = createClient(async (method, params) => {
      if (method === "plugins.catalog.browse") {
        return {
          items:
            asNullableRecord(params)?.intent === "all"
              ? details.map((detail) => detail.plugin)
              : [],
        };
      }
      if (method === "plugins.catalog.categories") {
        return { categories: [] };
      }
      if (method === "plugins.catalog.get") {
        return asNullableRecord(params)?.id === alpha!.plugin.id
          ? alphaRead.promise
          : betaRead.promise;
      }
      if (method === "plugins.install") {
        return installation.promise;
      }
      if (method === "plugins.list") {
        return createResult();
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(
        harness.gateway,
        createResult(),
        createPluginsRouteLocation("/plugins"),
      ),
    );
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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await page.updateComplete;

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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await page.updateComplete;
    }
  });

  it.each(
    ["/settings/plugins/workboard", "/plugins/ch_QG9wZW5jbGF3L3dvcmtib2FyZA"].flatMap((route) =>
      [false, true].map((remoteFails) => ({ route, remoteFails })),
    ),
  )(
    "renders local controls at $route while optional metadata settles (failure: $remoteFails)",
    async ({ route, remoteFails }) => {
      const plugin = createPlugin({
        catalogId: "ch_QG9wZW5jbGF3L3dvcmtib2FyZA",
        clawhubPackage: "@openclaw/workboard",
        version: "1.2.3",
      });
      const result = createResult(plugin);
      const catalog = {
        plugin: {
          id: plugin.catalogId,
          catalog: {
            name: "Workboard",
            packageName: "@openclaw/workboard",
            official: true,
            categories: ["tools"],
          },
          local: {
            present: true,
            installed: true,
            enabled: false,
            state: "disabled" as const,
            pluginId: plugin.id,
            action: "manage" as const,
          },
        },
        detail: {
          origin: "clawhub" as const,
          packageName: "@openclaw/workboard",
          topics: [],
          configuration: [],
          mcpServers: [],
          skills: [],
          versions: [],
        },
      };
      const tools = deferred<ToolsCatalogResult>();
      let resolveCatalog!: (value: typeof catalog) => void;
      let rejectCatalog!: (error: Error) => void;
      const catalogPending = new Promise<typeof catalog>((resolve, reject) => {
        resolveCatalog = resolve;
        rejectCatalog = reject;
      });
      const { client, request } = createClient(async (method) => {
        if (method === "plugins.inspect") {
          const inspection = createInspectResult();
          inspection.declared.tools = ["board_create"];
          return inspection;
        }
        if (method === "tools.catalog") {
          return tools.promise;
        }
        if (method === "plugins.catalog.get") {
          return catalogPending;
        }
        return result;
      });
      const harness = createGateway(client);
      harness.emit(client, true, {
        hello: gatewayHelloForMethods(["plugins.inspect", "plugins.setEnabled", "tools.catalog"]),
      });
      const context = createContext(harness.gateway);
      const routeData = createPluginsRouteData(
        harness.gateway,
        result,
        createPluginsRouteLocation(route),
      );
      const { page } = await mountPage(context, routeData);
      if (route.startsWith("/settings/")) {
        await switchToSettingsSurface(page, routeData);
      }

      await vi.waitFor(() => expect(page.querySelector("h1")?.textContent).toContain("Workboard"));
      expect(page.querySelector('[aria-label="Enable Workboard"]')).not.toBeNull();
      expect(page.querySelector(".plugin-catalog-detail__sidebar")?.textContent).toContain("1.2.3");
      expect(page.querySelector(".plugin-metadata__loading[role=status]")).not.toBeNull();
      expect(page.querySelector(".plugin-capability__static")?.textContent).toContain(
        "board_create",
      );
      expect(request).toHaveBeenCalledWith(
        "plugins.catalog.get",
        {
          id: plugin.catalogId,
          version: "1.2.3",
        },
        undefined,
      );

      if (remoteFails) {
        rejectCatalog(new Error("Catalog unavailable"));
      } else {
        resolveCatalog(catalog);
      }
      await vi.waitFor(() => expect(page.querySelector(".plugin-metadata__loading")).toBeNull());
      expect(page.querySelector(".plugin-metadata__categories .chip")?.textContent).toBe(
        remoteFails ? undefined : "tools",
      );
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

  it.each([false, true])(
    "clears installed controls on another catalog route (stale snapshot: %s)",
    async (staleSnapshot) => {
      const plugin = createPlugin({ catalogId: "ch_d29ya2JvYXJk" });
      const result = createResult(plugin);
      const { client, request } = createClient(async (method) => {
        if (method === "plugins.inspect") {
          return createInspectResult();
        }
        if (method === "plugins.catalog.get") {
          throw new Error("ClawHub unavailable");
        }
        return result;
      });
      const harness = createGateway(client);
      const context = createContext(harness.gateway);
      const route = `/plugins/${plugin.catalogId}`;
      const { page } = await mountPage(
        context,
        createPluginsRouteData(harness.gateway, result, createPluginsRouteLocation(route)),
      );
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("plugins.inspect", {
          pluginId: plugin.id,
        }),
      );
      expect(page.querySelector('[aria-label="Enable Workboard"]')).not.toBeNull();
      expect(context.replace).not.toHaveBeenCalled();
      expect(context.navigate).not.toHaveBeenCalled();
      const nextRoute = createPluginsRouteData(
        harness.gateway,
        result,
        createPluginsRouteLocation("/plugins/ch_b3RoZXI"),
      );
      if (staleSnapshot) {
        harness.emit(client, false);
        harness.emit(client, true, {
          hello: gatewayHelloForMethods(["plugins.list", "plugins.inspect"]),
        });
        await vi.waitFor(() => expect(page.loading).toBe(false));
        await vi.waitFor(() =>
          expect(page.querySelector('[aria-label="Enable Workboard"]')).not.toBeNull(),
        );
      }
      page.routeData = nextRoute;
      await page.updateComplete;
      await vi.waitFor(() => expect(page.textContent).toContain("ClawHub unavailable"));
      expect(page.querySelector('[aria-label="Enable Workboard"]')).toBeNull();
    },
  );

  it.each([
    ["failed", "task"],
    ["pending", "task"],
    ["failed", "route"],
    ["pending", "route"],
  ])(
    "uses a late local inventory while catalog metadata is %s via %s",
    async (remoteState, producer) => {
      const plugin = { ...createPlugin(), catalogId: "ch_d29ya2JvYXJk" };
      const result = createResult(plugin);
      const local = deferred<typeof result>();
      const remote = deferred<PluginDiscoveryDetailResult>();
      let catalogs = 0;
      const { client, request } = createClient(async (method) => {
        if (method === "plugins.list") {
          return local.promise;
        }
        if (method === "plugins.inspect") {
          return createInspectResult();
        }
        if (method === "plugins.catalog.get") {
          if (++catalogs === 1 && remoteState === "pending") {
            return remote.promise;
          }
          throw new Error("ClawHub unavailable");
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const harness = createGateway(client);
      const { page } = await mountPage(
        createContext(harness.gateway),
        createPluginsRouteData(
          harness.gateway,
          null,
          createPluginsRouteLocation(`/plugins/${plugin.catalogId}`),
        ),
      );
      await vi.waitFor(() => expect(catalogs).toBe(1));
      if (producer === "task") {
        local.resolve(result);
      } else {
        page.routeData = createPluginsRouteData(
          harness.gateway,
          result,
          createPluginsRouteLocation(`/plugins/${plugin.catalogId}`),
        );
        await page.updateComplete;
      }
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: plugin.id }),
      );
      expect(page.querySelector('[aria-label="Enable Workboard"]')).not.toBeNull();
      expect(page.querySelector(".plugin-catalog-detail__install")).toBeNull();
      remote.resolve(discoveryDetail({ ...plugin, installed: false }));
      await remote.promise;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await page.updateComplete;
      expect(page.querySelector('[aria-label="Enable Workboard"]')).not.toBeNull();
      expect(page.querySelector(".plugin-catalog-detail__install")).toBeNull();
    },
  );

  it("keeps setup in Settings and blocks enabling an incomplete plugin", async () => {
    const plugin = createPlugin({
      id: "team-reports",
      name: "Team Reports",
      description: "Daily team activity reports.",
      state: "needs-setup",
    });
    const result = createResult(plugin);
    const { client } = createClient(async (method) =>
      method === "plugins.inspect"
        ? createInspectResult({
            plugin: {
              id: plugin.id,
              name: plugin.name,
              origin: plugin.origin,
              installed: true,
              enabled: false,
            },
          })
        : result,
    );
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      result,
      createPluginsRouteLocation("/settings/plugins/team-reports"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    await vi.waitFor(() => {
      expect(page.querySelector("h1")?.textContent).toContain("Team Reports");
    });
    expect(page.querySelector(".plugins-settings-detail-setup")).toBeNull();
    expect(page.querySelector('[role="tablist"]')).toBeNull();
    expect(page.querySelector(".plugin-catalog-detail__panel .oc-banner-warning")).toBeNull();
    const settings = page.querySelector<HTMLAnchorElement>(
      '.plugin-catalog-detail__actions a[aria-label="Settings"]',
    );
    expect(settings?.href).toContain("view=settings");
    expect(
      page.querySelector('[aria-label="Enable Team Reports"]')?.getAttribute("aria-disabled"),
    ).toBe("true");
  });
});
