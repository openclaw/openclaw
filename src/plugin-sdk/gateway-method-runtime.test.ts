import type { OpenClawPluginApi as CorePluginApi } from "openclaw/plugin-sdk/core";
import type { GatewayRequestHandlers } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { expect, expectTypeOf, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { dispatchGatewayMethod } from "./gateway-method-runtime.js";
import { createPluginRegistryFixture, registerVirtualTestPlugin } from "./plugin-test-contracts.js";

const { dispatchRaw } = vi.hoisted(() => ({ dispatchRaw: vi.fn() }));
// mock-isolation: Exercise dispatch authorization without booting the Gateway or loading its handlers.
vi.mock("../gateway/server-plugins.js", () => ({ dispatchGatewayMethodInProcessRaw: dispatchRaw }));

it("shares the public registration contract without widening core callback handlers", () => {
  expectTypeOf<OpenClawPluginApi["registerGatewayMethod"]>().toEqualTypeOf<
    CorePluginApi["registerGatewayMethod"]
  >();
  expectTypeOf<ReturnType<GatewayRequestHandlers[string]>>().toEqualTypeOf<void | Promise<void>>();
});

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
    const respond = vi.fn();
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
        register(api: OpenClawPluginApi) {
          api.registerGatewayMethod(
            "reader.preview",
            async () => (await dispatchGatewayMethod("health", {})).payload,
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
            respond,
          }),
        );
    }
    if (entitled && hasClient) {
      const result = await invoke();
      if (http) {
        expect(result).toEqual({ ok: true, payload: { ok: true } });
      }
      if (!http) {
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, { ok: true }, undefined, undefined);
      }
      const options = { disableSyntheticClient: true, requireScopedClient: true };
      expect(dispatchRaw).toHaveBeenCalledWith(
        "health",
        {},
        http ? { ...options, timeoutMs: 500 } : options,
      );
    } else {
      await expect(invoke()).rejects.toThrow("contracts.gatewayMethodDispatch");
      expect(dispatchRaw).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
    }
  },
);
