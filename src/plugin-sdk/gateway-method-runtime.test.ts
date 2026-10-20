import { expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { dispatchGatewayMethod } from "./gateway-method-runtime.js";
import { createPluginRegistryFixture, registerVirtualTestPlugin } from "./plugin-test-contracts.js";

const { dispatchRaw } = vi.hoisted(() => ({ dispatchRaw: vi.fn() }));
vi.mock("../gateway/server-plugins.js", () => ({ dispatchGatewayMethodInProcessRaw: dispatchRaw }));

it.each([
  ["http", false, true],
  ["http", true, true],
  ["rpc", true, true],
  ["rpc", false, true],
  ["rpc", true, false],
] as const)(
  "binds %s dispatch to its contract (%s) and client (%s)",
  async (kind, entitled, hasClient) => {
    const http = kind === "http";
    const client = hasClient
      ? ({
          ...(http ? { id: "plugin" } : {}),
          connect: {
            scopes: [http ? (entitled ? "operator.admin" : "operator.write") : "operator.read"],
          },
        } as GatewayRequestHandlerOptions["client"])
      : null;
    const scope = {
      client,
      isWebchatConnect: () => false,
      pluginId: http ? "http-rpc" : undefined,
      gatewayMethodDispatchAllowed: http ? (entitled ? true : undefined) : true,
    };
    dispatchRaw.mockReset();
    dispatchRaw.mockImplementation(async () => {
      if (!http) {
        expect(getPluginRuntimeGatewayRequestScope()?.client).toBe(client);
      }
      return { ok: true, payload: { ok: true } };
    });
    let invoke: () => ReturnType<typeof dispatchGatewayMethod> | Promise<void> = () =>
      withPluginRuntimeGatewayRequestScope(scope, () =>
        dispatchGatewayMethod("health", {}, { timeoutMs: 500 }),
      );
    if (!http) {
      const { registry, config } = createPluginRegistryFixture();
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
      const requestScope = { ...scope, context: {} as never };
      invoke = async () =>
        withPluginRuntimeGatewayRequestScope(requestScope, () =>
          handler({
            ...requestScope,
            params: {},
            req: { type: "req", id: "reader-test", method: "reader.preview" },
            respond: vi.fn(),
          }),
        );
    }
    if (entitled && hasClient) {
      const result = await invoke();
      if (http) {
        expect(result).toEqual({ ok: true, payload: { ok: true } });
      }
      const options = { disableSyntheticClient: true, requireScopedClient: true };
      expect(dispatchRaw).toHaveBeenCalledWith(
        "health",
        {},
        http ? { ...options, timeoutMs: 500 } : options,
      );
    } else {
      await expect(invoke()).rejects.toThrow(
        http
          ? 'contracts.gatewayMethodDispatch: ["authenticated-request"] for plugin "http-rpc"'
          : "contracts.gatewayMethodDispatch",
      );
      expect(dispatchRaw).not.toHaveBeenCalled();
    }
  },
);
