import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { handleGatewayRequest } from "./server-methods.js";

const noWebchat = () => false;

function buildContext() {
  return {
    logGateway: {
      warn: vi.fn(),
    },
  } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
}

function buildNodeClient() {
  return {
    connect: {
      role: "node",
      scopes: [],
      client: {
        id: "openclaw-node-host",
        version: "1.0.0",
        platform: "darwin",
        mode: "node",
      },
      minProtocol: 1,
      maxProtocol: 1,
    },
    connId: "node-conn-1",
    clientIp: "10.0.0.7",
  } as Parameters<typeof handleGatewayRequest>[0]["client"];
}

async function runRequest(params: { method: string; handler: GatewayRequestHandler }) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "req-1",
      method: params.method,
    },
    respond,
    client: buildNodeClient(),
    isWebchatConnect: noWebchat,
    context: buildContext(),
    extraHandlers: {
      [params.method]: params.handler,
    },
  });
  return respond;
}

describe("gateway node-role health compatibility", () => {
  it("allows role=node clients to call health", async () => {
    const handler = vi.fn<GatewayRequestHandler>((opts) => {
      opts.respond(true, { ok: true }, undefined);
    });

    const respond = await runRequest({
      method: "health",
      handler,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("still rejects non-node methods for role=node clients", async () => {
    const handler = vi.fn<GatewayRequestHandler>((opts) => {
      opts.respond(true, { ok: true }, undefined);
    });

    const respond = await runRequest({
      method: "status",
      handler,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unauthorized role: node",
      }),
    );
  });
});
