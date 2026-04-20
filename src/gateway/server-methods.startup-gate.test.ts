import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import {
  STARTUP_GATE_WAIT_MS,
  createStartupGateBarrier,
} from "./server-startup-unavailable-methods.js";

const noWebchat = () => false;

describe("gateway startup gate barrier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildContext(overrides: Record<string, unknown> = {}) {
    return {
      logGateway: { warn: vi.fn() },
      ...overrides,
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
  }

  function buildClient() {
    return {
      connect: {
        role: "operator",
        scopes: ["operator.admin"],
        client: {
          id: "openclaw-control-ui",
          version: "1.0.0",
          platform: "darwin",
          mode: "ui",
        },
        minProtocol: 1,
        maxProtocol: 1,
      },
      connId: "conn-1",
      clientIp: "10.0.0.5",
    } as Parameters<typeof handleGatewayRequest>[0]["client"];
  }

  function dispatch(params: {
    method: string;
    context: Parameters<typeof handleGatewayRequest>[0]["context"];
    handler: GatewayRequestHandler;
  }) {
    const respond = vi.fn();
    const promise = handleGatewayRequest({
      req: { type: "req", id: crypto.randomUUID(), method: params.method },
      respond,
      client: buildClient(),
      isWebchatConnect: noWebchat,
      context: params.context,
      extraHandlers: { [params.method]: params.handler },
    });
    return { respond, promise };
  }

  it("waits for the barrier to open and then dispatches the gated method", async () => {
    const handler = vi.fn<GatewayRequestHandler>((opts) =>
      opts.respond(true, { messages: [] }, undefined),
    );
    const unavailableGatewayMethods = new Set(["chat.history", "models.list"]);
    const startupGateBarrier = createStartupGateBarrier();
    const context = buildContext({ unavailableGatewayMethods, startupGateBarrier });

    const { respond, promise } = dispatch({ method: "chat.history", context, handler });

    // Let microtasks settle: handler must NOT have been invoked yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();

    // Simulate post-attach completion.
    unavailableGatewayMethods.delete("chat.history");
    unavailableGatewayMethods.delete("models.list");
    startupGateBarrier.open();

    await promise;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { messages: [] }, undefined);
  });

  it("responds with retryable UNAVAILABLE when the barrier never opens", async () => {
    const handler = vi.fn<GatewayRequestHandler>((opts) =>
      opts.respond(true, undefined, undefined),
    );
    const unavailableGatewayMethods = new Set(["chat.history", "models.list"]);
    const startupGateBarrier = createStartupGateBarrier();
    const context = buildContext({ unavailableGatewayMethods, startupGateBarrier });

    const { respond, promise } = dispatch({ method: "chat.history", context, handler });

    await vi.advanceTimersByTimeAsync(STARTUP_GATE_WAIT_MS + 1);
    await promise;

    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        retryAfterMs: 500,
        details: { method: "chat.history" },
      }),
    );
  });

  it("dispatches non-gated methods immediately without waiting on the barrier", async () => {
    const handler = vi.fn<GatewayRequestHandler>((opts) =>
      opts.respond(true, { ok: true }, undefined),
    );
    const unavailableGatewayMethods = new Set(["chat.history", "models.list"]);
    const startupGateBarrier = createStartupGateBarrier();
    const context = buildContext({ unavailableGatewayMethods, startupGateBarrier });

    const { respond, promise } = dispatch({ method: "health", context, handler });
    await promise;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(startupGateBarrier.isOpen()).toBe(false);
  });

  it("preserves immediate UNAVAILABLE response when no barrier is on the context", async () => {
    const handler = vi.fn<GatewayRequestHandler>((opts) =>
      opts.respond(true, undefined, undefined),
    );
    const unavailableGatewayMethods = new Set(["chat.history", "models.list"]);
    const context = buildContext({ unavailableGatewayMethods });

    const { respond, promise } = dispatch({ method: "models.list", context, handler });
    await promise;

    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        retryAfterMs: 500,
      }),
    );
  });
});
