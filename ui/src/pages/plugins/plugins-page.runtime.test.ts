/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type { PluginMutationResult } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  activatePluginControl,
  createClient,
  createContext,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

beforeEach(() => i18n.setLocale("en"));
afterEach(resetPluginsPageTestState);

const config = { plugins: { entries: { workboard: { enabled: false } } } };
const configSnapshot = {
  config,
  sourceConfig: config,
  hash: "unchanged-config",
  raw: JSON.stringify(config),
  valid: true,
  issues: [],
  path: "/synthetic/openclaw.json",
};
const receipt: PluginMutationResult = {
  ok: true,
  plugin: createPlugin({ enabled: true, state: "enabled" }),
  restartRequired: false,
  runtime: { operationId: "enable-workboard", generation: 7, pluginIds: ["workboard"] },
};

it.each(["before", "after", "during refresh"] as const)(
  "reconciles enablement with publication event %s the mutation refresh",
  async (ordering) => {
    const enabling = deferred<PluginMutationResult>();
    const mutationConfig = deferred<typeof configSnapshot>();
    const mutationConfigStarted = deferred();
    let holdMutationConfig = false;
    let catalog = {
      ...createResult(createPlugin({ removable: true })),
      generation: 6,
    };
    const { client, request } = createClient(async (method) => {
      if (method === "config.get") {
        if (holdMutationConfig) {
          holdMutationConfig = false;
          mutationConfigStarted.resolve();
          return mutationConfig.promise;
        }
        return configSnapshot;
      }
      if (method === "plugins.list") {
        return catalog;
      }
      if (method === "plugins.setEnabled") {
        return enabling.promise;
      }
      if (method === "plugins.inspect") {
        return createInspectResult();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client);
    const reconnect = vi.spyOn(harness.gateway, "connect");
    const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
    const { page } = await mountPage(
      { ...createContext(harness.gateway), runtimeConfig },
      createPluginsRouteData(
        harness.gateway,
        catalog,
        createPluginsRouteLocation("/settings/plugins/workboard#lifecycle"),
      ),
    );
    const publish = () =>
      harness.emit(client, true, {
        hello: harness.gateway.snapshot.hello,
        pluginCapabilities: {
          ok: true,
          generation: 7,
          descriptors: [],
          methods: ["plugins.setEnabled"],
          controlUiTabs: [],
          controlUiWidgetKinds: [],
          pluginSurfaceUrls: {},
        },
      });
    try {
      await runtimeConfig.ensureLoaded();
      const button = page.querySelector<HTMLButtonElement>('[aria-label="Enable Workboard"]');
      expect(button, "installed plugin exposes enablement").not.toBeNull();
      button!.click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
          pluginId: "workboard",
          enabled: true,
        }),
      );
      await page.updateComplete;
      expect(button!.getAttribute("aria-busy")).toBe("true");
      expect(button!.querySelector(".btn__spinner")).not.toBeNull();
      expect(page.querySelectorAll(".plugin-catalog-detail__actions .btn__spinner")).toHaveLength(
        1,
      );
      button!.click();
      catalog = { ...catalog, generation: 7, plugins: [receipt.plugin] };
      if (ordering === "before") {
        publish();
      }
      holdMutationConfig = ordering === "during refresh";
      enabling.resolve(receipt);
      if (ordering === "during refresh") {
        await mutationConfigStarted.promise;
        publish();
        await waitForFast(() => expect(page.result?.generation).toBe(7));
        mutationConfig.resolve(configSnapshot);
      }
      await waitForFast(() => expect(page.busy["plugin:workboard"]).toBeUndefined());
      if (ordering === "after") {
        publish();
      }
      await waitForFast(() => expect(page.result?.generation).toBe(7));
      expect(page.result?.plugins[0]?.enabled).toBe(true);
      expect(page.messages["plugin:workboard"]).toBeUndefined();
      expect(page.querySelector(".plugin-catalog-detail__actions .btn__spinner")).toBeNull();
      expect(page.querySelector(".plugins-row-message--success")).toBeNull();
      expect(request.mock.calls.filter(([method]) => method === "plugins.setEnabled")).toHaveLength(
        1,
      );
      expect(
        request.mock.calls.some(([method]) =>
          ["plugins.reload", "plugins.uninstall", "config.set", "config.patch"].includes(method),
        ),
      ).toBe(false);
      expect(reconnect).not.toHaveBeenCalled();
      expect(harness.gateway.snapshot.phase).toBe("connected");
    } finally {
      runtimeConfig.dispose();
    }
  },
);

it.each([
  { action: "enable", applied: false },
  { action: "enable", applied: true },
  { action: "enable", applied: "earlier" },
  { action: "disable", applied: true },
] as const)(
  "keeps $action failure visible and reconciles only the recorded applied receipt: $applied",
  async ({ action, applied }) => {
    const methodName = "plugins.setEnabled";
    const attempted = {
      operationId: "failed-enablement",
      generation: 8,
      pluginIds: ["workboard"],
      phase: "activate",
      committed: applied === true,
    };
    const runtime = applied === "earlier" ? { ...receipt.runtime, committed: true } : attempted;
    const error = new GatewayRequestError({
      code: "UNAVAILABLE",
      message: `Fixture runtime failed\nGateway generation 8: replacement ${applied === true ? "applied" : "not applied"}.${applied === "earlier" ? "\nAn earlier runtime change from this operation was applied in Gateway generation 7." : ""}`,
      details: { runtime, ...(applied === "earlier" ? { runtimeAttempt: attempted } : {}) },
    });
    const refreshed = {
      ...createResult(createPlugin({ state: "error" })),
      generation: applied === "earlier" ? 7 : 8,
    };
    const { client, request } = createClient(async (method) => {
      if (method === "config.get") {
        return configSnapshot;
      }
      if (method === "plugins.list") {
        return refreshed;
      }
      if (method === methodName) {
        throw error;
      }
      if (method === "plugins.inspect") {
        return createInspectResult();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client);
    const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
    const { page } = await mountPage(
      { ...createContext(harness.gateway), runtimeConfig },
      createPluginsRouteData(
        harness.gateway,
        createResult(
          createPlugin({
            enabled: action === "disable",
            state: action === "disable" ? "enabled" : "disabled",
          }),
        ),
        createPluginsRouteLocation("/settings/plugins/workboard#lifecycle"),
      ),
    );
    try {
      await runtimeConfig.ensureLoaded();
      const actionStart = request.mock.calls.length;
      await activatePluginControl(
        page,
        ".plugin-catalog-detail",
        action === "enable" ? "Enable" : "Disable",
      );
      await waitForFast(() => expect(page.busy["plugin:workboard"]).toBeUndefined());
      await page.updateComplete;
      const message = page.messages["plugin:workboard"];
      expect(message?.kind).toBe("error");
      expect(message?.savedInstall).toBeUndefined();
      expect(message?.text).toContain(error.message);
      expect(message?.text).toContain("Runtime phase: activate.");
      const calls = request.mock.calls.slice(actionStart);
      expect(calls.filter(([method]) => method === methodName)).toHaveLength(1);
      expect(calls.filter(([method]) => method === "plugins.list")).toHaveLength(applied ? 1 : 0);
      expect(calls.filter(([method]) => method === "config.get")).toHaveLength(applied ? 1 : 0);
      expect(page.result?.generation).toBe(applied ? refreshed.generation : undefined);
      expect(page.querySelector(".plugins-install")).toBeNull();
    } finally {
      runtimeConfig.dispose();
    }
  },
);
