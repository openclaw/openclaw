/* @vitest-environment jsdom */

import { createRouter, definePage } from "@openclaw/uirouter";
import { onSettled } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { ShellOwner } from "../app/app-host.tsx";
import { bootstrapApplication } from "../app/bootstrap.ts";
import { mountRouterOutlet } from "../app/router-outlet.test-support.tsx";
import { i18n } from "../i18n/index.ts";
import { configSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { createGatewayHarness } from "../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { ShellSettingsSidebar } from "./settings-sidebar-shell.tsx";

beforeEach(async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  await i18n.setLocale("en");
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const held = createDeferred<unknown>();
  const request = vi.fn<GatewayRequestHandler>(async (method) => {
    if (method === "config.set") {
      return held.promise;
    }
    return configSnapshot({ count: 1 }, "initial", '{"count":1}');
  });
  const client = createTestGatewayClient(request);
  const { gateway, publish } = createGatewayHarness(client);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  await runtimeConfig.ensureLoaded();
  runtimeConfig.patchForm(["count"], 2);
  runtimeConfig.state.configAutoSaveStatus = "paused";
  const runtime = bootstrapApplication();
  const lifecycle = new AbortController();
  const router = createRouter({
    routes: [
      definePage({
        id: "appearance",
        path: "/settings/appearance",
        component: () => ({ renderSolid: () => <p>Appearance content</p> }),
      }),
      definePage({
        id: "advanced",
        path: "/settings/advanced",
        component: () => ({ renderSolid: () => <p>Advanced content</p> }),
      }),
    ],
  });
  const context = Object.assign(runtime.context, {
    gateway,
    runtimeConfig,
    router,
    lifecycleAbortSignal: lifecycle.signal,
  });
  const outlet = mountRouterOutlet({ router, retryContext: context });
  await router.navigate("appearance", context);
  const view = mountSolid(() => {
    const owner = new ShellOwner(document.createElement("openclaw-app-shell"), runtime);
    onSettled(() => runtimeConfig.subscribe(() => owner.invalidate()));
    return (
      <ShellSettingsSidebar
        host={owner}
        sidebarProps={{
          presentation: "embed-page",
          activeRouteId: "appearance",
          connectionStatus: null,
          onExit: () => {},
          canAdmin: true,
        }}
      />
    );
  });
  await waitForSolid(() => expect(view.queryByText("Save")).not.toBeNull());
  view.getByText("Save").click();
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledWith("config.set", expect.anything());
    expect(view.queryByText("Saving…")).toBeNull();
  });
  return {
    view,
    outlet,
    router,
    context,
    publish,
    lifecycle,
    held,
    runtimeConfig,
    async dispose() {
      lifecycle.abort();
      held.resolve({ config: { count: 2 }, hash: "saved" });
      await held.promise.catch(() => undefined);
      flush();
      view.unmount();
      outlet.dispose();
      router.stop();
      runtimeConfig.dispose();
      runtime.stop();
    },
  };
}

describe("Settings save command lifetime", () => {
  it.each(["route", "connection", "shutdown"] as const)(
    "releases a held Save on %s retirement and consumes its late failure",
    async (retirement) => {
      const page = await setup();
      try {
        if (retirement === "route") {
          await page.router.navigate("advanced", page.context);
          await waitForSolid(() => expect(page.outlet.textContent).toContain("Advanced content"));
        } else if (retirement === "connection") {
          page.publish(false);
        } else {
          page.lifecycle.abort();
        }
        await waitForSolid(() =>
          expect(page.view.container.querySelector('[aria-busy="true"]')).toBeNull(),
        );
        page.held.reject(new Error("Synthetic retired settings save failed"));
        await page.held.promise.catch(() => undefined);
        flush();
        expect(page.view.container.querySelector('[role="alert"]')).toBeNull();
      } finally {
        await page.dispose();
      }
    },
  );
});
