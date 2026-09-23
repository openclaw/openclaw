/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type { PluginInstallRequest } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createClient,
  createContext,
  createGateway,
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
const request: PluginInstallRequest = { source: "clawhub", packageName: "community-calendar" };
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

it.each([
  {
    name: "unpublished runtime",
    details: { persistence, runtime: runtimeFailure },
    saved: true,
    unapplied: true,
  },
  {
    name: "later failed attempt",
    details: {
      persistence,
      runtime: {
        operationId: "earlier-install",
        generation: 2,
        pluginIds: [available.id],
        committed: true,
      },
      runtimeAttempt: runtimeFailure,
    },
    saved: true,
    unapplied: false,
  },
  { name: "saved metadata failure", details: { persistence }, saved: true, unapplied: false },
  {
    name: "precommit rejection",
    details: { runtime: runtimeFailure },
    saved: false,
    unapplied: false,
  },
])(
  "reconciles $name without inventing runtime completion",
  async ({ details, saved, unapplied }) => {
    let installSaved = false;
    const { client, request: gatewayRequest } = createClient(async (method) => {
      if (method === "plugins.install") {
        installSaved = saved;
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Service could not bind its port",
          details,
        });
      }
      if (method === "plugins.list") {
        return createResult(installed);
      }
      if (method === "config.get") {
        return installSaved ? configSnapshot : initialConfigSnapshot;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client);
    const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
    const context = { ...createContext(harness.gateway), runtimeConfig };
    const { page } = await mountPage(
      context,
      createPluginsRouteData(
        harness.gateway,
        createResult(available),
        createPluginsRouteLocation("/settings/plugins"),
      ),
    );
    try {
      // Seed the same config owner used by the installer before the mutation.
      await runtimeConfig.ensureLoaded();
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("before-install");
      const actionStart = gatewayRequest.mock.calls.length;
      await page.consentController.install(request, rowKey);
      await page.updateComplete;
      const actionCalls = gatewayRequest.mock.calls.slice(actionStart);
      expect(actionCalls[0]).toEqual([
        "plugins.install",
        request,
        { onSent: expect.any(Function) },
      ]);
      const message = page.messages[rowKey]!;
      expect(message.text).toContain("Service could not bind its port");
      expect(message.text?.includes("Installation of calendar-runtime was saved")).toBe(saved);
      expect(message.text?.includes("Gateway has not applied it")).toBe(unapplied);
      expect(page.result?.plugins[0]?.installed).toBe(saved);
      expect(actionCalls.filter(([method]) => method === "config.get")).toHaveLength(saved ? 1 : 0);
      expect(actionCalls.filter(([method]) => method === "plugins.list")).toHaveLength(
        saved ? 1 : 0,
      );
      expect(runtimeConfig.state.configSnapshot?.hash).toBe(
        saved ? "saved-install" : "before-install",
      );
      expect(Boolean(message.savedInstall)).toBe(saved);
      if (saved && "runtime" in details) {
        expect(message.text).toContain("Runtime phase: activate.");
      }
      expect(
        gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install"),
      ).toHaveLength(1);
    } finally {
      runtimeConfig.dispose();
    }
  },
);

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
  await page.consentController.install(request, alias);
  await page.updateComplete;
  expect(page.messages[rowKey]?.text).toContain("Plugin startup failed");
  expect(page.messages[rowKey]?.text).toContain("Config refresh unavailable");
  expect(page.messages[alias]?.savedInstall).toBe(available.id);
  expect(page.messages[alias]?.installPolicyWarning).toBeUndefined();
  await page.consentController.install(request, alias);
  await page.consentController.install(request, rowKey);
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
  await page.consentController.install(request, alias);
  expect(gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install")).toHaveLength(
    3,
  );
  otherInstall.reject(new Error("Another registry is unavailable"));
  await installingOther;
  expect(page.messages[otherIdentity]?.text).toContain("Another registry is unavailable");
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
    const installing = page.consentController.install(request, rowKey);
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
