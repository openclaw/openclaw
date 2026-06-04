import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginSessionActionRegistryRegistration } from "../../plugins/registry-types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { pluginHostHookHandlers } from "./plugin-host-hooks.js";

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("plugin host hook gateway handlers", () => {
  it("dispatches healthy plugin session actions after unreadable action metadata", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ id: "scope-plugin", status: "loaded" } as never);
    const staleAction = {
      pluginId: "scope-plugin",
      pluginName: "Scope Plugin",
      source: "test",
    } as PluginSessionActionRegistryRegistration;
    Object.defineProperty(staleAction, "action", {
      get() {
        throw new Error("plugin session action metadata getter exploded");
      },
    });
    registry.sessionActions = [
      staleAction,
      {
        pluginId: "scope-plugin",
        pluginName: "Scope Plugin",
        source: "test",
        action: {
          id: "approve",
          requiredScopes: ["operator.approvals"],
          handler: () => ({ result: { dispatched: true } }),
        },
      },
    ];
    setActivePluginRegistry(registry);

    const responses: Array<{ ok: boolean; payload?: unknown; error?: { code: string } }> = [];
    await pluginHostHookHandlers["plugins.sessionAction"]({
      params: { pluginId: "scope-plugin", actionId: "approve" },
      client: { connect: { scopes: ["operator.approvals"] } } as never,
      respond: (ok, payload, error) => responses.push({ ok, payload, error }),
      req: { id: 1, method: "plugins.sessionAction" } as never,
      context: {} as never,
      isWebchatConnect: () => false,
    });

    expect(responses).toEqual([
      { ok: true, payload: { ok: true, result: { dispatched: true } }, error: undefined },
    ]);
  });

  it("returns unavailable when no healthy plugin session action matches", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ id: "scope-plugin", status: "loaded" } as never);
    const staleAction = {
      pluginId: "scope-plugin",
      pluginName: "Scope Plugin",
      source: "test",
    } as PluginSessionActionRegistryRegistration;
    Object.defineProperty(staleAction, "action", {
      get() {
        throw new Error("plugin session action metadata getter exploded");
      },
    });
    registry.sessionActions = [staleAction];
    setActivePluginRegistry(registry);

    const responses: Array<{ ok: boolean; payload?: unknown; error?: { code: string } }> = [];
    await pluginHostHookHandlers["plugins.sessionAction"]({
      params: { pluginId: "scope-plugin", actionId: "missing" },
      client: { connect: { scopes: ["operator.approvals"] } } as never,
      respond: (ok, payload, error) => responses.push({ ok, payload, error }),
      req: { id: 1, method: "plugins.sessionAction" } as never,
      context: {} as never,
      isWebchatConnect: () => false,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0]?.ok).toBe(false);
    expect(responses[0]?.error?.code).toBe(ErrorCodes.UNAVAILABLE);
  });
});
