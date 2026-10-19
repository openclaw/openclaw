/* @vitest-environment jsdom */

import { createRoot, onCleanup } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayEventListener,
} from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import type {
  PluginInstallRequest,
  PluginListResult,
  PluginMutationResult,
} from "../../lib/plugins/index.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { PluginRowMessage } from "./plugin-row-message.tsx";
import { createPluginsConsent } from "./plugins-consent.ts";
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
  const gateway = new GatewayPageBinding(vi.fn(), {
    getGateway: () => applicationGateway,
  });
  gateway.connect();
  let result = initialResult;
  let messages: Record<string, PluginRowMessage> = {};
  const busy = new Set<string>();
  const context = createContext(applicationGateway, refreshConfig);
  const applyMutationResult = vi.fn();
  const refreshCatalog = async () => {
    let next: PluginListResult;
    try {
      next = await client.request<PluginListResult>("plugins.list", {});
    } catch {
      // A failed inventory read leaves the previously admitted result intact.
      return;
    }
    messages = consent.reconcileInstallMessages(next);
    result = next;
  };
  let consent!: ReturnType<typeof createPluginsConsent>;
  const dispose = createRoot((stop) => {
    onCleanup(() => gateway.dispose());
    consent = createPluginsConsent({
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
      applyMutationResult,
      refreshCatalogAfterMutation: refreshCatalog,
      onChange: () => {},
    });
    return stop;
  });
  return {
    consent,
    get messages() {
      return messages;
    },
    refreshCatalog,
    applyMutationResult,
    dispose,
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

it("correlates concurrent install progress and retires listeners on success and failure", async () => {
  const listeners = new Set<GatewayEventListener>();
  const firstResponse = deferred<PluginMutationResult>();
  const secondResponse = deferred<PluginMutationResult>();
  let nextRequest = 0;
  const request = createGatewayRequestMock(async (method, _params, options) => {
    if (method === "plugins.install") {
      const index = nextRequest++;
      options?.onSent?.(`request-${index}`);
      return index === 0 ? firstResponse.promise : secondResponse.promise;
    }
    if (method === "plugins.list") {
      return createResult(available);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  client.addEventListener = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const fixture = createConsentHarness(client, createResult(available), async () => undefined);
  const firstIdentity = "npm:one";
  const secondIdentity = "npm:two";
  const one = fixture.consent.install({ source: "npm", spec: "one" }, firstIdentity);
  const two = fixture.consent.install({ source: "npm", spec: "two" }, secondIdentity);
  const emit = (requestId: string, status = "started") => {
    for (const listener of listeners) {
      listener({
        type: "event",
        event: "plugins.install.progress",
        payload: { requestId, activityId: "activity", stage: "dependencies", status },
      });
    }
  };
  try {
    emit("request-1");
    expect(fixture.consent.read().installProgress.get(firstIdentity)?.activities).toEqual([]);
    expect(fixture.consent.read().installProgress.get(secondIdentity)?.activities).toEqual([
      {
        requestId: "request-1",
        activityId: "activity",
        stage: "dependencies",
        status: "started",
      },
    ]);
    emit("request-0");
    emit("request-0", "invented");
    expect(fixture.consent.read().installProgress.get(firstIdentity)?.activities).toEqual([
      {
        requestId: "request-0",
        activityId: "activity",
        stage: "dependencies",
        status: "started",
      },
    ]);
    const result: PluginMutationResult = {
      ok: true,
      plugin: createPlugin({ id: "one" }),
      restartRequired: false,
    };
    firstResponse.resolve(result);
    await one;
    expect(fixture.applyMutationResult).toHaveBeenCalledWith(result);
    emit("request-0", "completed");
    expect(fixture.consent.read().installProgress.has(firstIdentity)).toBe(false);
    expect(listeners.size).toBe(1);
    secondResponse.reject(new Error("registry unavailable"));
    await two;
    expect(fixture.messages[secondIdentity]?.text).toContain("registry unavailable");
    expect(listeners.size).toBe(0);
  } finally {
    fixture.dispose();
  }
});

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
  const { consent } = fixture;
  try {
    const alias = "clawhub:community-calendar";
    await consent.install(installRequest, alias);
    expect(fixture.messages[rowKey]?.text).toContain("Plugin startup failed");
    expect(fixture.messages[rowKey]?.text).toContain("Config refresh unavailable");
    expect(fixture.messages[alias]?.savedInstall).toBe(available.id);
    expect(fixture.messages[alias]?.installPolicyWarning).toBeUndefined();
    await consent.install(installRequest, alias);
    await consent.install(installRequest, rowKey);
    expect(
      gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install"),
    ).toHaveLength(1);
    const otherIdentity = "npm:another-plugin";
    const installingOther = consent.install(otherRequest, otherIdentity);
    await waitForSolid(() => {
      expect(consent.read().installProgress.has(otherIdentity)).toBe(true);
    });
    expect(consent.read().installProgress.get(alias)?.finishedAt).toBeTypeOf("number");
    expect(consent.read().installProgress.get(alias)?.canRetry).toBe(false);
    inventoryFails = false;
    await fixture.refreshCatalog();
    flush();
    expect(consent.read().installProgress.has(alias)).toBe(false);
    expect(consent.read().installProgress.has(otherIdentity)).toBe(true);
    expect(consent.read().installProgress.get(otherIdentity)?.finishedAt).toBeUndefined();
    expect(fixture.messages[alias]).toBeUndefined();
    expect(fixture.messages[rowKey]?.text).toContain("Plugin startup failed");
    present = false;
    await fixture.refreshCatalog();
    flush();
    expect(fixture.messages[rowKey]).toBeUndefined();
    await consent.install(installRequest, alias);
    expect(
      gatewayRequest.mock.calls.filter(([method]) => method === "plugins.install"),
    ).toHaveLength(3);
    otherInstall.reject(new Error("Another registry is unavailable"));
    await installingOther;
    flush();
    expect(fixture.messages[otherIdentity]?.text).toContain("Another registry is unavailable");
    expect(fixture.messages[otherIdentity]?.text).toContain(
      "Reconnect and check installed plugins",
    );
    expect(consent.read().installProgress.get(otherIdentity)?.failure?.title).toBe(
      "Installation status unknown",
    );
    expect(consent.read().installProgress.get(otherIdentity)?.canRetry).toBe(false);
    expect(consent.read().installProgress.get(otherIdentity)?.finishedAt).toBeTypeOf("number");
  } finally {
    fixture.dispose();
  }
});
