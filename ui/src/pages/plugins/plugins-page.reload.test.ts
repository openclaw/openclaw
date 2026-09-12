/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { PluginsReloadResult } from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  activatePluginControl,
  createClient,
  createContext,
  createGateway,
  createInspectResult,
  createRuntimeConfigHarness,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  deferred,
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
const receipt: PluginsReloadResult = {
  ok: true,
  pluginIds: ["workboard"],
  restartRequired: false,
  runtime: { operationId: "reload-workboard", generation: 7, pluginIds: ["workboard"] },
};

it.each(
  (["before", "after", "during refresh"] as const).flatMap((ordering) =>
    [true, false].map((mutationAllowed) => ({ ordering, mutationAllowed })),
  ),
)(
  "reloads through the cohort API: event $ordering, writable config $mutationAllowed",
  async ({ ordering, mutationAllowed }) => {
    const reload = deferred<PluginsReloadResult>();
    const mutationConfig = deferred<typeof configSnapshot>();
    const mutationConfigStarted = deferred<void>();
    let holdMutationConfig = false;
    let catalog = {
      ...createResult(createPlugin({ removable: true })),
      generation: 6,
      mutationAllowed,
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
      if (method === "plugins.reload") {
        return reload.promise;
      }
      if (method === "plugins.inspect") {
        return createInspectResult();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client);
    const hello = harness.gateway.snapshot.hello!;
    harness.emit(client, true, {
      hello: {
        ...hello,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: {
          ...hello.features,
          methods: hello.features!.methods!.filter(
            (method) => mutationAllowed || method !== "config.set",
          ),
        },
      },
    });
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
          methods: ["plugins.reload"],
          controlUiTabs: [],
          controlUiWidgetKinds: [],
          pluginSurfaceUrls: {},
        },
      });
    try {
      await runtimeConfig.ensureLoaded();
      expect(runtimeConfig.canSet).toBe(mutationAllowed);
      if (!mutationAllowed) {
        const uninstall = page.querySelector<HTMLButtonElement>(
          '[aria-label="Uninstall Workboard"]',
        )!;
        const toggle = page.querySelector<HTMLElement>("wa-switch")!;
        expect(uninstall.getAttribute("aria-disabled")).toBe("true");
        expect(toggle.getAttribute("aria-disabled")).toBe("true");
        uninstall.click();
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const button = page.querySelector<HTMLButtonElement>('[aria-label="Reload Workboard"]');
      expect(button, "installed plugin exposes backend Reload").not.toBeNull();
      button!.click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("plugins.reload", {
          plugins: [{ pluginId: "workboard" }],
        }),
      );
      await page.updateComplete;
      button!.click();
      catalog = { ...catalog, generation: 7 };
      if (ordering === "before") {
        publish();
      }
      holdMutationConfig = ordering === "during refresh";
      reload.resolve(receipt);
      if (ordering === "during refresh") {
        await mutationConfigStarted.promise;
        publish();
        await waitForFast(() => expect(page.result?.generation).toBe(7));
        mutationConfig.resolve(configSnapshot);
      }
      await waitForFast(() =>
        expect(page.messages["plugin:workboard"]?.text).toContain("Gateway generation 7"),
      );
      if (ordering === "after") {
        publish();
      }
      await waitForFast(() => expect(page.result?.generation).toBe(7));
      expect(page.result?.plugins[0]?.enabled).toBe(false);
      expect(page.messages["plugin:workboard"]).toEqual({
        kind: "success",
        text: "Reloaded Workboard (Gateway generation 7).",
      });
      expect(request.mock.calls.filter(([method]) => method === "plugins.reload")).toHaveLength(1);
      expect(
        request.mock.calls.some(([method]) =>
          ["plugins.setEnabled", "plugins.uninstall", "config.set", "config.patch"].includes(
            method,
          ),
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
  { action: "reload", applied: false },
  { action: "reload", applied: true },
  { action: "reload", applied: "earlier" },
  { action: "enable", applied: true },
  { action: "disable", applied: true },
] as const)(
  "keeps $action failure visible and reconciles only the recorded applied receipt: $applied",
  async ({ action, applied }) => {
    const methodName = action === "reload" ? "plugins.reload" : "plugins.setEnabled";
    const attempted = {
      operationId: "failed-reload",
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
      page.messages["plugin:workboard"] = {
        kind: "error",
        text: "Earlier installation is saved",
        savedInstall: "workboard",
      };
      const actionStart = request.mock.calls.length;
      await activatePluginControl(
        page,
        ".plugin-catalog-detail",
        action === "reload" ? "Reload Workboard" : action === "enable" ? "Enable" : "Disable",
      );
      await waitForFast(() => expect(page.busy["plugin:workboard"]).toBeUndefined());
      await page.updateComplete;
      const message = page.messages["plugin:workboard"];
      expect(message?.kind).toBe("error");
      expect(message?.savedInstall).toBe(action === "reload" ? "workboard" : undefined);
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

it.each(["accept", "reconnect", "queued reconnect", "read-only config"] as const)(
  "keeps reload consent bound to its captured connection: %s",
  async (outcome) => {
    const inspection = createInspectResult();
    const { client, request } = createClient(async (method, params) => {
      if (method === "plugins.list") {
        return createResult();
      }
      if (method === "plugins.inspect") {
        return inspection;
      }
      if (method === "plugins.reload") {
        if (!(params as { acknowledgeCapabilities?: unknown }).acknowledgeCapabilities) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Capability review required",
            details: buildCapabilityConsentErrorDetails({
              pluginId: "workboard",
              reviewToken: inspection.reviewToken,
            }),
          });
        }
        return receipt;
      }
      if (method === "plugins.inspect") {
        return createInspectResult();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client);
    const runtime = createRuntimeConfigHarness(
      vi.fn(async () => undefined),
      { configFormDirty: false, lastError: null },
      () => client,
    );
    const mutationAllowed = outcome !== "read-only config";
    runtime.runtimeConfig.canSet = mutationAllowed;
    const { page } = await mountPage(
      createContext(harness.gateway, undefined, undefined, runtime),
      createPluginsRouteData(
        harness.gateway,
        { ...createResult(), mutationAllowed },
        createPluginsRouteLocation("/settings/plugins/workboard#lifecycle"),
      ),
    );
    page.querySelector<HTMLButtonElement>(".plugins-reload")!.click();
    if (!mutationAllowed) {
      await waitForFast(() =>
        expect(page.messages["plugin:workboard"]?.text).toContain("Capability review required"),
      );
      expect(page.messages["plugin:workboard"]?.kind).toBe("error");
      expect(page.querySelector('[data-plugin-consent="reload"]')).toBeNull();
      await page.consentController.mutateInstalledPlugin("workboard", "reload", undefined, {
        acknowledgeCapabilities: { reviewToken: inspection.reviewToken },
      });
      expect(request.mock.calls.filter(([method]) => method === "plugins.reload")).toEqual([
        ["plugins.reload", { plugins: [{ pluginId: "workboard" }] }],
      ]);
      return;
    }
    await waitForFast(() =>
      expect(
        page.querySelector('[data-plugin-consent="reload"] button.primary')?.textContent,
      ).toContain("Reload Workboard"),
    );
    const confirm = page.querySelector<HTMLButtonElement>(
      '[data-plugin-consent="reload"] button.primary',
    )!;
    if (outcome === "reconnect") {
      harness.emit(client, false);
      harness.emit(client, true);
      confirm.click();
      await page.updateComplete;
    } else if (outcome === "queued reconnect") {
      const queued = deferred<void>();
      const release = deferred<void>();
      const settled = deferred<void>();
      const run = runtime.runtimeConfig.runExternalMutation;
      runtime.runtimeConfig.runExternalMutation = async (task, options) => {
        queued.resolve();
        try {
          await release.promise;
          if (!options?.canDispatch?.()) {
            return {
              ok: false,
              reason: "unavailable",
              error: "Connection changed before dispatch",
            };
          }
          return await run(task, options);
        } finally {
          settled.resolve();
        }
      };
      confirm.click();
      await queued.promise;
      harness.emit(client, false);
      harness.emit(client, true);
      release.resolve();
      await settled.promise;
      await page.updateComplete;
    } else {
      confirm.click();
      await waitForFast(() =>
        expect(page.messages["plugin:workboard"]?.text).toContain("Gateway generation 7"),
      );
    }
    expect(request.mock.calls.filter(([method]) => method === "plugins.reload")).toEqual(
      outcome === "accept"
        ? [
            ["plugins.reload", { plugins: [{ pluginId: "workboard" }] }],
            [
              "plugins.reload",
              {
                plugins: [{ pluginId: "workboard" }],
                acknowledgeCapabilities: { reviewToken: inspection.reviewToken },
              },
            ],
          ]
        : [["plugins.reload", { plugins: [{ pluginId: "workboard" }] }]],
    );
    expect(
      request.mock.calls.some(
        ([method]) => method === "plugins.install" || method === "plugins.setEnabled",
      ),
    ).toBe(false);
  },
);

it.each(["method", "admin"] as const)(
  "rechecks current %s access after queued config work",
  async (access) => {
    const queued = deferred<void>();
    const release = deferred<void>();
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.list") {
        return createResult();
      }
      if (method === "plugins.inspect") {
        return createInspectResult();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client);
    const runtime = createRuntimeConfigHarness(
      vi.fn(async () => undefined),
      { configFormDirty: false, lastError: null },
      () => client,
    );
    const run = runtime.runtimeConfig.runExternalMutation;
    runtime.runtimeConfig.runExternalMutation = async (task, options) => {
      queued.resolve();
      await release.promise;
      if (options?.canDispatch && !options.canDispatch()) {
        return {
          ok: false,
          reason: "unavailable",
          error: "Plugin access changed before dispatch.",
        };
      }
      return run(task, options);
    };
    const { page } = await mountPage(
      createContext(harness.gateway, undefined, undefined, runtime),
      createPluginsRouteData(
        harness.gateway,
        createResult(),
        createPluginsRouteLocation("/settings/plugins/workboard#lifecycle"),
      ),
    );
    page.querySelector<HTMLButtonElement>(".plugins-reload")!.click();
    await queued.promise;
    const hello = harness.gateway.snapshot.hello!;
    harness.emit(client, true, {
      hello: {
        ...hello,
        ...(access === "admin"
          ? { auth: { role: "operator", scopes: ["operator.read"] } }
          : {
              features: {
                ...hello.features,
                methods: hello.features!.methods!.filter((method) => method !== "plugins.reload"),
              },
            }),
      },
    });
    release.resolve();
    await waitForFast(() =>
      expect(page.messages["plugin:workboard"]?.text).toContain(
        access === "admin"
          ? "Plugin access changed before dispatch."
          : "unavailable in the current Gateway runtime",
      ),
    );
    await page.updateComplete;
    const button = page.querySelector<HTMLButtonElement>(".plugins-reload")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.click();
    await page.updateComplete;
    expect(request.mock.calls.some(([method]) => method === "plugins.reload")).toBe(false);
  },
);
