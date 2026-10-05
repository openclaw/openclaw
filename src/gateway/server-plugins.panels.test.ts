import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../packages/gateway-protocol/src/client-info.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { uiCommandHandlers } from "./server-methods/ui-command.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

function createHarness(scope = "operator.write") {
  const registry = createEmptyPluginRegistry();
  const plugin = createPluginRecord({
    id: "review",
    source: "/synthetic/review/index.js",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  });
  registry.plugins.push(plugin);
  markPluginRegistryActive(registry);
  const requester = createOperatorClient({ profileName: "panel-requester", scopes: [scope] });
  requester.connect.client.id = GATEWAY_CLIENT_IDS.CONTROL_UI;
  requester.connect.caps = [GATEWAY_CLIENT_CAPS.UI_COMMANDS];
  const recipients = [
    requester,
    { ...requester, connId: "same-profile-other-tab" },
    {
      ...requester,
      connId: "other-profile-tab",
      authenticatedUserProfile: { ...requester.authenticatedUserProfile!, profileId: "other" },
    },
  ];
  const broadcastToConnIds = vi.fn<GatewayRequestContext["broadcastToConnIds"]>();
  let current = true;
  const context = createContext();
  context.getGatewayMethodRegistry = () => createRequestGatewayMethodRegistry();
  context.getClientConnIds = (predicate) =>
    new Set(
      (predicate ? recipients.filter(predicate) : recipients).map((client) => client.connId!),
    );
  context.broadcastToConnIds = broadcastToConnIds;
  const runtime = createPluginRuntime();
  const open = () =>
    withPluginRuntimeGatewayRequestScope(
      {
        context,
        client: requester,
        isWebchatConnect: () => false,
        hasCurrentClientAuthority: () => current,
      },
      () =>
        withPluginRuntimePluginScope(
          { pluginId: plugin.id, pluginOrigin: plugin.origin },
          () =>
            runtime.gateway.openPluginPanel({ panelId: "document", sessionKey: "agent:main:main" }),
          registry,
        ),
    );
  return {
    open,
    registry,
    plugin,
    requester,
    context,
    broadcastToConnIds,
    revoke: () => {
      current = false;
    },
    [Symbol.dispose]: () => markPluginRegistryRetired(registry),
  };
}

describe("plugin panel runtime through the Gateway router", () => {
  it("binds the plugin ID and delivers only to the requesting browser", async () => {
    using harness = createHarness();
    await expect(harness.open()).resolves.toEqual({ ok: true });
    expect(harness.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      "ui.command",
      {
        sessionKey: "agent:main:main",
        agentId: "main",
        command: {
          kind: "panel",
          panel: "plugin",
          pluginId: "review",
          panelId: "document",
          open: true,
        },
      },
      new Set([harness.requester.connId]),
    );
  });

  it.for([
    {
      change: "caller revoked",
      revoke: (h: ReturnType<typeof createHarness>) => h.revoke(),
      error: /authority/,
    },
    {
      change: "caller scopes downgraded",
      revoke: (h: ReturnType<typeof createHarness>) => {
        h.requester.connect.scopes = ["operator.read"];
      },
      error: /authority|scope/,
    },
    {
      change: "plugin retired",
      revoke: (h: ReturnType<typeof createHarness>) => markPluginRegistryRetired(h.registry),
      error: /current plugin runtime/,
    },
    {
      change: "plugin disabled",
      revoke: (h: ReturnType<typeof createHarness>) => {
        h.plugin.enabled = false;
      },
      error: /current plugin runtime/,
    },
    {
      change: "requester disconnected",
      revoke: (h: ReturnType<typeof createHarness>) => {
        h.requester.invalidated = true;
      },
      error: /authority|no longer connected/,
    },
  ])(
    "rejects $change during handler preparation without redirecting delivery",
    async ({ revoke, error }, { signal }) => {
      using harness = createHarness();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      // Keep the real method classification, authorization, router and final handler.
      // Only lazy loading is held so revocation happens after initial authorization.
      const handlers = createLazyCoreHandlers({
        methods: ["ui.command"],
        loadHandlers: async () => {
          entered.resolve();
          await release.promise;
          return uiCommandHandlers;
        },
      });
      const methods = createRequestGatewayMethodRegistry(handlers);
      harness.context.getGatewayMethodRegistry = () => methods;
      const pending = harness.open();
      const rejected = expect(pending).rejects.toThrow(error);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "panel request settled before preparation",
          ),
          signal,
        );
        expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
        revoke(harness);
      } finally {
        release.resolve();
      }
      await rejected;
      await expect(harness.open()).rejects.toThrow(error);
      expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
    },
  );
});
