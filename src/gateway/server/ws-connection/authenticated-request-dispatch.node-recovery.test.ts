import { expect, it, vi } from "vitest";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
  requestFrame,
} from "./authenticated-request-dispatch.test-support.js";

vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", () => ({
  handleGatewayRequest: async ({ respond }: GatewayRequestOptions) => {
    respond(false, undefined, {
      code: "UNAVAILABLE",
      message: "node pairing changed before request dispatch",
      details: { code: "PAIRING_CHANGED" },
      retryable: true,
    });
  },
}));

it.each([
  { registeredConnection: "replacement", retired: true },
  { registeredConnection: undefined, retired: true },
  { registeredConnection: "current", retired: false },
])(
  "retires only obsolete pairing rejections (registered: $registeredConnection)",
  async ({ registeredConnection, retired }) => {
    const client = createOperatorWsClient({ connId: "current" });
    client.connect.role = "node";
    const get = vi.fn(() => (registeredConnection ? { connId: registeredConnection } : undefined));
    const harness = createDispatchTestHarness({
      connId: client.connId,
      buildRequestContext: () => ({ getRuntimeConfig: () => ({}), nodeRegistry: { get } }),
    });
    await harness.dispatcher.dispatch(requestFrame("rejected", "node.event"), client);
    expect(await harness.awaitResponseFrame("rejected")).toMatchObject({
      ok: false,
      error: { details: { code: "PAIRING_CHANGED" } },
    });
    if (retired) {
      expect(harness.close).toHaveBeenCalledExactlyOnceWith(
        4001,
        "node pairing changed; reconnect",
      );
      expect(harness.send).toHaveBeenCalledBefore(harness.close);
    } else {
      // Unavailable pairing storage or a promoted lease does not revoke this socket.
      expect(harness.close).not.toHaveBeenCalled();
    }
  },
);
