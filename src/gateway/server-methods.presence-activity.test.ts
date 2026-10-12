import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function setup() {
  const started = 1_900_000_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(started);
  const tabs = ["one", "two"].map((tab): GatewayWsClient => ({
    socket: { readyState: 1 } as GatewayWsClient["socket"],
    connId: `activity-rpc-${tab}`,
    presenceKey: `activity-rpc-${tab}`,
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.read"],
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    },
    authenticatedUserId: "activity-rpc@example.test",
    personPresence: { onlineSince: started - 10_000 },
  }));
  const clients = new GatewayClientRegistry(tabs);
  const params = makeContextParams({ clients });
  const context = createGatewayRequestContext(params);
  const request = async (client = tabs[0]!, payload: Record<string, unknown> = {}) => {
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
  return { started, clock, tabs, clients, request, publish: params.runtime.publishPresence };
}

afterEach(() => vi.restoreAllMocks());

describe("presence.activity registered request", () => {
  it("rejects invalid telemetry and unauthorized callers before recording activity", async () => {
    for (const row of [
      {
        payload: { lastActivityAt: 1 },
        code: "INVALID_REQUEST",
        message: "invalid presence.activity params",
      },
      { scopes: ["operator.pairing"], code: "FORBIDDEN", message: "missing scope: operator.read" },
      { role: "node", code: "INVALID_REQUEST" },
    ]) {
      const { request, publish, tabs } = setup();
      if (row.scopes) {
        tabs[0]!.connect.scopes = row.scopes;
      }
      if (row.role) {
        tabs[0]!.connect.role = row.role;
      }
      expect(await request(tabs[0], row.payload)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: row.code,
          ...(row.message
            ? {
                message:
                  row.code === "FORBIDDEN" ? row.message : expect.stringContaining(row.message),
              }
            : {}),
        }),
      );
      expect(publish).not.toHaveBeenCalled();
      expect(tabs[0]!.personPresence?.lastActivityAt).toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it.each([false, true])(
    "waits for post-hello profile hydration and preserves live authority (closed=%s)",
    async (closed) => {
      const { tabs, clients, request, publish, started } = setup();
      const client = tabs[0]!;
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
});
