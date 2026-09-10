/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
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
  deferred,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";
import type { PluginsRouteData } from "./route-data.ts";

function clickHubTab(page: HTMLElement, tab: "plugins" | "skills") {
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
    "a chat install link opens review only when installed=%s permits it",
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
      const { client, request } = createClient(async (method) =>
        method === "plugins.catalog.get" ? detail : createResult(),
      );
      const harness = createGateway(client);
      const context = createContext(harness.gateway);
      const routeData = createPluginsRouteData(
        harness.gateway,
        createResult(),
        createPluginsRouteLocation("/plugins/ch_d2hhdHNhcHA?action=install"),
      );
      const { page } = await mountPage(context, routeData);
      await vi.waitFor(() =>
        expect(context.replace).toHaveBeenCalledWith("plugins", {
          pathname: "/plugins/ch_d2hhdHNhcHA",
          search: "",
        }),
      );
      expect(Boolean(page.querySelector(".plugin-install-wizard"))).toBe(!installed);
      expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(false);
    },
  );

  it("switches between the Plugins and Skills workspace without reviving catalog tabs", async () => {
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

    clickHubTab(page, "plugins");
    expect(context.navigate).not.toHaveBeenCalled();
    clickHubTab(page, "skills");
    expect(context.navigate).toHaveBeenCalledWith("skills");
  });

  it("keeps the canonical settings inventory at /settings/plugins", async () => {
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      createResult(),
      createPluginsRouteLocation("/settings/plugins"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    expect(context.replace).not.toHaveBeenCalled();
    expect(page.querySelector('.plugins-settings-search input[type="search"]')).not.toBeNull();
    expect(page.querySelector(".plugins-settings-tabs")?.classList.contains("oc-segmented")).toBe(
      true,
    );
    const row = page.querySelector('[data-plugin-id="workboard"]');
    expect(row?.querySelector("wa-switch")).toBeNull();
    expect(row?.querySelector('[data-plugin-state="disabled"]')).not.toBeNull();
  });

  it.each([
    {
      label: "Settings",
      route: "/settings/plugins/workboard",
      target: "plugin-settings" as const,
      pathname: "/settings/plugins",
      href: "/settings/plugins",
    },
    {
      label: "Plugins",
      route: "/settings/plugins/workboard?from=plugins",
      target: "plugins" as const,
      pathname: "/plugins",
      href: "/plugins",
    },
  ])("opens a settings detail with its $label breadcrumb", async (testCase) => {
    const { client, request } = createClient(async (method) =>
      method === "plugins.inspect" ? createInspectResult() : createResult(),
    );
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      createResult(),
      createPluginsRouteLocation(testCase.route),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    await vi.waitFor(() => {
      expect(page.querySelector("h1")?.textContent).toContain("Workboard");
    });
    expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: "workboard" });

    const breadcrumb = page.querySelector<HTMLAnchorElement>(
      ".plugins-settings-breadcrumb__parent",
    );
    expect(breadcrumb?.textContent).toBe(testCase.label);
    expect(breadcrumb?.getAttribute("href")).toBe(testCase.href);
    expect(page.querySelector('[aria-current="page"]')?.textContent).toBe("Workboard");
    const hero = page.querySelector(".plugin-catalog-detail__hero");
    expect(page.querySelector(".plugin-catalog-detail--no-sidebar")).not.toBeNull();
    expect(hero?.querySelector(".plugin-catalog-detail__sidebar")).toBeNull();
    expect(hero?.querySelector(".plugin-catalog-detail__publisher-icon")).not.toBeNull();
    expect(hero?.querySelector("h1")?.textContent).toBe("Workboard");
    expect(hero?.querySelector(".plugin-catalog-detail__summary")?.textContent).toBe(
      t("subtitles.workboard"),
    );
    expect(hero?.querySelector("wa-switch")).not.toBeNull();
    breadcrumb?.click();
    await page.updateComplete;
    expect(context.navigate).toHaveBeenCalledWith(testCase.target, {
      pathname: testCase.pathname,
    });
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
      createPluginsRouteLocation("/settings/plugins/workboard"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    const retry = Array.from(page.querySelectorAll<HTMLElement>(".plugins-settings-error"))
      .find((element) => element.textContent?.includes("Save failed"))
      ?.querySelector<HTMLButtonElement>("button");
    expect(retry?.textContent?.trim()).toBe("Try again");
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
      createPluginsRouteLocation("/settings/plugins/workboard"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    page.querySelector<HTMLButtonElement>(".plugins-settings-error button")?.click();

    expect(refresh).toHaveBeenCalledOnce();
    expect(runtimeConfig.runtimeConfig.refreshSchema).toHaveBeenCalledOnce();
    expect(runtimeConfig.runtimeConfig.retry).not.toHaveBeenCalled();
  });

  it("refreshes the selected inspection after configuration autosave", async () => {
    const result = createResult();
    let inspectionCount = 0;
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.inspect") {
        inspectionCount += 1;
        return createInspectResult({ reviewToken: `review-token-${inspectionCount}` });
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

  it("renders local settings before optional ClawHub presentation settles", async () => {
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
    let resolveCatalog!: (value: typeof catalog) => void;
    const catalogPending = new Promise<typeof catalog>((resolve) => {
      resolveCatalog = resolve;
    });
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.inspect") {
        return createInspectResult();
      }
      if (method === "plugins.catalog.get") {
        return catalogPending;
      }
      return result;
    });
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      result,
      createPluginsRouteLocation("/settings/plugins/workboard"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    await vi.waitFor(() => expect(page.querySelector("h1")?.textContent).toContain("Workboard"));
    expect(page.querySelector(".plugins-settings-detail-actions wa-switch")).not.toBeNull();
    expect(page.querySelector(".plugin-catalog-detail__sidebar")).toBeNull();
    expect(request).toHaveBeenCalledWith(
      "plugins.catalog.get",
      {
        id: plugin.catalogId,
        version: "1.2.3",
      },
      undefined,
    );

    resolveCatalog(catalog);
    await vi.waitFor(() =>
      expect(page.querySelector(".plugin-catalog-detail__sidebar")).not.toBeNull(),
    );
  });

  it("explains required setup in Configuration and blocks enabling", async () => {
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
    const configurationTab = page.querySelector("#plugin-installed-detail-tab-configuration");
    expect(configurationTab?.getAttribute("aria-selected")).toBe("true");
    expect(configurationTab?.querySelector(".plugin-installed-detail__setup-dot")).not.toBeNull();
    const alert = page.querySelector(".plugin-catalog-detail__panel .oc-banner-warning");
    expect(alert?.textContent?.trim()).toBe(
      "Complete the required configuration before enabling this plugin.",
    );
    expect(page.querySelector(".plugins-settings-detail-actions .settings-status")).toBeNull();
    expect(
      page.querySelector(".plugins-settings-detail-actions wa-switch")?.hasAttribute("disabled"),
    ).toBe(true);
  });
});
