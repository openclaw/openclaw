/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { pathForPluginCatalogEntry } from "../../app-route-paths.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type { PluginMutationResult } from "../../lib/plugins/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  clickPluginAction,
  createClient,
  createContext,
  createDiscoveryDetail,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
  settlePlugins,
} from "./plugins-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
});
afterEach(resetPluginsPageTestState);

function rpc(handlers: Record<string, () => unknown>) {
  return createClient(async (method) => {
    if (!Object.hasOwn(handlers, method)) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handlers[method]();
  });
}

function snapshot(config: Record<string, unknown>, hash: string) {
  return {
    config,
    sourceConfig: config,
    hash,
    valid: true,
    raw: JSON.stringify(config),
    issues: [],
    path: "/synthetic/openclaw.json",
  };
}

async function mountRuntime(
  harness: ReturnType<typeof createGateway>,
  result: ReturnType<typeof createResult>,
  path: string,
) {
  const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
  const { page } = await mountPage(
    { ...createContext(harness.gateway), runtimeConfig },
    createPluginsRouteData(harness.gateway, result, createPluginsRouteLocation(path)),
  );
  return { page, runtimeConfig };
}

const spinner = ".plugin-catalog-detail__actions .btn__spinner";
const alert = '.plugins-row-message[role="alert"]';

const available = createPlugin({
  id: "calendar-runtime",
  name: "Calendar Plus",
  packageName: "community-calendar",
  origin: "official",
  installed: false,
  enabled: false,
  state: "not-installed",
  install: { source: "clawhub", packageName: "community-calendar" },
});
const installed = { ...available, installed: true, enabled: true, state: "error" as const };
const runtimeFailure = {
  operationId: "install-1",
  generation: 3,
  pluginIds: [available.id],
  phase: "activate",
  committed: false,
};
const persistence = { operation: "install", pluginId: available.id };
const initialConfigSnapshot = snapshot({}, "before-install");

it("retires saved-install refreshes when their Gateway owner is replaced", async () => {
  const catalog = createDiscoveryDetail(available);
  catalog.plugin.id = "catalog-calendar-runtime";
  const replacementCatalog = createDiscoveryDetail({ ...available, name: "Replacement Calendar" });
  replacementCatalog.plugin.id = catalog.plugin.id;
  const configRead = deferred<ReturnType<typeof snapshot>>();
  const catalogRead = deferred<ReturnType<typeof createResult>>();
  let installSaved = false;
  const { client, request: initialRequest } = rpc({
    "plugins.install": () => {
      installSaved = true;
      throw new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Old startup failed",
        details: { persistence, runtime: runtimeFailure },
      });
    },
    "config.get": () => (installSaved ? configRead.promise : initialConfigSnapshot),
    "plugins.list": () => catalogRead.promise,
    "plugins.catalog.get": () => catalog,
  });
  const replacementConfig = { ...initialConfigSnapshot, hash: "replacement-config" };
  const { client: replacement, request: replacementRequest } = rpc({
    "plugins.list": () => createResult(),
    "config.get": () => replacementConfig,
    "plugins.catalog.get": () => replacementCatalog,
  });
  const harness = createGateway(client);
  const { page, runtimeConfig } = await mountRuntime(
    harness,
    createResult(available),
    pathForPluginCatalogEntry(catalog.plugin.id),
  );
  try {
    await runtimeConfig.ensureLoaded();
    const actionStart = initialRequest.mock.calls.length;
    await clickPluginAction(page, "Install");
    await waitForSolid(() => {
      const actionCalls = initialRequest.mock.calls.slice(actionStart);
      expect(actionCalls).toContainEqual(["config.get", {}]);
      expect(actionCalls).toContainEqual(["plugins.list", {}, expect.anything()]);
    });
    harness.emit(replacement, true);
    await waitForSolid(() => {
      expect(page.querySelector("h1")?.textContent).toBe("Replacement Calendar");
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("replacement-config");
    });
    configRead.reject(new Error("Old config read failed"));
    catalogRead.resolve(createResult(installed));
    await settlePlugins();
    expect(page.querySelector("h1")?.textContent).toBe("Replacement Calendar");
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("replacement-config");
    expect(runtimeConfig.state.lastError).toBeNull();
    expect(page.querySelector(".plugins-row-message")).toBeNull();
    expect(page.textContent).not.toContain("Old startup failed");
    expect(page.textContent).not.toContain("Old config read failed");
    expect(replacementRequest).toHaveBeenCalledWith("config.get", {});
    expect(replacementRequest.mock.calls.some(([method]) => method === "plugins.install")).toBe(
      false,
    );
  } finally {
    runtimeConfig.dispose();
  }
});

describe("plugin runtime mutations", () => {
  const enablementConfig = { plugins: { entries: { workboard: { enabled: false } } } };
  const enablementSnapshot = snapshot(enablementConfig, "unchanged-config");
  const receipt: PluginMutationResult = {
    ok: true,
    plugin: createPlugin({ enabled: true, state: "enabled" }),
    restartRequired: false,
    runtime: { operationId: "enable-workboard", generation: 7, pluginIds: ["workboard"] },
  };

  it("reconciles enablement with publication during the mutation refresh", async () => {
    const enabling = deferred<PluginMutationResult>();
    const mutationConfig = deferred<typeof enablementSnapshot>();
    const mutationConfigStarted = deferred();
    let holdMutationConfig = false;
    let catalog = {
      ...createResult(createPlugin({ removable: true })),
      generation: 6,
    };
    const { client, request } = rpc({
      "config.get": () => {
        if (holdMutationConfig) {
          holdMutationConfig = false;
          mutationConfigStarted.resolve();
          return mutationConfig.promise;
        }
        return enablementSnapshot;
      },
      "plugins.list": () => catalog,
      "plugins.setEnabled": () => enabling.promise,
      "plugins.inspect": () => createInspectResult(),
    });
    const harness = createGateway(client);
    const reconnect = vi.spyOn(harness.gateway, "connect");
    const { page, runtimeConfig } = await mountRuntime(
      harness,
      catalog,
      "/settings/plugins/workboard#lifecycle",
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
      await clickPluginAction(page, "Enable Workboard");
      await waitForSolid(() =>
        expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
          pluginId: "workboard",
          enabled: true,
        }),
      );
      const busyButton = page.querySelector<HTMLButtonElement>('[aria-label="Enable Workboard"]');
      expect(busyButton?.getAttribute("aria-busy")).toBe("true");
      expect(busyButton?.querySelector(".btn__spinner")).not.toBeNull();
      expect(page.querySelectorAll(spinner)).toHaveLength(1);
      busyButton!.click();
      catalog = {
        ...catalog,
        generation: 7,
        plugins: [{ ...receipt.plugin, description: "Published plugin inventory" }],
      };
      holdMutationConfig = true;
      enabling.resolve(receipt);
      await mutationConfigStarted.promise;
      publish();
      await waitForSolid(() => {
        expect(page.querySelector(".plugin-catalog-detail__summary")?.textContent).toBe(
          "Published plugin inventory",
        );
      });
      mutationConfig.resolve(enablementSnapshot);
      await waitForSolid(() => {
        expect(page.querySelector(spinner)).toBeNull();
        expect(page.querySelector('[aria-label="Disable Workboard"]')).not.toBeNull();
      });
      expect(page.querySelector(".plugins-row-message")).toBeNull();
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
  });

  it.each([
    { action: "enable", applied: false },
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
        ...createResult(createPlugin({ enabled: action === "enable", state: "error" })),
        generation: applied === "earlier" ? 7 : 8,
      };
      const { client, request } = rpc({
        "config.get": () => enablementSnapshot,
        "plugins.list": () => refreshed,
        [methodName]: () => {
          throw error;
        },
        "plugins.inspect": () => createInspectResult(),
      });
      const harness = createGateway(client);
      const { page, runtimeConfig } = await mountRuntime(
        harness,
        createResult(
          createPlugin({
            enabled: action === "disable",
            state: action === "disable" ? "enabled" : "disabled",
          }),
        ),
        "/settings/plugins/workboard#lifecycle",
      );
      try {
        await runtimeConfig.ensureLoaded();
        const actionStart = request.mock.calls.length;
        await clickPluginAction(
          page,
          action === "enable" ? "Enable Workboard" : "Disable Workboard",
        );
        await waitForSolid(() => {
          expect(page.querySelector(alert)?.textContent).toContain(error.message);
          expect(page.querySelector(spinner)).toBeNull();
        });
        expect(page.querySelector(alert)?.textContent).toContain("Runtime phase: activate.");
        expect(page.textContent).not.toContain("Installation saved");
        const calls = request.mock.calls.slice(actionStart);
        expect(calls.filter(([method]) => method === methodName)).toHaveLength(1);
        expect(calls.filter(([method]) => method === "plugins.list")).toHaveLength(applied ? 1 : 0);
        expect(calls.filter(([method]) => method === "config.get")).toHaveLength(applied ? 1 : 0);
        expect(
          page.querySelector(
            `[aria-label="${applied && action === "enable" ? "Disable" : "Enable"} Workboard"]`,
          ),
        ).not.toBeNull();
        expect(page.querySelector(".plugins-install")).toBeNull();
      } finally {
        runtimeConfig.dispose();
      }
    },
  );
});
