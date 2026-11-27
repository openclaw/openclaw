import { expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { makeGatewayClient } from "../gateway/server-request-context.test-support.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { dispatchGatewayMethod, sendToResolvedSession } from "./gateway-method-runtime.js";
import { createPluginRegistryFixture, registerVirtualTestPlugin } from "./plugin-test-contracts.js";

const { dispatchRaw } = vi.hoisted(() => ({ dispatchRaw: vi.fn() }));
// mock-isolation: Exercise dispatch authorization without booting the Gateway or loading its handlers.
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
        register(api) {
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
      } else {
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
    }
  },
);

const destination = { sessionKey: "agent:main:example", sessionId: "original" };
const send = { target: destination, message: "one turn", idempotencyKey: "request-1" };

it.each([
  [{ ok: true, payload: { status: "started", runId: "request-1" } }, "accepted"],
  [{ ok: true, payload: { status: "in_flight", runId: "request-1" } }, "accepted"],
  [{ ok: true, payload: { status: "started", runId: "other" } }, "unconfirmed"],
  [{ ok: true, payload: { status: "completed", runId: "request-1" } }, "unconfirmed"],
  [{ ok: true, payload: null }, "unconfirmed"],
  [
    { ok: false, error: { code: "INVALID_REQUEST", message: "The destination was replaced" } },
    "unconfirmed",
  ],
  [{ ok: false, error: { code: "FORBIDDEN" } }, "forbidden"],
  [new Error("response lost"), "unconfirmed"],
] as const)(
  "binds admission to a resolved target and its acknowledged request %#",
  async (reply, outcome) => {
    dispatchRaw.mockReset();
    if (reply instanceof Error) {
      dispatchRaw.mockRejectedValue(reply);
    } else {
      dispatchRaw.mockResolvedValue(reply);
    }
    const result = await withPluginRuntimeGatewayRequestScope(
      {
        client: makeGatewayClient({
          connId: "plugin",
          clientId: "test",
          scopes: ["operator.write"],
        }),
        gatewayMethodDispatchAllowed: true,
        isWebchatConnect: () => false,
      },
      () => sendToResolvedSession(send),
    );
    expect(result).toBe(outcome);
    expect(dispatchRaw).toHaveBeenCalledExactlyOnceWith(
      "chat.send",
      {
        sessionKey: destination.sessionKey,
        sessionId: destination.sessionId,
        expectedSessionId: destination.sessionId,
        message: send.message,
        idempotencyKey: send.idempotencyKey,
      },
      { disableSyntheticClient: true, requireScopedClient: true },
    );
  },
);

it("refuses a missing request scope or incomplete resolved target without dispatch", async () => {
  dispatchRaw.mockReset();
  await expect(sendToResolvedSession(send)).resolves.toBe("forbidden");
  await expect(
    sendToResolvedSession({ ...send, target: { ...destination, sessionId: "" } }),
  ).resolves.toBe("unconfirmed");
  expect(dispatchRaw).not.toHaveBeenCalled();
});
