import { createRouter } from "@openclaw/uirouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { choosePickerValue } from "../../test-helpers/select-picker.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { completeConfigContext } from "./config-page.test-support.ts";
import type { ConfigPageId, ConfigPageRouteData } from "./config-page.tsx";
import { pages } from "./route.ts";

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  vi.stubGlobal("localStorage", createStorageMock());
  const held = createDeferred<unknown>();
  const config = {
    gateway: { controlUi: { sessionObserver: true } },
    agents: {
      defaults: { utilityModel: { primary: "fixture/small", fallbacks: ["fixture/backup"] } },
    },
  };
  const request = vi.fn<GatewayRequestHandler>(async (method) => {
    if (method === "config.patch") {
      return held.promise;
    }
    if (method === "config.schema") {
      return { schema: { type: "object", properties: {} }, uiHints: {} };
    }
    return { config, raw: JSON.stringify(config), hash: "original", valid: true, issues: [] };
  });
  const client = createTestGatewayClient(request);
  const { gateway } = createGatewayHarness(client);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  await runtimeConfig.ensureLoaded();
  await runtimeConfig.ensureSchemaLoaded();
  // SAFETY: The shared fixture supplies capabilities unused by the real config page.
  const context = completeConfigContext({
    gateway,
    runtimeConfig,
  } as unknown as ApplicationContext);
  const Provider = createSolidApplicationContextProvider(context).wrapper;
  type SettingsRoute = Extract<(typeof pages)[number], { id: ConfigPageId }>;
  const appearance = pages.find((page): page is SettingsRoute => page.id === "appearance")!;
  const advanced = pages.find((page): page is SettingsRoute => page.id === "advanced")!;
  const productionModule = await appearance.component();
  const Render = productionModule.renderSolid;
  const module = {
    ...productionModule,
    renderSolid: (props: SolidRouteProps<ConfigPageRouteData>) => (
      <Provider>
        <Render {...props} />
      </Provider>
    ),
  };
  const router = createRouter<ConfigPageId, ApplicationContext, typeof module, ConfigPageRouteData>(
    {
      routes: [appearance, advanced].map((route) =>
        Object.assign({}, route, { component: () => module }),
      ),
    },
  );
  Object.assign(context, { router });
  const outlet = mountRouterOutlet({ router, retryContext: context });
  await router.navigate("appearance", context);
  const toggle = () =>
    outlet.querySelector<HTMLInputElement>('#settings-appearance-sidebar input[role="switch"]');
  const observerToggle = () =>
    [
      ...outlet.querySelectorAll<HTMLInputElement>(
        '#settings-appearance-sidebar input[role="switch"]',
      ),
    ].at(-1)!;
  await waitForSolid(() => expect(toggle()).not.toBeNull());
  const picker = () =>
    outlet.querySelector<HTMLElement>(
      "#settings-appearance-sidebar openclaw-select-picker.model-picker__select",
    )!;
  return {
    held,
    config,
    request,
    runtimeConfig,
    router,
    outlet,
    context,
    observerToggle,
    picker,
    async dispose() {
      held.resolve({ noop: true });
      await held.promise.catch(() => undefined);
      flush();
      outlet.dispose();
      router.stop();
      runtimeConfig.dispose();
    },
  };
}

describe("Session Observer actions", () => {
  it.each(["saved", "rejected"] as const)(
    "shows a held toggle and reconciles its %s owner result",
    async (result) => {
      const page = await setup();
      try {
        const toggle = page.observerToggle();
        expect(toggle.checked).toBe(true);
        toggle.click();
        await waitForSolid(() => {
          expect(page.request).toHaveBeenCalledWith("config.patch", expect.anything());
          expect(page.outlet.textContent).toContain("Saving…");
          expect(toggle.getAttribute("aria-disabled")).toBe("true");
          expect(toggle.disabled).toBe(false);
          expect(toggle.checked).toBe(false);
        });
        expect(page.observerToggle()).toBe(toggle);
        if (result === "saved") {
          page.held.resolve({
            config: { ...page.config, gateway: { controlUi: { sessionObserver: false } } },
            hash: "saved",
          });
        } else {
          page.held.reject(new Error("Synthetic observer save failed"));
        }
        await waitForSolid(() => {
          expect(page.outlet.textContent).not.toContain("Saving…");
          expect(toggle.getAttribute("aria-disabled")).toBeNull();
          expect(toggle.checked).toBe(result !== "saved");
        });
        expect(page.observerToggle()).toBe(toggle);
        if (result === "rejected") {
          expect(page.runtimeConfig.state.lastError).toContain("Synthetic observer save failed");
          expect(page.outlet.textContent).toContain("Synthetic observer save failed");
        }
      } finally {
        await page.dispose();
      }
    },
  );

  it("clears the previous failure while a later toggle is pending", async () => {
    const page = await setup();
    const retried = createDeferred<unknown>();
    try {
      page.observerToggle().click();
      await waitForSolid(() => expect(page.outlet.textContent).toContain("Saving…"));
      page.held.reject(new Error("Synthetic observer save failed"));
      await waitForSolid(() => {
        expect(page.outlet.textContent).toContain("Synthetic observer save failed");
        expect(page.observerToggle().getAttribute("aria-disabled")).toBeNull();
      });

      page.request.mockImplementationOnce(() => retried.promise);
      page.observerToggle().click();
      await waitForSolid(() => {
        expect(page.outlet.textContent).toContain("Saving…");
        expect(page.outlet.textContent).not.toContain("Synthetic observer save failed");
      });
      retried.resolve({
        config: { ...page.config, gateway: { controlUi: { sessionObserver: false } } },
        hash: "retried",
      });
      await waitForSolid(() => {
        expect(page.observerToggle().checked).toBe(false);
        expect(page.observerToggle().getAttribute("aria-disabled")).toBeNull();
        expect(page.outlet.textContent).not.toContain("Synthetic observer save failed");
      });
    } finally {
      retried.resolve({ noop: true });
      await page.dispose();
    }
  });

  it("keeps model selection optimistic and preserves the owner's fallback chain", async () => {
    const page = await setup();
    try {
      await choosePickerValue(page.picker(), "");
      await waitForSolid(() => expect(page.outlet.textContent).toContain("Saving…"));
      expect(page.picker().textContent).toContain("Disabled");
      expect(page.observerToggle().disabled).toBe(true);
      const patch = page.request.mock.calls.find(([method]) => method === "config.patch");
      expect(patch?.[1]).toMatchObject({
        raw: JSON.stringify({
          agents: { defaults: { utilityModel: { primary: "", fallbacks: ["fixture/backup"] } } },
        }),
        replacePaths: ["agents.defaults.utilityModel.fallbacks"],
      });
      page.held.resolve({
        config: {
          ...page.config,
          agents: { defaults: { utilityModel: { primary: "", fallbacks: ["fixture/backup"] } } },
        },
        hash: "saved",
      });
      await waitForSolid(() => expect(page.outlet.textContent).not.toContain("Saving…"));
      expect(page.picker().textContent).toContain("Disabled");
      expect(page.observerToggle().disabled).toBe(false);
    } finally {
      await page.dispose();
    }
  });

  it("leaves Appearance while its write is held and keeps late rejection out of the destination", async () => {
    const page = await setup();
    try {
      page.observerToggle().click();
      await waitForSolid(() => expect(page.outlet.textContent).toContain("Saving…"));
      await page.router.navigate("advanced", page.context);
      await waitForSolid(() =>
        expect(page.outlet.querySelector(".page-title")?.textContent).toBe("Advanced"),
      );
      expect(page.outlet.querySelector("#settings-appearance-sidebar")).toBeNull();
      page.held.reject(new Error("Late synthetic observer failure"));
      await waitForSolid(() =>
        expect(page.runtimeConfig.state.lastError).toContain("Late synthetic observer failure"),
      );
      expect(page.outlet.querySelector(".page-title")?.textContent).toBe("Advanced");
      expect(page.outlet.textContent).not.toContain("Saving…");
      await page.router.navigate("appearance", page.context);
      await waitForSolid(() =>
        expect(page.observerToggle()?.getAttribute("aria-disabled")).toBeNull(),
      );
      expect(page.observerToggle().checked).toBe(true);
    } finally {
      await page.dispose();
    }
  });
});
