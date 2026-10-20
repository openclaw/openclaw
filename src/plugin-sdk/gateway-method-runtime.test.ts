import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { dispatchGatewayMethod } from "./gateway-method-runtime.js";
import { createPluginRegistryFixture, registerVirtualTestPlugin } from "./plugin-test-contracts.js";

const { dispatchGatewayMethodInProcessRaw } = vi.hoisted(() => ({
  dispatchGatewayMethodInProcessRaw: vi.fn(),
}));

vi.mock("../gateway/server-plugins.js", () => ({
  dispatchGatewayMethodInProcessRaw,
}));

describe("plugin-sdk/gateway-method-runtime", () => {
  it.each([false, true])(
    "requires the HTTP route dispatch contract (entitled=%s)",
    async (entitled) => {
      dispatchGatewayMethodInProcessRaw.mockReset();
      dispatchGatewayMethodInProcessRaw.mockResolvedValueOnce({ ok: true, payload: { ok: true } });
      const result = withPluginRuntimeGatewayRequestScope(
        {
          pluginId: "http-rpc",
          gatewayMethodDispatchAllowed: entitled ? true : undefined,
          client: {
            id: "plugin",
            connect: { scopes: [entitled ? "operator.admin" : "operator.write"] },
          } as never,
          isWebchatConnect: () => false,
        },
        () => dispatchGatewayMethod("health", {}, { timeoutMs: 500 }),
      );
      if (!entitled) {
        await expect(result).rejects.toThrow(
          'contracts.gatewayMethodDispatch: ["authenticated-request"] for plugin "http-rpc"',
        );
        expect(dispatchGatewayMethodInProcessRaw).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toEqual({ ok: true, payload: { ok: true } });
        expect(dispatchGatewayMethodInProcessRaw).toHaveBeenCalledWith(
          "health",
          {},
          {
            disableSyntheticClient: true,
            requireScopedClient: true,
            timeoutMs: 500,
          },
        );
      }
    },
  );
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
        register(api) {
          api.registerGatewayMethod(
            "reader.preview",
            async () => {
              await dispatchGatewayMethod("health", {});
            },
            { scope: "operator.read" },
          );
        },
      });
      const handler = registry.registry.gatewayHandlers["reader.preview"];
      if (!handler) {
        throw new Error("Missing registered handler");
      }
      const scope = {
        client,
        context: {} as never,
        isWebchatConnect: () => false,
      };
      const invoke = () =>
        withPluginRuntimeGatewayRequestScope({ ...scope, gatewayMethodDispatchAllowed: true }, () =>
          handler({
            ...scope,
            params: {},
            req: { type: "req", id: "reader-test", method: "reader.preview" },
            respond: vi.fn(),
          }),
        );
      if (entitled && hasClient) {
        await invoke();
        expect(dispatchGatewayMethodInProcessRaw).toHaveBeenCalledWith(
          "health",
          {},
          { disableSyntheticClient: true, requireScopedClient: true },
        );
      } else {
        await expect(invoke()).rejects.toThrow("contracts.gatewayMethodDispatch");
        expect(dispatchGatewayMethodInProcessRaw).not.toHaveBeenCalled();
      }
    },
  );
});
