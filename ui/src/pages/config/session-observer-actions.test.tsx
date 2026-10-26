import { createRouter } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { configSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
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

const utilityModel = { primary: "", fallbacks: ["fixture/backup"] };
const utilityPatch = { agents: { defaults: { utilityModel } } };
const error = "Synthetic observer save failed";

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
    return configSnapshot(config, "original", JSON.stringify(config));
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
  const observerToggle = () =>
    [
      ...outlet.querySelectorAll<HTMLInputElement>(
        '#settings-appearance-sidebar input[role="switch"]',
      ),
    ].at(-1)!;
  await waitForSolid(() => expect(observerToggle()).toBeDefined());
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
    saved: {
      config: { ...config, gateway: { controlUi: { sessionObserver: false } } },
      hash: "saved",
    },
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
  let page: Awaited<ReturnType<typeof setup>>;
  let retried: ReturnType<typeof createDeferred<unknown>>;
  beforeEach(async () => {
    page = await setup();
    retried = createDeferred<unknown>();
  });
  afterEach(async () => {
    retried.resolve({ noop: true });
    await page.dispose();
    vi.unstubAllGlobals();
  });

  it.each(["saved", "rejected"] as const)(
    "shows a held toggle, reconciles its %s result and allows retry after rejection",
    async (result) => {
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
        page.held.resolve(page.saved);
      } else {
        page.held.reject(new Error(error));
      }
      await waitForSolid(() => {
        expect(page.outlet.textContent).not.toContain("Saving…");
        expect(toggle.getAttribute("aria-disabled")).toBeNull();
        expect(toggle.checked).toBe(result !== "saved");
      });
      expect(page.observerToggle()).toBe(toggle);
      if (result === "rejected") {
        expect(page.runtimeConfig.state.lastError).toContain(error);
        expect(page.outlet.textContent).toContain(error);
        page.request.mockImplementationOnce(() => retried.promise);
        page.observerToggle().click();
        await waitForSolid(() => {
          expect(page.outlet.textContent).toContain("Saving…");
          expect(page.outlet.textContent).not.toContain(error);
        });
        retried.resolve(page.saved);
        await waitForSolid(() => {
          expect(page.observerToggle().checked).toBe(false);
          expect(page.observerToggle().getAttribute("aria-disabled")).toBeNull();
          expect(page.outlet.textContent).not.toContain(error);
        });
      }
    },
  );

  it("keeps model selection optimistic and preserves the owner's fallback chain", async () => {
    await choosePickerValue(page.picker(), "");
    await waitForSolid(() => expect(page.outlet.textContent).toContain("Saving…"));
    expect(page.picker().textContent).toContain("Disabled");
    expect(page.observerToggle().disabled).toBe(true);
    const patch = page.request.mock.calls.find(([method]) => method === "config.patch");
    expect(patch?.[1]).toMatchObject({
      raw: JSON.stringify(utilityPatch),
      replacePaths: ["agents.defaults.utilityModel.fallbacks"],
    });
    page.held.resolve({
      config: { ...page.config, ...utilityPatch },
      hash: "saved",
    });
    await waitForSolid(() => expect(page.outlet.textContent).not.toContain("Saving…"));
    expect(page.picker().textContent).toContain("Disabled");
    expect(page.observerToggle().disabled).toBe(false);
  });

  it("leaves Appearance while its write is held and keeps late rejection out of the destination", async () => {
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
  });
});
