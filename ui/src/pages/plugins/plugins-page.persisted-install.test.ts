/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
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
  createDiscoveryDetail,
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
      page.installWizardController.open(createDiscoveryDetail(available));
      page.installWizardController.begin();
      await waitForFast(() => expect(page.installWizard?.stage).toBe("error"));
      await page.updateComplete;
      const actionCalls = gatewayRequest.mock.calls.slice(actionStart);
      expect(actionCalls[0]).toEqual(["plugins.install", request]);
      const row = page.querySelector(".plugin-install-wizard")!;
      expect(row.textContent).toContain("Service could not bind its port");
      expect(row.textContent?.includes("Installation of calendar-runtime was saved")).toBe(saved);
      expect(row.textContent?.includes("Gateway has not applied it")).toBe(unapplied);
      expect(page.result?.plugins[0]?.installed).toBe(saved);
      expect(actionCalls.filter(([method]) => method === "config.get")).toHaveLength(saved ? 1 : 0);
      expect(actionCalls.filter(([method]) => method === "plugins.list")).toHaveLength(
        saved ? 1 : 0,
      );
      expect(runtimeConfig.state.configSnapshot?.hash).toBe(
        saved ? "saved-install" : "before-install",
      );
      if (saved) {
        expect(row.querySelector("button.primary")?.textContent).toContain("Reload");
        if ("runtime" in details) {
          expect(row.textContent).toContain("Runtime phase: activate.");
        }
      } else {
        expect(row.querySelector("button.primary")?.textContent).toContain("Try again");
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
  const { client, request: gatewayRequest } = createClient(async (method) => {
    if (method === "plugins.install") {
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
  inventoryFails = false;
  await page.refreshCatalog();
  expect(page.messages[alias]).toBeUndefined();
  expect(page.messages[rowKey]?.text).toContain("Plugin startup failed");
  present = false;
  await page.refreshCatalog();
  await page.updateComplete;
  expect(page.messages[rowKey]).toBeUndefined();
  await page.consentController.install(request, alias);
  expect(gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install")).toHaveLength(
    2,
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

it("refreshes stale inventory on retry after a successful install without installing again", async () => {
  let inventoryCurrent = false;
  const healthy = { ...installed, state: "enabled" as const };
  const { client, request: gatewayRequest } = createClient(async (method) => {
    if (method === "plugins.install") {
      return { ok: true, plugin: healthy, restartRequired: false };
    }
    if (method === "plugins.list") {
      return createResult(inventoryCurrent ? healthy : available);
    }
    if (method === "config.get") {
      return configSnapshot;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const harness = createGateway(client);
  const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
  const { page } = await mountPage(
    { ...createContext(harness.gateway), runtimeConfig },
    createPluginsRouteData(harness.gateway, createResult(available)),
  );
  try {
    await runtimeConfig.ensureLoaded();
    page.installWizardController.open(createDiscoveryDetail(available));
    page.installWizardController.begin();
    await waitForFast(() => expect(page.installWizard?.stage).toBe("error"));
    expect(page.installWizard).toMatchObject({
      pluginId: available.id,
      error: "The installed plugin was not found. Retry to refresh its state.",
    });
    expect(page.installWizard?.savedInstall).toBeUndefined();
    const listReads = gatewayRequest.mock.calls.filter(
      ([method]) => method === "plugins.list",
    ).length;
    inventoryCurrent = true;
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".plugin-install-wizard button.primary")!.click();
    await waitForFast(() => expect(page.installWizard?.stage).toBe("success"));
    expect(gatewayRequest.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(
      listReads + 1,
    );
    expect(
      gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install"),
    ).toHaveLength(1);
    expect(gatewayRequest.mock.calls.some(([method]) => method === "plugins.reload")).toBe(false);
  } finally {
    runtimeConfig.dispose();
  }
});

it.each(["button", "Escape"] as const)(
  "cancels saved-install reload consent with %s and preserves the saved installation",
  async (cancel) => {
    const { client, request: gatewayRequest } = createClient(async (method) => {
      if (method === "plugins.install") {
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Plugin startup failed",
          details: { persistence, runtime: runtimeFailure },
        });
      }
      if (method === "plugins.reload") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Capability review required",
          details: buildCapabilityConsentErrorDetails({
            pluginId: available.id,
            reviewToken: "saved-reload-review",
          }),
        });
      }
      if (method === "plugins.inspect") {
        return createInspectResult({ plugin: installed, reviewToken: "saved-reload-review" });
      }
      if (method === "plugins.list") {
        return createResult(installed);
      }
      if (method === "config.get") {
        return configSnapshot;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client);
    const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
    const { page } = await mountPage(
      { ...createContext(harness.gateway), runtimeConfig },
      createPluginsRouteData(harness.gateway, createResult(available)),
    );
    try {
      await runtimeConfig.ensureLoaded();
      page.installWizardController.open(createDiscoveryDetail(available));
      page.installWizardController.begin();
      await waitForFast(() => expect(page.installWizard?.savedInstall).toBe(true));
      await page.updateComplete;
      page.querySelector<HTMLButtonElement>(".plugin-install-wizard button.primary")!.click();
      await waitForFast(() =>
        expect(page.querySelector('[data-plugin-consent="reload"]')).not.toBeNull(),
      );
      await waitForFast(() => expect(page.busy[rowKey]).toBeUndefined());
      await page.updateComplete;
      expect(page.installWizard?.stage).toBe("reconnecting");
      if (cancel === "Escape") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } else {
        page.querySelector<HTMLButtonElement>(".plugins-consent__actions button")!.click();
      }
      await page.updateComplete;
      expect(page.querySelector("[data-plugin-consent]")).toBeNull();
      expect(page.installWizard).toMatchObject({
        stage: "error",
        savedInstall: true,
        pluginId: available.id,
      });
      const wizard = page.querySelector(".plugin-install-wizard")!;
      expect(wizard.querySelector("button.primary")?.textContent).toContain("Reload");
      expect(page.result?.plugins[0]?.installed).toBe(true);
      expect(
        gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install"),
      ).toHaveLength(1);
      expect(gatewayRequest.mock.calls.filter(([method]) => method === "plugins.reload")).toEqual([
        ["plugins.reload", { plugins: [{ pluginId: available.id }] }],
      ]);
      expect(wizard.textContent).toContain("Capability review was cancelled.");
      expect(wizard.textContent).not.toContain("The plugin was not installed.");
    } finally {
      runtimeConfig.dispose();
    }
  },
);
