import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSessionActionRegistration } from "../../plugins/host-hooks.js";
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

function createActionRegistry(
  instance: PluginInstance,
  label: string,
  handler: PluginSessionActionRegistration["handler"] = () => ({ result: { label } }),
): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: pluginId, status: "loaded" }));
  registry.sessionActions = [
    {
      pluginId,
      pluginName: pluginId,
      source: "test",
      action: { id: "describe", handler: instance.wrap(handler) },
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
  payload?: { privateValue: string },
) {
  return withPluginRuntimeGatewayRequestScope(
    { pluginRegistry: admitted, isWebchatConnect: () => false },
    () =>
      pluginHostHookHandlers["plugins.sessionAction"]!({
        req: { id: "swap", type: "req", method: "plugins.sessionAction" },
        params: { pluginId, actionId: "describe", ...(payload ? { payload } : {}) },
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
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearActivePluginRegistry();
  });

  it.each(["success", "application-error", "dispatch-error"] as const)(
    "attributes %s outside the wire response without copying private content",
    async (actionOutcome) => {
      let now = 100;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const privateValue = "private-action-content";
      const result =
        actionOutcome === "success"
          ? { result: { privateValue }, reply: { privateValue }, continueAgent: true }
          : {
              ok: false as const,
              error: privateValue,
              code: "PRIVATE_CODE",
              details: { privateValue },
            };
      const registry = createActionRegistry(new PluginInstance(pluginId), "current", (context) => {
        expect(context.payload).toEqual({ privateValue });
        now = 125.6;
        if (actionOutcome === "dispatch-error") {
          throw new Error(privateValue);
        }
        return result;
      });
      setActivePluginRegistry(registry);
      const respond = vi.fn<RespondFn>();

      await dispatchSessionAction(
        respond,
        registry,
        { pluginRegistry: registry },
        { privateValue },
      );

      expect(respond).toHaveBeenCalledOnce();
      const [ok, payload, error, meta] = respond.mock.calls[0]!;
      expect({ ok, payload, error }).toEqual(
        actionOutcome === "dispatch-error"
          ? {
              ok: false,
              payload: undefined,
              error: { code: "UNAVAILABLE", message: "plugin session action failed" },
            }
          : { ok: true, payload: { ok: true, ...result }, error: undefined },
      );
      expect(meta).toEqual({
        pluginId,
        actionId: "describe",
        actionOutcome,
        handlerMs: 26,
        reloadWaitMs: 0,
      });
    },
  );

  it("waits for the reload and runs the published action", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
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
    attached.pluginRegistry = createActionRegistry(current, "current", () => {
      now = 155.8;
      return { result: { label: "current" } };
    });
    setActivePluginRegistry(attached.pluginRegistry);
    now = 130.4;
    release();
    await dispatched;

    expect(respond).toHaveBeenCalledOnce();
    const [ok, payload, error, meta] = respond.mock.calls[0]!;
    expect({ ok, payload, error }).toEqual({
      ok: true,
      payload: { ok: true, result: { label: "current" } },
      error: undefined,
    });
    expect(meta).toEqual({
      pluginId,
      actionId: "describe",
      actionOutcome: "success",
      handlerMs: 25,
      reloadWaitMs: 30,
    });
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
