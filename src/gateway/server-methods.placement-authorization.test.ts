import { describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const placementCases = [
  [
    "writer device dispatch",
    "sessions.dispatch",
    { key: "agent:main:test", deviceId: "device-1" },
    ["operator.write"],
    true,
  ],
  [
    "writer profile dispatch",
    "sessions.dispatch",
    { key: "agent:main:test", profileId: "development" },
    ["operator.write"],
    false,
  ],
  [
    "writer gateway move",
    "sessions.move",
    {
      key: "agent:main:test",
      expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
      target: { kind: "gateway" },
    },
    ["operator.write"],
    true,
  ],
  [
    "writer profile move",
    "sessions.move",
    {
      key: "agent:main:test",
      expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
      target: { kind: "profile", profileId: "development" },
    },
    ["operator.write"],
    false,
  ],
  [
    "admin profile move",
    "sessions.move",
    {
      key: "agent:main:test",
      expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
      target: { kind: "profile", profileId: "development" },
    },
    ["operator.admin"],
    true,
  ],
] as const;

function operatorClient(id: string, scopes: readonly string[]) {
  return {
    connId: `conn-${id}`,
    connect: {
      role: "operator",
      scopes: [...scopes],
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as Parameters<typeof handleGatewayRequest>[0]["client"];
}

function requestContext() {
  return {
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn() },
  } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
}

const FOLDER = { deviceId: "device-1", path: "/srv/project" };

describe("session placement target authorization", () => {
  it.each(placementCases)(
    "authorizes %s before the handler",
    async (name, method, params, scopes, allowed) => {
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { reached: true }),
      );
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: `req-${name}`, method, params },
        respond,
        client: operatorClient(name, scopes),
        isWebchatConnect: () => false,
        context: requestContext(),
        extraHandlers: { [method]: handler },
      });

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
    ["writer with a device folder", { deviceFolder: FOLDER }, ["operator.write"], true],
    [
      "own-session writer with a device folder",
      { deviceFolder: FOLDER },
      ["operator.sessions.write"],
      false,
    ],
  ] as const)(
    "authorizes sessions.create for a %s before the handler",
    async (name, extra, scopes, allowed) => {
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { reached: true }),
      );
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: `req-create-${name}`,
          method: "sessions.create",
          params: { key: "agent:main:dashboard:folder", ...extra },
        },
        respond,
        client: operatorClient(name, scopes),
        isWebchatConnect: () => false,
        context: requestContext(),
        extraHandlers: { "sessions.create": handler },
      });

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
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: `req-malformed-${method}`, method, params },
      respond,
      client: operatorClient(method, ["operator.write"]),
      isWebchatConnect: () => false,
      context: requestContext(),
    });

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
