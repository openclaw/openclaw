import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { gatewayConnect } from "./server/client-fixtures.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function setup() {
  setRuntimeConfigSnapshot({});
  const started = 1_900_000_000_000;
  vi.spyOn(Date, "now").mockReturnValue(started);
  const client: GatewayWsClient = {
    socket: { readyState: 1 } as GatewayWsClient["socket"],
    connId: "activity-rpc",
    presenceKey: "activity-rpc",
    usesSharedGatewayAuth: false,
    connect: gatewayConnect(["operator.read"]),
    authenticatedUserId: "activity-rpc@example.test",
    personPresence: { onlineSince: started - 10_000 },
  };
  const clients = new GatewayClientRegistry([client]);
  const params = makeContextParams({ clients });
  const context = createGatewayRequestContext(params);
  const request = async (payload: Record<string, unknown> = {}) => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "activity", method: "presence.activity", params: payload },
      client,
      context,
      respond,
      isWebchatConnect: () => true,
    });
    return respond;
  };
  return { started, client, clients, request, publish: params.runtime.publishPresence };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it.each([
  {
    payload: { lastActivityAt: 1 },
    connect: {},
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("invalid presence.activity params"),
    },
  },
  {
    connect: { scopes: ["operator.pairing"] },
    error: { code: "FORBIDDEN", message: "missing scope: operator.read" },
  },
  { connect: { role: "node" }, error: { code: "INVALID_REQUEST" } },
])(
  "rejects invalid telemetry or unauthorized callers ($error.code)",
  async ({ connect, error, payload }) => {
    const { request, publish, client } = setup();
    Object.assign(client.connect, connect);
    expect(await request(payload)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining(error),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(client.personPresence?.lastActivityAt).toBeUndefined();
  },
);

it.each([false, true])(
  "waits for post-hello profile hydration and preserves live authority (closed=%s)",
  async (closed) => {
    const { client, clients, request, publish, started } = setup();
    client.authenticatedGitHubIdentitySync = async () => {
      client.authenticatedUserProfile = {
        profileId: "activity-profile",
        displayName: "Activity Person",
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: started,
      };
      if (closed) {
        clients.delete(client);
      }
      return { profileId: "activity-profile", updatedAt: started };
    };
    const response = await request();
    expect(response).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(client.personPresence?.lastActivityAt).toBe(closed ? undefined : started);
    expect(publish).toHaveBeenCalledTimes(closed ? 0 : 1);
  },
);
