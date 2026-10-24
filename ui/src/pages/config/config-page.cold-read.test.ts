/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
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
import {
  completeConfigContext,
  createConfigRouteContext as routeContext,
  publishConfigSource,
} from "./config-page.test-support.ts";
import type { ConfigPageRouteData } from "./config-page.tsx";
import type { ConfigPageId } from "./config-sections.ts";
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
      // Both owner reads start before the page chunk can mount and request missing data.
      expect(request).toHaveBeenCalledWith("config.get", {});
      expect(request).toHaveBeenCalledWith("config.schema", {});
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
