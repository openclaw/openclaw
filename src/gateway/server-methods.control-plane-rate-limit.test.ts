/**
 * Tests control-plane rate limiting for gateway method dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableGatewayStartupUnavailableError } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./methods/core-descriptors.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const noWebchat = () => false;
let clientSequence = 0;

describe("gateway control-plane write rate limit", () => {
  beforeEach(() => {
    clientSequence += 1;
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-19T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
  });

  function buildContext(logWarn = vi.fn(), runtimeConfig: object = {}) {
    return {
      logGateway: {
        warn: logWarn,
      },
      getRuntimeConfig: () => runtimeConfig,
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
  }

  function buildConnect(): NonNullable<
    Parameters<typeof handleGatewayRequest>[0]["client"]
  >["connect"] {
    return {
      role: "operator",
      scopes: ["operator.admin"],
      client: {
        id: "openclaw-control-ui",
        version: "1.0.0",
        platform: "macos",
        mode: "ui",
      },
      minProtocol: 1,
      maxProtocol: 1,
    };
  }

  function buildClient() {
    return {
      connect: buildConnect(),
      connId: `conn-${clientSequence}`,
      clientIp: `10.0.0.${clientSequence}`,
    } as Parameters<typeof handleGatewayRequest>[0]["client"];
  }

  async function runRequest(params: {
    method: string;
    context: Parameters<typeof handleGatewayRequest>[0]["context"];
    client: Parameters<typeof handleGatewayRequest>[0]["client"];
    handler: GatewayRequestHandler;
  }) {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: crypto.randomUUID(),
        method: params.method,
      },
      respond,
      client: params.client,
      isWebchatConnect: noWebchat,
      context: params.context,
      extraHandlers: {
        [params.method]: params.handler,
      },
    });
    return respond;
  }

  function respondCall(respond: ReturnType<typeof vi.fn>) {
    const call = respond.mock.calls.at(0);
    if (!call) {
      throw new Error("Expected response call");
    }
    return call as [
      boolean,
      unknown,
      { code?: string; details?: unknown; retryAfterMs?: number; retryable?: boolean }?,
    ];
  }

  it("allows 3 control-plane writes and blocks the 4th in the same minute", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const logWarn = vi.fn();
    const context = buildContext(logWarn);
    const client = buildClient();

    await runRequest({ method: "config.patch", context, client, handler });
    await runRequest({ method: "config.patch", context, client, handler });
    await runRequest({ method: "config.patch", context, client, handler });
    const blocked = await runRequest({ method: "config.patch", context, client, handler });

    expect(handlerCalls).toHaveBeenCalledTimes(3);
    const blockedCall = respondCall(blocked);
    const error = blockedCall[2];
    expect(blockedCall[0]).toBe(false);
    expect(blockedCall[1]).toBeUndefined();
    expect(error?.code).toBe("UNAVAILABLE");
    expect(error?.retryable).toBe(true);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("honors gateway.controlPlaneWritesPerMinute from the runtime config", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const logWarn = vi.fn();
    const context = {
      logGateway: { warn: logWarn },
      getRuntimeConfig: () => ({ gateway: { controlPlaneWritesPerMinute: 5 } }),
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
    const client = buildClient();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await runRequest({ method: "config.patch", context, client, handler });
    }
    const blocked = await runRequest({ method: "config.patch", context, client, handler });

    expect(handlerCalls).toHaveBeenCalledTimes(5);
    const blockedCall = respondCall(blocked);
    expect(blockedCall[0]).toBe(false);
    expect(blockedCall[2]?.code).toBe("UNAVAILABLE");
    expect((blockedCall[2]?.details as { limit?: string })?.limit).toBe("5 per 60s");
  });

  it("applies a raised budget to every client identity, each bounded separately", async () => {
    const handler: GatewayRequestHandler = (opts) => {
      opts.respond(true, undefined, undefined);
    };
    const context = buildContext(vi.fn(), { gateway: { controlPlaneWritesPerMinute: 4 } });
    const clientA = buildClient();
    clientSequence += 1;
    const clientB = buildClient();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await runRequest({ method: "config.patch", context, client: clientA, handler });
    }
    const blockedA = await runRequest({
      method: "config.patch",
      context,
      client: clientA,
      handler,
    });
    expect(respondCall(blockedA)[0]).toBe(false);

    // The raised value is gateway-global: the other identity gets the same
    // budget, counted in its own bucket.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const ok = await runRequest({ method: "config.patch", context, client: clientB, handler });
      expect(ok).toHaveBeenCalledWith(true, undefined, undefined);
    }
    const blockedB = await runRequest({
      method: "config.patch",
      context,
      client: clientB,
      handler,
    });
    expect(respondCall(blockedB)[0]).toBe(false);
  });

  it("adopts a changed budget on the next write without any reload", async () => {
    const handler: GatewayRequestHandler = (opts) => {
      opts.respond(true, undefined, undefined);
    };
    const runtimeConfig = { gateway: { controlPlaneWritesPerMinute: 3 } };
    const context = buildContext(vi.fn(), runtimeConfig);
    const client = buildClient();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runRequest({ method: "config.patch", context, client, handler });
    }
    const blocked = await runRequest({ method: "config.patch", context, client, handler });
    expect(respondCall(blocked)[0]).toBe(false);

    runtimeConfig.gateway.controlPlaneWritesPerMinute = 10;
    const allowed = await runRequest({ method: "config.patch", context, client, handler });
    expect(allowed).toHaveBeenCalledWith(true, undefined, undefined);
  });

  it("allows the OpenClaw inference ladder to probe more than 3 candidates", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, { ok: false, status: "auth", error: "candidate failed" }, undefined);
    };
    const context = buildContext();
    const client = buildClient();

    const responses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      responses.push(
        await runRequest({
          method: "openclaw.setup.activate",
          context,
          client,
          handler,
        }),
      );
    }

    expect(handlerCalls).toHaveBeenCalledTimes(4);
    for (const response of responses) {
      expect(response).toHaveBeenCalledWith(
        true,
        { ok: false, status: "auth", error: "candidate failed" },
        undefined,
      );
    }
  });

  it("resets the control-plane write budget after 60 seconds", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const context = buildContext();
    const client = buildClient();

    await runRequest({ method: "update.run", context, client, handler });
    await runRequest({ method: "update.run", context, client, handler });
    await runRequest({ method: "update.run", context, client, handler });

    const blocked = await runRequest({ method: "update.run", context, client, handler });
    const blockedCall = respondCall(blocked);
    expect(blockedCall[0]).toBe(false);
    expect(blockedCall[1]).toBeUndefined();
    expect(blockedCall[2]?.code).toBe("UNAVAILABLE");

    vi.advanceTimersByTime(60_001);

    const allowed = await runRequest({ method: "update.run", context, client, handler });
    expect(allowed).toHaveBeenCalledWith(true, undefined, undefined);
    expect(handlerCalls).toHaveBeenCalledTimes(4);
  });

  it("does not consume the write budget for requests refused during suspension", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const context = buildContext();
    const client = buildClient();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refused = await runRequest({ method: "config.patch", context, client, handler });
      expect(respondCall(refused)[2]).toMatchObject({
        code: "UNAVAILABLE",
        details: { reason: "gateway-suspending" },
      });
    }
    expect(suspension?.release()).toBe(true);

    const allowed = await runRequest({ method: "config.patch", context, client, handler });
    expect(allowed).toHaveBeenCalledWith(true, undefined, undefined);
    expect(handlerCalls).toHaveBeenCalledOnce();
  });

  it("keeps suspension preparation rate-limited while admission is closed", async () => {
    const handlerCalls = vi.fn();
    const handler: GatewayRequestHandler = (opts) => {
      handlerCalls(opts);
      opts.respond(true, undefined, undefined);
    };
    const context = buildContext();
    const client = buildClient();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    await runRequest({ method: "gateway.suspend.prepare", context, client, handler });
    await runRequest({ method: "gateway.suspend.prepare", context, client, handler });
    await runRequest({ method: "gateway.suspend.prepare", context, client, handler });
    const blocked = await runRequest({
      method: "gateway.suspend.prepare",
      context,
      client,
      handler,
    });

    expect(handlerCalls).toHaveBeenCalledTimes(3);
    expect(respondCall(blocked)[2]).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(suspension?.release()).toBe(true);
  });

  it.each(STARTUP_UNAVAILABLE_GATEWAY_METHODS)(
    "blocks startup-gated method %s before dispatch with a retryable startup error",
    async (method) => {
      const handlerCalls = vi.fn();
      const handler: GatewayRequestHandler = (opts) => {
        handlerCalls(opts);
        opts.respond(true, undefined, undefined);
      };
      const context = {
        ...buildContext(),
        unavailableGatewayMethods: new Set(STARTUP_UNAVAILABLE_GATEWAY_METHODS),
      } as Parameters<typeof handleGatewayRequest>[0]["context"];
      const client = buildClient();

      const blocked = await runRequest({ method, context, client, handler });

      expect(handlerCalls).not.toHaveBeenCalled();
      const blockedCall = respondCall(blocked);
      const error = blockedCall[2];
      expect(blockedCall[0]).toBe(false);
      expect(blockedCall[1]).toBeUndefined();
      expect(error?.code).toBe("UNAVAILABLE");
      expect(error?.retryable).toBe(true);
      expect(error?.retryAfterMs).toBe(500);
      expect(error?.details).toEqual({ reason: "startup-sidecars", method });
      expect(isRetryableGatewayStartupUnavailableError(error)).toBe(true);
    },
  );
});
