import { describe, expect, it, vi } from "vitest";
import { READ_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestOptions,
} from "./server-methods/types.js";

const noWebchat = () => false;

function buildContext(): GatewayRequestContext {
  return {
    logGateway: {
      warn: vi.fn(),
    },
  } as unknown as GatewayRequestContext;
}

function buildClient(scopes: string[]): NonNullable<GatewayRequestOptions["client"]> {
  return {
    connect: {
      role: "operator",
      scopes,
      client: {
        id: "openclaw-test",
        version: "1.0.0",
        platform: "test",
        mode: "cli",
      },
      minProtocol: 1,
      maxProtocol: 1,
    },
    connId: "conn-test",
  };
}

describe("gateway method registry authorization", () => {
  it("authorizes plugin methods from the per-request registry", async () => {
    const handler: GatewayRequestHandler = vi.fn((opts) => {
      opts.respond(true, { ok: true });
    });
    const registry = createGatewayMethodRegistry([
      {
        name: "workboard.cards.dispatch",
        handler,
        owner: { kind: "plugin", pluginId: "workboard" },
        scope: WRITE_SCOPE,
      },
    ]);
    const respond = vi.fn();

    await handleGatewayRequest({
      req: {
        type: "req",
        id: "req-plugin-write",
        method: "workboard.cards.dispatch",
        params: {},
      },
      respond,
      client: buildClient([WRITE_SCOPE, READ_SCOPE]),
      isWebchatConnect: noWebchat,
      context: buildContext(),
      methodRegistry: registry,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toEqual({ ok: true });
  });

  it("does not weaken plugin method scopes from the per-request registry", async () => {
    const handler: GatewayRequestHandler = vi.fn((opts) => {
      opts.respond(true, { ok: true });
    });
    const registry = createGatewayMethodRegistry([
      {
        name: "workboard.cards.dispatch",
        handler,
        owner: { kind: "plugin", pluginId: "workboard" },
        scope: WRITE_SCOPE,
      },
    ]);
    const respond = vi.fn();

    await handleGatewayRequest({
      req: {
        type: "req",
        id: "req-plugin-read-only",
        method: "workboard.cards.dispatch",
        params: {},
      },
      respond,
      client: buildClient([READ_SCOPE]),
      isWebchatConnect: noWebchat,
      context: buildContext(),
      methodRegistry: registry,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]?.message).toBe(`missing scope: ${WRITE_SCOPE}`);
  });
});
