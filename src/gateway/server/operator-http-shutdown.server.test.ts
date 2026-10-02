import { expect, test, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/index.js";
import { installGatewayTestHooks, startServer } from "../test-helpers.js";
import type { OperatorHttpBeginResponse } from "./operator-http-contract.js";
import { GatewayOperatorHttpTransport } from "./operator-http-transport.js";

installGatewayTestHooks({ scope: "suite" });
await import("../server.js");

test("shutdown settles an unpolled startup rejection before draining connection work", async () => {
  const startup = await import("../server-startup-finish.js");
  const finishStartup = startup.finishGatewayStartup;
  const startupFixture = vi.spyOn(startup, "finishGatewayStartup").mockImplementation((params) =>
    finishStartup({
      ...params,
      kernelRuntime: { ...params.kernelRuntime, isGatewayStartupPending: () => true },
    }),
  );
  const delivery = vi.spyOn(GatewayOperatorHttpTransport.prototype, "sendWithContext");
  const rejectedTransport = () => {
    const index = delivery.mock.calls.findIndex((args) => args[2]?.rejectedHandshake);
    const transport = delivery.mock.contexts[index];
    return transport instanceof GatewayOperatorHttpTransport ? transport : undefined;
  };
  let started: Awaited<ReturnType<typeof startServer>> | undefined;
  let closing: Promise<void> | undefined;
  try {
    started = await startServer("shutdown-test-token");
    const base = `http://127.0.0.1:${started.port}/api/operator/connections`;
    const begin = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    expect(begin.status).toBe(201);
    const connection: OperatorHttpBeginResponse = await begin.json();
    const submitted = await fetch(`${base}/${connection.connectionId}/frames`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.connectionKey}`,
      },
      body: JSON.stringify({
        clientSeq: 1,
        ack: 0,
        frame: {
          type: "req",
          id: "connect",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: GATEWAY_CLIENT_IDS.TEST,
              mode: GATEWAY_CLIENT_MODES.TEST,
              version: "test",
              platform: "test",
            },
            role: "operator",
            scopes: [],
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(submitted.status).toBe(202);
    await submitted.json();
    await vi.waitFor(() => expect(rejectedTransport()?.bufferedAmount).toBeGreaterThan(0));
    const closed = vi.fn();
    closing = started.server.close().then(closed);
    // Shutdown must join without waiting for the absent peer's poll or idle expiry.
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(rejectedTransport()?.bufferedAmount).toBe(0);
  } finally {
    rejectedTransport()?.terminate();
    await closing;
    await started?.server.close();
    started?.envSnapshot.restore();
    delivery.mockRestore();
    startupFixture.mockRestore();
  }
});
