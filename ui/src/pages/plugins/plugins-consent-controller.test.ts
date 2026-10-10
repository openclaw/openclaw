/* @vitest-environment jsdom */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import type { PluginInstallRequest, PluginListResult } from "../../lib/plugins/index.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { PluginRowMessage } from "./plugin-row-message.tsx";
import { PluginsConsentController } from "./plugins-consent-controller.ts";
import {
  createClient,
  createContext,
  createGateway,
  createPlugin,
  createResult,
} from "./plugins-page.test-support.ts";

beforeEach(() => i18n.setLocale("en"));

function createConsentHarness(
  client: GatewayBrowserClient,
  initialResult: PluginListResult,
  refreshConfig: ReturnType<typeof createContext>["runtimeConfig"]["refresh"],
) {
  const { gateway: applicationGateway } = createGateway(client);
  const controllers = new Set<ReactiveController>();
  const host: ReactiveControllerHost = {
    addController: (controller) => {
      controllers.add(controller);
    },
    removeController: (controller) => {
      controllers.delete(controller);
    },
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
  const gateway = new GatewayPageController(host, { getGateway: () => applicationGateway });
  for (const controller of controllers) {
    controller.hostConnected?.();
  }
  let result = initialResult;
  let messages: Record<string, PluginRowMessage> = {};
  const busy = new Set<string>();
  const context = createContext(applicationGateway, refreshConfig);
  const refreshCatalog = async () => {
    let next: PluginListResult;
    try {
      next = await client.request<PluginListResult>("plugins.list", {});
    } catch {
      // A failed inventory read leaves the previously admitted result intact.
      return;
    }
    messages = controller.reconcileInstallMessages(next);
    result = next;
  };
  const controller = new PluginsConsentController({
    gateway,
    getContext: () => context,
    getResult: () => result,
    canMutate: () => true,
    isBusy: (key) => busy.has(key),
    setBusy: (key, action) => {
      if (action) {
        busy.add(key);
      } else {
        busy.delete(key);
      }
    },
    setMessage: (key, message) => {
      if (message) {
        messages[key] = message;
      } else {
        delete messages[key];
      }
    },
    getMessages: () => messages,
    clearPageNotice: () => {},
    closeDetails: () => {},
    applyMutationResult: vi.fn(),
    refreshCatalogAfterMutation: refreshCatalog,
    requestUpdate: vi.fn(),
  });
  return {
    controller,
    get messages() {
      return messages;
    },
    refreshCatalog,
    dispose: () => {
      for (const registered of controllers) {
        registered.hostDisconnected?.();
      }
    },
  };
}

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
  const fixture = createConsentHarness(
    client,
    createResult(available),
    vi.fn(async () => {
      throw new Error("Config refresh unavailable");
    }),
  );
  const { controller } = fixture;
  try {
    const alias = "clawhub:community-calendar";
    await controller.install(installRequest, alias);
    expect(fixture.messages[rowKey]?.text).toContain("Plugin startup failed");
    expect(fixture.messages[rowKey]?.text).toContain("Config refresh unavailable");
    expect(fixture.messages[alias]?.savedInstall).toBe(available.id);
    expect(fixture.messages[alias]?.installPolicyWarning).toBeUndefined();
    await controller.install(installRequest, alias);
    await controller.install(installRequest, rowKey);
    expect(
      gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install"),
    ).toHaveLength(1);
    const otherIdentity = "npm:another-plugin";
    const installingOther = controller.install(otherRequest, otherIdentity);
    await waitForFast(() => {
      expect(controller.installProgress.has(otherIdentity)).toBe(true);
    });
    expect(controller.installProgress.get(alias)?.finishedAt).toBeTypeOf("number");
    expect(controller.installProgress.get(alias)?.canRetry).toBe(false);
    inventoryFails = false;
    await fixture.refreshCatalog();
    expect(controller.installProgress.has(alias)).toBe(false);
    expect(controller.installProgress.has(otherIdentity)).toBe(true);
    expect(controller.installProgress.get(otherIdentity)?.finishedAt).toBeUndefined();
    expect(fixture.messages[alias]).toBeUndefined();
    expect(fixture.messages[rowKey]?.text).toContain("Plugin startup failed");
    present = false;
    await fixture.refreshCatalog();
    expect(fixture.messages[rowKey]).toBeUndefined();
    await controller.install(installRequest, alias);
    expect(
      gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install"),
    ).toHaveLength(3);
    otherInstall.reject(new Error("Another registry is unavailable"));
    await installingOther;
    expect(fixture.messages[otherIdentity]?.text).toContain("Another registry is unavailable");
    expect(fixture.messages[otherIdentity]?.text).toContain(
      "Reconnect and check installed plugins",
    );
    expect(controller.installProgress.get(otherIdentity)?.failure?.title).toBe(
      "Installation status unknown",
    );
    expect(controller.installProgress.get(otherIdentity)?.canRetry).toBe(false);
    expect(controller.installProgress.get(otherIdentity)?.finishedAt).toBeTypeOf("number");
  } finally {
    fixture.dispose();
  }
});
