import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import type { GatewayMethodRegistry } from "../methods/registry.js";
import { WRITE_SCOPE } from "../operator-scopes.js";
import { pluginHostHookHandlers } from "./plugin-host-hooks.js";
import type { RespondFn } from "./response-types.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const pluginId = "swap-actions";

function createActionRegistry(instance: PluginInstance, label: string): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: pluginId, status: "loaded" }));
  registry.sessionActions = [
    {
      pluginId,
      pluginName: pluginId,
      source: "test",
      action: { id: "describe", handler: instance.wrap(() => ({ result: { label } })) },
    },
  ] as PluginRegistry["sessionActions"];
  return registry;
}

// Gateway requests stay pinned to the registry they were admitted with, while the
// attached method registry follows reload publication.
function dispatchSessionAction(
  respond: RespondFn,
  admitted: PluginRegistry,
  attached: { pluginRegistry: PluginRegistry },
) {
  return withPluginRuntimeGatewayRequestScope(
    { pluginRegistry: admitted, isWebchatConnect: () => false },
    () =>
      pluginHostHookHandlers["plugins.sessionAction"]!({
        req: { id: "swap", type: "req", method: "plugins.sessionAction" },
        params: { pluginId, actionId: "describe" },
        client: { connect: { role: "operator", scopes: [WRITE_SCOPE] } } as GatewayClient,
        isWebchatConnect: () => false,
        respond,
        context: {
          getRuntimeConfig: () => ({}),
          getGatewayMethodRegistry: () => attached as GatewayMethodRegistry,
        } as unknown as GatewayRequestContext,
      }),
  );
}

describe("plugins.sessionAction during a plugin reload", () => {
  afterEach(() => clearActivePluginRegistry());

  it("waits for the reload and runs the published action", async () => {
    const previous = new PluginInstance(pluginId);
    const current = new PluginInstance(pluginId);
    const previousRegistry = createActionRegistry(previous, "previous");
    const attached = { pluginRegistry: previousRegistry };
    setActivePluginRegistry(previousRegistry);
    const release = previous.reserveReplacement();
    previous.quiesce();
    const respond = vi.fn<RespondFn>();

    const dispatched = dispatchSessionAction(respond, previousRegistry, attached);
    await setImmediate();
    expect(respond).not.toHaveBeenCalled();
    attached.pluginRegistry = createActionRegistry(current, "current");
    setActivePluginRegistry(attached.pluginRegistry);
    release();
    await dispatched;

    expect(respond.mock.calls).toEqual([[true, { ok: true, result: { label: "current" } }]]);
  });

  it("reports a retryable plugin-reloading outage when a second reload refuses it", async () => {
    const previous = new PluginInstance(pluginId);
    const previousRegistry = createActionRegistry(previous, "previous");
    setActivePluginRegistry(previousRegistry);
    const release = previous.reserveReplacement();
    previous.quiesce();
    const respond = vi.fn<RespondFn>();

    const dispatched = dispatchSessionAction(respond, previousRegistry, {
      pluginRegistry: previousRegistry,
    });
    await setImmediate();
    release();
    previous.reserveReplacement();
    await dispatched;

    expect(respond.mock.calls).toHaveLength(1);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
      details: { reason: "plugin-reloading" },
    });
  });
});
