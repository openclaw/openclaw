/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { pathForPluginCatalogEntry } from "../../app-route-paths.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import type { PluginMutationResult } from "../../lib/plugins/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { pageFixture, runtimeFixture } from "./plugins-page.lifecycle-test-support.ts";
import {
  clickPluginAction,
  createDiscoveryDetail,
  createInspectResult,
  createPlugin,
  createResult,
  resetPluginsPageTestState,
  settlePlugins,
} from "./plugins-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
});
afterEach(resetPluginsPageTestState);

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
  const harness = runtimeFixture({
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
  const { client: replacement, request: replacementRequest } = pageFixture({
    "plugins.list": () => createResult(),
    "config.get": () => replacementConfig,
    "plugins.catalog.get": () => replacementCatalog,
  });
  const { request: initialRequest, runtimeConfig } = harness;
  const { page, find } = await harness.mount(
    pathForPluginCatalogEntry(catalog.plugin.id),
    createResult(available),
  );
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
    expect(find("h1")?.textContent).toBe("Replacement Calendar");
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("replacement-config");
  });
  configRead.reject(new Error("Old config read failed"));
  catalogRead.resolve(createResult(installed));
  await settlePlugins();
  expect(find("h1")?.textContent).toBe("Replacement Calendar");
  expect(runtimeConfig.state).toMatchObject({
    configSnapshot: { hash: "replacement-config" },
    lastError: null,
  });
  expect(find(".plugins-row-message")).toBeNull();
  expect(page.textContent).not.toMatch(/Old startup failed|Old config read failed/);
  expect(replacementRequest).toHaveBeenCalledWith("config.get", {});
  expect(replacementRequest.mock.calls.map(([method]) => method)).not.toContain("plugins.install");
});

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
  const harness = runtimeFixture({
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
  const { request, runtimeConfig } = harness;
  const reconnect = vi.spyOn(harness.gateway, "connect");
  const { page, find } = await harness.mount("/settings/plugins/workboard#lifecycle", catalog);
  await runtimeConfig.ensureLoaded();
  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
    }),
  );
  const busyButton = find<HTMLButtonElement>('[aria-label="Enable Workboard"]');
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
  harness.publishGeneration(7, ["plugins.setEnabled"]);
  await waitForSolid(() =>
    expect(find(".plugin-catalog-detail__summary")?.textContent).toBe("Published plugin inventory"),
  );
  mutationConfig.resolve(enablementSnapshot);
  await waitForSolid(() => {
    expect(find(spinner)).toBeNull();
    expect(find('[aria-label="Disable Workboard"]')).not.toBeNull();
  });
  expect(find(".plugins-row-message")).toBeNull();
  expect(harness.calls("plugins.setEnabled")).toHaveLength(1);
  expect(
    request.mock.calls.some(([method]) =>
      ["plugins.reload", "plugins.uninstall", "config.set", "config.patch"].includes(method),
    ),
  ).toBe(false);
  expect(reconnect).not.toHaveBeenCalled();
  expect(harness.gateway.snapshot.phase).toBe("connected");
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
    const harness = runtimeFixture({
      "config.get": () => enablementSnapshot,
      "plugins.list": () => refreshed,
      [methodName]: () => {
        throw error;
      },
      "plugins.inspect": () => createInspectResult(),
    });
    const { request, runtimeConfig } = harness;
    const { page, find } = await harness.mount(
      "/settings/plugins/workboard#lifecycle",
      createResult(
        createPlugin({
          enabled: action === "disable",
          state: action === "disable" ? "enabled" : "disabled",
        }),
      ),
    );
    await runtimeConfig.ensureLoaded();
    const actionStart = request.mock.calls.length;
    await clickPluginAction(page, action === "enable" ? "Enable Workboard" : "Disable Workboard");
    await waitForSolid(() => {
      expect(find(alert)?.textContent).toContain(error.message);
      expect(find(spinner)).toBeNull();
    });
    expect(find(alert)?.textContent).toContain("Runtime phase: activate.");
    expect(page.textContent).not.toContain("Installation saved");
    const calls = request.mock.calls.slice(actionStart);
    expect(calls.filter(([method]) => method === methodName)).toHaveLength(1);
    expect(calls.filter(([method]) => method === "plugins.list")).toHaveLength(applied ? 1 : 0);
    expect(calls.filter(([method]) => method === "config.get")).toHaveLength(applied ? 1 : 0);
    expect(
      find(`[aria-label="${applied && action === "enable" ? "Disable" : "Enable"} Workboard"]`),
    ).not.toBeNull();
    expect(find(".plugins-install")).toBeNull();
  },
);
