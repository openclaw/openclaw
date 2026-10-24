/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
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

  it.each(["appearance", "notifications", "infrastructure"] as const)(
    "keeps the %s config read failure visible until an explicit retry",
    async (pageId) => {
      const firstRead = deferred<unknown>();
      const retryRead = deferred<unknown>();
      const config = { gateway: { port: 18789 } };
      let reads = 0;
      const request = vi.fn((method: string) => {
        if (method === "config.get") {
          reads += 1;
          return reads === 1 ? firstRead.promise : retryRead.promise;
        }
        if (method === "config.schema") {
          return Promise.resolve({
            schema: {
              type: "object",
              properties: {
                gateway: { type: "object", properties: { port: { type: "number" } } },
              },
            },
            uiHints: {},
          });
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
        firstRead.reject(new Error("Synthetic config read failed"));
        await waitForSolid(() => {
          expect(mounted.querySelector(".config-content-callout")?.textContent ?? "").toContain(
            "Synthetic config read failed",
          );
        });
        publishConfigSource(context.theme);
        window.dispatchEvent(new Event("focus"));
        await waitForSolid(() => {
          expect(reads).toBe(1);
          expect(mounted.querySelector(".config-content-callout")?.textContent ?? "").toContain(
            "Synthetic config read failed",
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
          expect(mounted.querySelector(".config-loading")).not.toBeNull();
        });
        retryRead.resolve({
          config,
          hash: "recovered",
          raw: JSON.stringify(config),
          valid: true,
          issues: [],
        });
        await waitForSolid(() => {
          expect(mounted.querySelector(".config-content-callout")).toBeNull();
          expect(mounted.querySelector(".config-loading")).toBeNull();
          expect(mounted.querySelector("#config-section-panel")?.textContent).toMatch(/\S/);
        });
        expect(reads).toBe(2);
      } finally {
        firstRead.resolve(undefined);
        retryRead.resolve(undefined);
        mounted.dispose();
        router.stop();
        runtimeConfig.dispose();
      }
    },
  );
});
