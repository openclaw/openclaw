import { expect, it, vi } from "vitest";
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
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { uiCommandHandlers } from "./server-methods/ui-command.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import { heldWork } from "./server-plugin-reload.fixture-tools.test-support.js";

function createHarness() {
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
  const requester = createOperatorClient({
    profileName: "panel-requester",
    scopes: ["operator.write"],
  });
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
  const openPanel = () =>
    runtime.gateway.openPluginPanel({ panelId: "document", sessionKey: "agent:main:main" });
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
          openPanel,
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

it("binds the plugin ID and delivers only to the requesting browser", async () => {
  using harness = createHarness();
  await expect(harness.open()).resolves.toEqual({ ok: true });
  const command = {
    kind: "panel",
    panel: "plugin",
    pluginId: "review",
    panelId: "document",
    open: true,
  };
  expect(harness.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
    "ui.command",
    { sessionKey: "agent:main:main", agentId: "main", command },
    new Set([harness.requester.connId]),
  );
});

it.for<[string, (h: ReturnType<typeof createHarness>) => void, RegExp]>([
  ["caller revoked", (h) => h.revoke(), /authority/],
  [
    "caller scopes downgraded",
    (h) => Object.assign(h.requester.connect, { scopes: ["operator.read"] }),
    /authority|scope/,
  ],
  ["plugin retired", (h) => markPluginRegistryRetired(h.registry), /current plugin runtime/],
  ["plugin disabled", (h) => Object.assign(h.plugin, { enabled: false }), /current plugin runtime/],
  [
    "requester disconnected",
    (h) => Object.assign(h.requester, { invalidated: true }),
    /authority|no longer connected/,
  ],
])(
  "rejects %s during handler preparation without redirecting delivery",
  async ([, revoke, error], { signal }) => {
    using harness = createHarness();
    const gate = heldWork();
    // Hold only loading: revocation must cross the real router's authorization boundary.
    const handlers = createLazyCoreHandlers({
      methods: ["ui.command"],
      loadHandlers: async () => {
        await gate.run();
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
          gate.entered,
          pending,
          "panel request settled before preparation",
        ),
        signal,
      );
      expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
      revoke(harness);
    } finally {
      gate.release();
    }
    await rejected;
    await expect(harness.open()).rejects.toThrow(error);
    expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
  },
);
