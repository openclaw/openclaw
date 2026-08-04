import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { runSystemAgentGatewayOwnerTask } from "../../server-methods/system-agent-execution-lifecycle.js";
import { disposeSystemAgentSessionsForOwner } from "../../server-methods/system-agent-session-disposal.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import type { GatewayWsClient } from "../ws-types.js";
import { createGatewayAuthenticatedRequestDispatcher } from "./authenticated-request-dispatch.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

const lazyRuntime = vi.hoisted(() => {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, handleGatewayRequest: vi.fn(), markStarted, release, started };
});

vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", async () => {
  lazyRuntime.markStarted();
  await lazyRuntime.gate;
  return { handleGatewayRequest: lazyRuntime.handleGatewayRequest };
});

describe("system-agent authenticated request admission", () => {
  it("retires valid and malformed connection-owned frames during lazy method loading", async () => {
    const sessions: GatewayRequestContext["systemAgentSessions"] = new Map();
    const context = { systemAgentSessions: sessions } as GatewayRequestContext;
    const send = vi.fn();
    const client = {
      socket: {} as WebSocket,
      connId: "connection-lazy-load",
      usesSharedGatewayAuth: false,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: "gateway-client",
          version: "dev",
          platform: "test",
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.admin"],
      },
    } as GatewayWsClient;
    const dispatcher = createGatewayAuthenticatedRequestDispatcher({
      handler: {
        connId: client.connId,
        extraHandlers: {},
        buildRequestContext: () => context,
        send,
        close: vi.fn(),
        isClosed: () => false,
        setCloseCause: vi.fn(),
        logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as unknown as GatewayWsMessageHandlerParams,
      isWebchatConnect: () => false,
    });

    await dispatcher.dispatch(
      {
        type: "req",
        id: "late-system-agent-frame",
        method: "openclaw.chat",
        params: { sessionId: "late-session" },
      },
      client,
    );
    await dispatcher.dispatch(
      {
        type: "req",
        id: "malformed-delegation-frame",
        method: "openclaw.chat",
        params: { sessionId: "late-session", delegation: "not-an-object" },
      },
      client,
    );
    await lazyRuntime.started;

    await disposeSystemAgentSessionsForOwner(sessions, `connection:${client.connId}`);
    lazyRuntime.release();

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(lazyRuntime.handleGatewayRequest).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "late-system-agent-frame",
        ok: false,
        error: expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("connection owner has been retired"),
        }),
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "malformed-delegation-frame",
        ok: false,
        error: expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("connection owner has been retired"),
        }),
      }),
    );

    await expect(
      runSystemAgentGatewayOwnerTask(`connection:${client.connId}`, sessions, async () => "fresh"),
    ).resolves.toBe("fresh");
  });
});
