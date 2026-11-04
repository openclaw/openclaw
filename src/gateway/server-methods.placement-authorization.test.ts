import { expect, it, vi } from "vitest";
import { startAuthorizationRequest } from "./server-methods.authorization.test-support.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const key = "agent:main:test";
const move = (target: { kind: "gateway" } | { kind: "profile"; profileId: string }) => ({
  key,
  expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
  target,
});
const profileMove = move({ kind: "profile", profileId: "development" });
const writer = ["operator.write"];
const folder = {
  key: "agent:main:dashboard:folder",
  deviceFolder: { deviceId: "device-1", path: "/srv/project" },
};
const placementCases = [
  ["writer device dispatch", "dispatch", { key, deviceId: "device-1" }, writer, true],
  ["writer profile dispatch", "dispatch", { key, profileId: "development" }, writer, true],
  ["writer gateway move", "move", move({ kind: "gateway" }), writer, true],
  ["writer profile move", "move", profileMove, writer, false],
  ["admin profile move", "move", profileMove, ["operator.admin"], true],
  ["writer device folder", "create", folder, writer, true],
  ["own-session writer device folder", "create", folder, ["operator.sessions.write"], false],
] as const;

async function dispatch(method: string, params: unknown, scopes: readonly string[], stub = true) {
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { reached: true }));
  const { request, respond } = startAuthorizationRequest(method, params, {
    connId: `conn-${crypto.randomUUID()}`,
    scopes: [...scopes],
    ...(stub ? { extraHandlers: { [method]: handler } } : {}),
  });
  await request;
  return { handler, respond };
}

it.each(placementCases)(
  "authorizes %s before the handler",
  async (_name, operation, params, scopes, allowed) => {
    const { handler, respond } = await dispatch(`sessions.${operation}`, params, scopes);
    // The handler owns profile authorization, node validation, and persistence.
    expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) {
      expect(respond).toHaveBeenCalledWith(true, { reached: true });
    } else {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          details:
            operation === "create"
              ? expect.objectContaining({ missingScope: "operator.write" })
              : {
                  code: "MISSING_SCOPE",
                  missingScope: "operator.admin",
                  requiredScopes: ["operator.admin"],
                },
        }),
      );
    }
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
