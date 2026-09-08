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

  it("retries configuration without discarding the pending draft", async () => {
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

    const retry = page.querySelector<HTMLButtonElement>(".plugins-settings-error button");
    expect(retry?.textContent?.trim()).toBe("Try again");
    retry?.click();

    expect(runtimeConfig.runtimeConfig.retry).toHaveBeenCalledOnce();
    expect(runtimeConfig.runtimeConfig.refreshSchema).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
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
