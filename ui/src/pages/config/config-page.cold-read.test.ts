/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { createComponent, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
import { configSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createConfigPage } from "./config-page-state.ts";
import {
  completeConfigContext,
  createConfigRouteContext as routeContext,
  mountConfigPage,
  publishConfigSource,
} from "./config-page.test-support.ts";
import type { ConfigPageRouteData } from "./config-page.tsx";
import type { ConfigPageId } from "./config-sections.ts";
import { configRouteData } from "./route-data.ts";
import { pages } from "./route.ts";

describe("ConfigPage cold reads", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("localStorage", createStorageMock());
    resetServerUiPrefsSync();
  });

  afterEach(() => {
    cleanupSolid();
    document.body.replaceChildren();
    resetServerUiPrefsSync();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { search: "", activeSection: "__appearance__" },
    { search: "?section=ui", activeSection: "ui" },
  ])("renders the initial Appearance selection $activeSection before route effects", (entry) => {
    const router = createRouter<RouteId, ApplicationContext>({ routes: [] });
    const context = completeConfigContext({ ...routeContext(), router });
    const routeData = configRouteData({
      pathname: "/settings/appearance",
      search: entry.search,
      hash: "",
    });
    const initial = createRoot((dispose) => {
      const state = createConfigPage(
        context,
        () => ({ pageId: "appearance", routeData }),
        () => document.body,
      );
      return { dispose, config: state.configProps() };
    });
    try {
      expect(initial.config.activeSection).toBe(entry.activeSection);
      expect(initial.config.includeSections).toEqual(["__appearance__", "ui"]);
      expect(initial.config.showModeToggle).toBe(false);
    } finally {
      initial.dispose();
      router.stop();
    }
  });

  it("keeps display-backed Appearance ready while lower settings load and retry", async () => {
    const firstRead = deferred<unknown>();
    const retryRead = deferred<unknown>();
    const display = { ui: { prefs: { themeMode: "dark" } } };
    const config = { ...display, gateway: { controlUi: { sessionObserver: false } } };
    const response = configSnapshot(config, "loaded", JSON.stringify(config));
    let reads = 0;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        return ++reads === 1 ? firstRead.promise : retryRead.promise;
      }
      if (method === "config.schema") {
        return Promise.resolve({
          schema: { type: "object", properties: { ui: { type: "object", properties: {} } } },
          uiHints: {},
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${method}`));
    });
    const { gateway } = createGatewayHarness(createTestGatewayClient(request));
    const runtimeConfig = createRuntimeConfigCapability(gateway, {
      current: () => display,
      subscribe: () => () => undefined,
    });
    const router = createRouter<RouteId, ApplicationContext>({ routes: [] });
    // SAFETY: real config and Gateway owners replace the partial presentation fixture.
    const context = completeConfigContext({
      ...routeContext(),
      router,
      gateway: { ...gateway, connection: { gatewayUrl: "ws://config.test" } },
      runtimeConfig,
    } as unknown as ApplicationContext);
    const location = { pathname: "/settings/appearance", search: "", hash: "" };
    const route = expectDefined(
      pages.find((page) => page.id === "appearance"),
      "appearance route",
    );
    await route.loader!(context, {
      signal: new AbortController().signal,
      shouldRun: () => true,
      revalidating: false,
      location,
      deps: "",
      cause: "navigation",
    });
    const mounted = mountConfigPage(context, {
      pageId: "appearance",
      routeData: configRouteData(location),
    });
    try {
      const typography = expectDefined(
        mounted.container.querySelector("#settings-appearance-typography"),
        "typography",
      );
      const sidebar = expectDefined(
        mounted.container.querySelector("#settings-appearance-sidebar"),
        "sidebar preferences",
      );
      const observer = expectDefined(
        [...sidebar.querySelectorAll<HTMLInputElement>(".settings-toggle__input")].at(-1),
        "observer toggle",
      );
      expect(mounted.container.querySelector("#config-sections-tab-ui")).not.toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(observer.disabled).toBe(true);
      sidebar.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await waitForSolid(() => {
        expect(reads).toBe(1);
        expect(request).toHaveBeenCalledWith("config.schema", {});
      });
      firstRead.reject(new Error("Synthetic lower settings failed"));
      await waitForSolid(() =>
        expect(sidebar.textContent).toContain("Synthetic lower settings failed"),
      );
      expect(mounted.container.querySelector("#settings-appearance-typography")).toBe(typography);
      expect(observer.disabled).toBe(true);
      expectDefined(
        sidebar.querySelector<HTMLButtonElement>(".config-content-callout button"),
        "retry",
      ).click();
      await waitForSolid(() => expect(reads).toBe(2));
      retryRead.resolve(response);
      await waitForSolid(() => {
        expect(sidebar.textContent).not.toContain("Synthetic lower settings failed");
        expect(observer.disabled).toBe(false);
        expect(observer.checked).toBe(false);
      });
      expect(mounted.container.querySelector("#settings-appearance-typography")).toBe(typography);
    } finally {
      firstRead.resolve(response);
      retryRead.resolve(response);
      mounted.dispose();
      router.stop();
      runtimeConfig.dispose();
    }
  });

  it.each([
    { pageId: "appearance", failedRead: "config" },
    { pageId: "notifications", failedRead: "config" },
    { pageId: "infrastructure", failedRead: "config" },
    { pageId: "infrastructure", failedRead: "schema" },
  ] as const)(
    "loads $pageId independently and keeps its $failedRead failure visible until Retry",
    async ({ pageId, failedRead }) => {
      const firstRead = deferred<unknown>();
      const retryRead = deferred<unknown>();
      const pendingConfig = deferred<unknown>();
      const config = { gateway: { port: 18789 } };
      const configResponse = configSnapshot(config, "recovered", JSON.stringify(config));
      const schemaResponse = {
        schema: {
          type: "object",
          properties: {
            gateway: { type: "object", properties: { port: { type: "number" } } },
          },
        },
        uiHints: {},
      };
      let reads = 0;
      const request = vi.fn((method: string) => {
        if (method === (failedRead === "config" ? "config.get" : "config.schema")) {
          reads += 1;
          return reads === 1 ? firstRead.promise : retryRead.promise;
        }
        if (method === "config.get") {
          return pendingConfig.promise;
        }
        if (method === "config.schema") {
          return Promise.resolve(schemaResponse);
        }
        return Promise.resolve({});
      });
      const { gateway } = createGatewayHarness(createTestGatewayClient(request));
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      // SAFETY: the real owners replace the partial route fixture; completion fills missing capabilities.
      const context = completeConfigContext({
        ...routeContext(),
        gateway: { ...gateway, connection: { gatewayUrl: "ws://config.test" } },
        runtimeConfig,
      } as unknown as ApplicationContext);
      const configPages = pages.filter((page) => page.id !== "settings" && page.id !== "config");
      const route = expectDefined(
        configPages.find((page) => page.id === pageId),
        "config route",
      );
      await route.loader!(context, {
        signal: new AbortController().signal,
        shouldRun: () => true,
        revalidating: false,
        location: { pathname: `/${pageId}`, search: "", hash: "" },
        deps: "",
        cause: "navigation",
      });
      // The lazy editor admits both reads independently before page presentation.
      await waitForSolid(() => {
        expect(request).toHaveBeenCalledWith("config.get", {});
        expect(request).toHaveBeenCalledWith("config.schema", {});
      });
      const productionModule = await route.component();
      const provider = createSolidApplicationContextProvider(context);
      const render = productionModule.renderSolid;
      const module = {
        ...productionModule,
        renderSolid: (props: Parameters<typeof render>[0]) =>
          createComponent(provider.wrapper, {
            get children() {
              return createComponent(render, props);
            },
          }),
      };
      const router = createRouter<
        ConfigPageId,
        ApplicationContext,
        typeof module,
        ConfigPageRouteData
      >({ routes: [{ ...route, component: () => module }] });
      Object.assign(context, { router });
      const mounted = mountRouterOutlet({ router, retryContext: context });
      try {
        await router.navigate(pageId, context);
        await waitForSolid(() => expect(reads).toBe(1));
        const failure = `Synthetic ${failedRead} read failed`;
        firstRead.reject(new Error(failure));
        if (failedRead === "schema") {
          await runtimeConfig.schemaRead;
          pendingConfig.resolve(configResponse);
        }
        await waitForSolid(() => {
          expect(mounted.querySelector(".config-content-callout")?.textContent ?? "").toContain(
            failure,
          );
        });
        publishConfigSource(context.theme);
        window.dispatchEvent(new Event("focus"));
        await waitForSolid(() => {
          expect(reads).toBe(1);
          expect(mounted.querySelector(".config-content-callout")?.textContent ?? "").toContain(
            failure,
          );
        });
        const retry = expectDefined(
          mounted.querySelector<HTMLButtonElement>(".config-content-callout button"),
          "config retry",
        );
        expect(retry.textContent?.trim()).toBe("Retry");
        retry.click();
        await waitForSolid(() => {
          expect(reads).toBe(2);
          if (failedRead === "config") {
            expect(mounted.querySelector(".config-loading")).not.toBeNull();
          }
        });
        retryRead.resolve(failedRead === "config" ? configResponse : schemaResponse);
        await waitForSolid(() => {
          expect(mounted.querySelector(".config-content-callout")).toBeNull();
          expect(mounted.querySelector(".config-loading")).toBeNull();
          expect(mounted.querySelector("#config-section-panel")?.textContent).toMatch(/\S/);
        });
        expect(reads).toBe(2);
      } finally {
        firstRead.resolve(undefined);
        retryRead.resolve(undefined);
        pendingConfig.resolve(configResponse);
        mounted.dispose();
        router.stop();
        runtimeConfig.dispose();
      }
    },
  );
});
