import { describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const key = "agent:main:test";
const move = (target: { kind: "gateway" } | { kind: "profile"; profileId: string }) => ({
  key,
  expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
  target,
});
const profileMove = move({ kind: "profile", profileId: "development" });
const writer = ["operator.write"];
const placementCases = [
  ["writer device dispatch", "sessions.dispatch", { key, deviceId: "device-1" }, writer, true],
  [
    "writer profile dispatch",
    "sessions.dispatch",
    { key, profileId: "development" },
    writer,
    false,
  ],
  ["writer gateway move", "sessions.move", move({ kind: "gateway" }), writer, true],
  ["writer profile move", "sessions.move", profileMove, writer, false],
  ["admin profile move", "sessions.move", profileMove, ["operator.admin"], true],
] as const;

async function dispatch(method: string, params: unknown, scopes: readonly string[], stub = true) {
  const client = {
    connId: `conn-${crypto.randomUUID()}`,
    connect: {
      role: "operator",
      scopes: [...scopes],
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as Parameters<typeof handleGatewayRequest>[0]["client"];
  const context = {
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn() },
  } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { reached: true }));
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: `req-${method}`, method, params },
    respond,
    client,
    isWebchatConnect: () => false,
    context,
    ...(stub ? { extraHandlers: { [method]: handler } } : {}),
  });
  return { handler, respond };
}

const folder = { deviceFolder: { deviceId: "device-1", path: "/srv/project" } };

describe("session placement target authorization", () => {
  it.each(placementCases)(
    "authorizes %s before the handler",
    async (_name, method, params, scopes, allowed) => {
      const { handler, respond } = await dispatch(method, params, scopes);

      if (allowed) {
        expect(handler).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(true, { reached: true });
        return;
      }
      expect(handler).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.admin",
            requiredScopes: ["operator.admin"],
          },
        }),
      );
    },
  );

  it.each([
    ["writer with a device folder", folder, writer, true],
    ["own-session writer with a device folder", folder, ["operator.sessions.write"], false],
  ] as const)(
    "authorizes sessions.create for a %s before the handler",
    async (_name, extra, scopes, allowed) => {
      const { handler, respond } = await dispatch(
        "sessions.create",
        { key: "agent:main:dashboard:folder", ...extra },
        scopes,
      );

      // The handler owns node validation and persistence, so a refusal here precedes both.
      expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(respond).toHaveBeenCalledWith(
        ...(allowed
          ? [true, { reached: true }]
          : [
              false,
              undefined,
              expect.objectContaining({
                code: "FORBIDDEN",
                details: expect.objectContaining({ missingScope: "operator.write" }),
              }),
            ]),
      );
    },
  );

  it.each([
    ["sessions.dispatch", { key: "agent:main:test", profileId: "profile", deviceId: "device" }],
    ["sessions.move", { key: "agent:main:test", target: { kind: "profile" } }],
  ] as const)("lets malformed %s params reach schema validation", async (method, params) => {
    const { respond } = await dispatch(method, params, ["operator.write"], false);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining(`invalid ${method} params`),
      }),
    );
  });
});
