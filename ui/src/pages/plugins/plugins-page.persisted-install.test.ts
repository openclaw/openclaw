/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type { PluginInstallRequest, PluginMutationResult } from "../../lib/plugins/index.ts";
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

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
});
afterEach(resetPluginsPageTestState);

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
const installRequest: PluginInstallRequest = {
  source: "clawhub",
  packageName: "community-calendar",
};
const rowKey = "plugin:calendar-runtime";
const runtimeFailure = {
  operationId: "install-1",
  generation: 3,
  pluginIds: [available.id],
  phase: "activate",
  committed: false,
};
const persistence = { operation: "install", pluginId: available.id };
const config = { plugins: { entries: { [available.id]: { enabled: true } } } };
const configSnapshot = {
  config,
  sourceConfig: config,
  hash: "saved-install",
  valid: true,
  raw: JSON.stringify(config),
  issues: [],
  path: "/synthetic/openclaw.json",
};
const initialConfigSnapshot = {
  ...configSnapshot,
  config: {},
  sourceConfig: {},
  hash: "before-install",
  raw: "{}",
};

it("blocks repeat install when saved-state reads fail, then reconciles aliases and later removal", async () => {
  let inventoryFails = true;
  let present = true;
  const otherInstall = deferred<never>();
  const otherRequest: PluginInstallRequest = { source: "npm", spec: "another-plugin" };
  const { client, request: gatewayRequest } = createClient(async (method, params) => {
    if (method === "plugins.install") {
      if (params === otherRequest) {
        return otherInstall.promise;
      }
      throw new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Plugin startup failed",
        details: {
          persistence,
          runtime: runtimeFailure,
          installPolicyCode: "install_policy_warning_acknowledgement_required",
          targetName: "community-calendar",
          targetType: "plugin",
          requestMode: "install",
          reason: "Do not retry a saved installation",
        },
      });
    }
    if (method === "plugins.list") {
      if (inventoryFails) {
        throw new Error("Catalog refresh unavailable");
      }
      return createResult(present ? installed : available);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const harness = createGateway(client);
  const refreshConfig = vi.fn(async () => {
    throw new Error("Config refresh unavailable");
  });
  const { page } = await mountPage(
    createContext(harness.gateway, refreshConfig),
    createPluginsRouteData(
      harness.gateway,
      createResult(available),
      createPluginsRouteLocation("/settings/plugins"),
    ),
  );
  const alias = "clawhub:community-calendar";
  await page.consentController.install(installRequest, alias);
  await page.updateComplete;
  expect(page.messages[rowKey]?.text).toContain("Plugin startup failed");
  expect(page.messages[rowKey]?.text).toContain("Config refresh unavailable");
  expect(page.messages[alias]?.savedInstall).toBe(available.id);
  expect(page.messages[alias]?.installPolicyWarning).toBeUndefined();
  await page.consentController.install(installRequest, alias);
  await page.consentController.install(installRequest, rowKey);
  expect(gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install")).toHaveLength(
    1,
  );
  const otherIdentity = "npm:another-plugin";
  const installingOther = page.consentController.install(otherRequest, otherIdentity);
  await waitForFast(() => {
    expect(page.consentController.installProgress.has(otherIdentity)).toBe(true);
  });
  expect(page.consentController.installProgress.get(alias)?.finishedAt).toBeTypeOf("number");
  expect(page.consentController.installProgress.get(alias)?.canRetry).toBe(false);
  inventoryFails = false;
  await page.refreshCatalog();
  expect(page.consentController.installProgress.has(alias)).toBe(false);
  expect(page.consentController.installProgress.has(otherIdentity)).toBe(true);
  expect(page.consentController.installProgress.get(otherIdentity)?.finishedAt).toBeUndefined();
  expect(page.messages[alias]).toBeUndefined();
  expect(page.messages[rowKey]?.text).toContain("Plugin startup failed");
  present = false;
  await page.refreshCatalog();
  await page.updateComplete;
  expect(page.messages[rowKey]).toBeUndefined();
  await page.consentController.install(installRequest, alias);
  expect(gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install")).toHaveLength(
    3,
  );
  otherInstall.reject(new Error("Another registry is unavailable"));
  await installingOther;
  expect(page.messages[otherIdentity]?.text).toContain("Another registry is unavailable");
  expect(page.messages[otherIdentity]?.text).toContain("Reconnect and check installed plugins");
  expect(page.consentController.installProgress.get(otherIdentity)?.failure?.title).toBe(
    "Installation status unknown",
  );
  expect(page.consentController.installProgress.get(otherIdentity)?.canRetry).toBe(false);
  expect(page.consentController.installProgress.get(otherIdentity)?.finishedAt).toBeTypeOf(
    "number",
  );
});

it("retires saved-install refreshes when their Gateway owner is replaced", async () => {
  const configRead = deferred<typeof configSnapshot>();
  const catalogRead = deferred<ReturnType<typeof createResult>>();
  let installSaved = false;
  const { client, request: initialRequest } = createClient(async (method) => {
    if (method === "plugins.install") {
      installSaved = true;
      throw new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Old startup failed",
        details: { persistence, runtime: runtimeFailure },
      });
    }
    if (method === "config.get") {
      return installSaved ? configRead.promise : initialConfigSnapshot;
    }
    if (method === "plugins.list") {
      return catalogRead.promise;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const replacementConfig = { ...initialConfigSnapshot, hash: "replacement-config" };
  const { client: replacement, request: replacementRequest } = createClient(async (method) => {
    if (method === "plugins.list") {
      return createResult();
    }
    if (method === "config.get") {
      return replacementConfig;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const harness = createGateway(client);
  const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
  const { page } = await mountPage(
    { ...createContext(harness.gateway), runtimeConfig },
    createPluginsRouteData(
      harness.gateway,
      createResult(available),
      createPluginsRouteLocation("/settings/plugins"),
    ),
  );
  try {
    await runtimeConfig.ensureLoaded();
    const actionStart = initialRequest.mock.calls.length;
    const installing = page.consentController.install(installRequest, rowKey);
    await waitForFast(() => {
      const actionCalls = initialRequest.mock.calls.slice(actionStart);
      expect(actionCalls).toContainEqual(["config.get", {}]);
      expect(actionCalls).toContainEqual(["plugins.list", {}, expect.anything()]);
    });
    harness.emit(replacement, true);
    await waitForFast(() => {
      expect(page.result?.plugins[0]?.id).toBe("workboard");
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("replacement-config");
    });
    configRead.reject(new Error("Old config read failed"));
    catalogRead.resolve(createResult(installed));
    await installing;
    await page.updateComplete;
    expect(page.result?.plugins[0]?.id).toBe("workboard");
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("replacement-config");
    expect(runtimeConfig.state.lastError).toBeNull();
    expect(page.messages).toEqual({});
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
  const enablementSnapshot = {
    config: enablementConfig,
    sourceConfig: enablementConfig,
    hash: "unchanged-config",
    raw: JSON.stringify(enablementConfig),
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

  it("reconciles enablement with publication during the mutation refresh", async () => {
    const enabling = deferred<PluginMutationResult>();
    const mutationConfig = deferred<typeof enablementSnapshot>();
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
        return enablementSnapshot;
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
      holdMutationConfig = true;
      enabling.resolve(receipt);
      await mutationConfigStarted.promise;
      publish();
      await waitForFast(() => expect(page.result?.generation).toBe(7));
      mutationConfig.resolve(enablementSnapshot);
      await waitForFast(() => expect(page.busy["plugin:workboard"]).toBeUndefined());
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
        ...createResult(createPlugin({ state: "error" })),
        generation: applied === "earlier" ? 7 : 8,
      };
      const { client, request } = createClient(async (method) => {
        if (method === "config.get") {
          return enablementSnapshot;
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
});
