import { describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayRequestHandler } from "./types.js";

function operatorClient(scopes: readonly string[]) {
  return {
    connId: "conn-tts-authz",
    connect: {
      role: "operator",
      scopes: [...scopes],
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as Parameters<typeof handleGatewayRequest>[0]["client"];
}

describe("tts stored-voice authorization", () => {
  it.each(["tts.designVoice", "tts.replicateVoice"] as const)(
    "rejects operator.read for %s before the handler",
    async (method) => {
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { reached: true }),
      );
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: `req-${method}-read`, method, params: {} },
        respond,
        client: operatorClient(["operator.read"]),
        isWebchatConnect: () => false,
        context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
          typeof handleGatewayRequest
        >[0]["context"],
        extraHandlers: { [method]: handler },
      });
      expect(handler).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "FORBIDDEN",
        message: "missing scope: operator.write",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.write",
          requiredScopes: ["operator.write"],
        },
      });
    },
  );

  it("lets operator.write reach tts.replicateVoice", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { reached: true }));
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "req-replicate-write", method: "tts.replicateVoice", params: {} },
      respond,
      client: operatorClient(["operator.write"]),
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
      extraHandlers: { "tts.replicateVoice": handler },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { reached: true });
  });
});
