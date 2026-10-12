import type {
  GatewayRequestHandlerOptions,
  OpenClawPluginApi as CorePluginApi,
} from "openclaw/plugin-sdk/core";
import type { GatewayRequestHandlers } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { dispatchGatewayMethod } from "./gateway-method-runtime.js";
/**
 * Tests gateway method runtime wrappers exposed to plugins.
 */
import { createPluginRegistryFixture, registerVirtualTestPlugin } from "./plugin-test-contracts.js";

const { dispatchGatewayMethodInProcessRaw } = vi.hoisted(() => ({
  dispatchGatewayMethodInProcessRaw: vi.fn(),
}));

vi.mock("../gateway/server-plugins.js", () => ({
  dispatchGatewayMethodInProcessRaw,
}));

describe("plugin-sdk/gateway-method-runtime", () => {
  it("shares the public registration contract without widening core callback handlers", () => {
    expectTypeOf<OpenClawPluginApi["registerGatewayMethod"]>().toEqualTypeOf<
      CorePluginApi["registerGatewayMethod"]
    >();
    expectTypeOf<
      ReturnType<GatewayRequestHandlers[string]>
    >().toEqualTypeOf<void | Promise<void>>();
  });

  it("rejects callers without the gateway method dispatch contract", async () => {
    await expect(
      withPluginRuntimeGatewayRequestScope(
        {
          pluginId: "plain-plugin",
          client: {
            id: "plugin",
            connect: { scopes: ["operator.write"] },
          } as never,
          isWebchatConnect: () => false,
        },
        () => dispatchGatewayMethod("health", {}),
      ),
    ).rejects.toThrow(
      'contracts.gatewayMethodDispatch: ["authenticated-request"] for plugin "plain-plugin"',
    );
    expect(dispatchGatewayMethodInProcessRaw).not.toHaveBeenCalled();
  });

  it("dispatches through the scoped client for entitled plugin HTTP routes", async () => {
    dispatchGatewayMethodInProcessRaw.mockResolvedValueOnce({ ok: true, payload: { ok: true } });

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        pluginId: "admin-http-rpc",
        gatewayMethodDispatchAllowed: true,
        client: {
          id: "plugin",
          connect: { scopes: ["operator.admin"] },
        } as never,
        isWebchatConnect: () => false,
      },
      () => dispatchGatewayMethod("health", {}, { timeoutMs: 500 }),
    );

    expect(result).toEqual({ ok: true, payload: { ok: true } });
    expect(dispatchGatewayMethodInProcessRaw).toHaveBeenCalledWith(
      "health",
      {},
      {
        disableSyntheticClient: true,
        requireScopedClient: true,
        timeoutMs: 500,
      },
    );
  });
  it.each([
    { entitled: true, client: true },
    { entitled: false, client: true },
    { entitled: true, client: false },
  ])(
    "keeps registered RPC dispatch caller-bound (contract=$entitled, client=$client)",
    async ({ entitled, client: hasClient }) => {
      dispatchGatewayMethodInProcessRaw.mockClear();
      const { registry, config } = createPluginRegistryFixture();
      const client = hasClient
        ? ({ connect: { scopes: ["operator.read"] } } as GatewayRequestHandlerOptions["client"])
        : null;
      dispatchGatewayMethodInProcessRaw.mockImplementation(async () => {
        expect(getPluginRuntimeGatewayRequestScope()?.client).toBe(client);
        return { ok: true, payload: { ok: true } };
      });
      registerVirtualTestPlugin({
        registry,
        config,
        id: "reader",
        name: "Reader",
        contracts: entitled ? { gatewayMethodDispatch: ["authenticated-request"] } : {},
        register(api: OpenClawPluginApi) {
          api.registerGatewayMethod(
            "reader.preview",
            async () => {
              const result = await dispatchGatewayMethod("health", {});
              return result.payload;
            },
            { scope: "operator.read" },
          );
        },
      });
      const handler = registry.registry.gatewayHandlers["reader.preview"];
      if (!handler) {
        throw new Error("Missing registered handler");
      }
      const respond = vi.fn();
      const invoke = () =>
        withPluginRuntimeGatewayRequestScope(
          {
            client,
            context: {} as never,
            isWebchatConnect: () => false,
            gatewayMethodDispatchAllowed: true,
          },
          () =>
            handler({
              client,
              context: {} as never,
              isWebchatConnect: () => false,
              params: {},
              req: { type: "req", id: "reader-test", method: "reader.preview" },
              respond,
            }),
        );
      if (entitled && hasClient) {
        await invoke();
        expect(dispatchGatewayMethodInProcessRaw).toHaveBeenCalledWith(
          "health",
          {},
          { disableSyntheticClient: true, requireScopedClient: true },
        );
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, { ok: true }, undefined, undefined);
      } else {
        await expect(invoke()).rejects.toThrow("contracts.gatewayMethodDispatch");
        expect(dispatchGatewayMethodInProcessRaw).not.toHaveBeenCalled();
        expect(respond).not.toHaveBeenCalled();
      }
    },
  );
});
