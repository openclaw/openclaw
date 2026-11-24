/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { createComponent, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createNativeNotificationsCapability } from "../../app/native-notifications.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
import { configSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import {
  missingReadScopeErrorFixture,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
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

  it("settles denied lower Appearance reads without blocking personal preferences", async () => {
    const request = vi.fn(async () => ({}));
    const client = createTestGatewayClient(request);
    const { gateway, publish } = createGatewayHarness(client);
    const hello = gatewayHelloForMethods(
      ["config.get", "config.schema", "system.info", "plugins.list"],
      ["operator.sessions.read"],
    );
    Object.defineProperty(client, "auth", { value: hello.auth });
    publish(true, client, hello);
    const runtimeConfig = createRuntimeConfigCapability(gateway, {
      current: () => ({ ui: { prefs: { themeMode: "dark" } } }),
      subscribe: () => () => undefined,
    });
    // SAFETY: completeConfigContext fills the partial route fixture around real read owners.
    const context = completeConfigContext({
      ...routeContext(),
      gateway: { ...gateway, connection: { gatewayUrl: "ws://guest.test" } },
      runtimeConfig,
    } as unknown as ApplicationContext);
    const mounted = mountConfigPage(context, { pageId: "appearance" });
    try {
      const sidebar = expectDefined(
        mounted.container.querySelector("#settings-appearance-sidebar"),
        "sidebar",
      );
      sidebar.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await waitForSolid(() => {
        expect(sidebar.querySelector("input:enabled")).not.toBeNull();
        expect(sidebar.textContent).not.toContain("Loading");
        expect(sidebar.textContent).not.toContain("no small model");
        expect(
          mounted.container.querySelector("#settings-session-sources")?.textContent,
        ).not.toContain("Loading");
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      mounted.dispose();
      runtimeConfig.dispose();
    }
  });

  it("keeps personal native Notifications available without config reads across guest reconnects", async () => {
    const request = vi.fn(async () => ({}));
    const client = createTestGatewayClient(request);
    const hello = gatewayHelloForMethods(
      ["config.get", "config.schema"],
      ["operator.sessions.read"],
    );
    Object.defineProperty(client, "auth", { value: hello.auth });
    const source = createApplicationGateway(
      createApplicationGatewaySnapshot({ client, phase: "reconnecting", hello: null }),
    );
    const { gateway } = source;
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawNotifications: { postMessage } } });
    const nativeNotifications = expectDefined(
      createNativeNotificationsCapability(),
      "native owner",
    );
    window.dispatchEvent(
      new CustomEvent("openclaw:native-notifications-status", {
        detail: { permission: "notDetermined" },
      }),
    );
    const context = completeConfigContext({
      ...routeContext(),
      gateway,
      runtimeConfig,
      nativeNotifications,
    });
    const mounted = mountConfigPage(context, { pageId: "notifications" });
    try {
      for (const connected of [false, true, false, true]) {
        source.publish({
          ...gateway.snapshot,
          phase: connected ? "connected" : "reconnecting",
          hello: connected ? hello : null,
        });
        await waitForSolid(() => {
          const enable = [...mounted.page.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent?.trim() === "Enable notifications",
          );
          expect(enable).toBeDefined();
          expect(enable?.disabled).toBe(false);
        });
        expect(runtimeConfig.state.configSnapshot).toBeNull();
        expect(runtimeConfig.state.configSchema).toBeNull();
      }
      expectDefined(
        [...mounted.page.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent?.trim() === "Enable notifications",
        ),
        "native permission action",
      ).click();
      expect(postMessage).toHaveBeenCalledWith({ type: "request-permission" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      mounted.dispose();
      nativeNotifications.dispose();
      runtimeConfig.dispose();
    }
  });

  it.each(["config", "schema"] as const)(
    "does not offer Retry for a typed %s read denial",
    async (denied) => {
      const request = vi.fn(async (method: string) => {
        if (method === (denied === "config" ? "config.get" : "config.schema")) {
          throw missingReadScopeErrorFixture();
        }
        return method === "config.get"
          ? configSnapshot({ gateway: { port: 18789 } }, "one")
          : { schema: { type: "object", properties: {} }, uiHints: {} };
      });
      const client = createTestGatewayClient(request);
      const { gateway } = createGatewayHarness(client);
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      // SAFETY: the fixture supplies unrelated capabilities; configuration reads use their real owner.
      const context = completeConfigContext({
        ...routeContext(),
        gateway: { ...gateway, connection: { gatewayUrl: "ws://denial.test" } },
        runtimeConfig,
      } as unknown as ApplicationContext);
      const mounted = mountConfigPage(context, { pageId: "appearance" });
      try {
        mounted.container
          .querySelector("#settings-appearance-sidebar")
          ?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        await waitForSolid(() => {
          expect(mounted.container.querySelector(".config-content-callout")?.textContent).toContain(
            "grant read access",
          );
          expect(mounted.container.querySelector(".config-content-callout button")).toBeNull();
        });
        await runtimeConfig.ensureLoaded();
        expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
      } finally {
        mounted.dispose();
        runtimeConfig.dispose();
      }
    },
  );

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
      const observer = () =>
        [...sidebar.querySelectorAll<HTMLInputElement>(".settings-toggle__input")].at(-1);
      expect(mounted.container.querySelector("#config-sections-tab-ui")).not.toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(sidebar.querySelector("openclaw-select-picker")).toBeNull();
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
      expect(sidebar.querySelector("openclaw-select-picker")).toBeNull();
      expectDefined(
        sidebar.querySelector<HTMLButtonElement>(".config-content-callout button"),
        "retry",
      ).click();
      await waitForSolid(() => expect(reads).toBe(2));
      retryRead.resolve(response);
      await waitForSolid(() => {
        expect(sidebar.textContent).not.toContain("Synthetic lower settings failed");
        expect(observer()?.disabled).toBe(false);
        expect(observer()?.checked).toBe(false);
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
            expect(
              mounted.querySelector(
                pageId === "appearance" ? ".skeleton[aria-busy=true]" : ".config-loading",
              ),
            ).not.toBeNull();
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
