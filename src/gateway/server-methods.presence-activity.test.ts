import { afterEach, describe, expect, it, vi } from "vitest";
import { listSystemPresence } from "../infra/system-presence.js";
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
  it("records server time across live tabs and coalesces publication without requiring chat", async () => {
    const { started, clock, tabs, request, publish, clients } = setup();
    expect(await request()).toHaveBeenCalledWith(true, { ok: true }, undefined);
    clock.mockReturnValue(started + 1_000);
    await request(tabs[1]);
    expect(publish).toHaveBeenCalledOnce();
    for (const tab of tabs) {
      expect(tab.personPresence).toEqual({
        onlineSince: started - 10_000,
        lastActivityAt: started + 1_000,
      });
    }
    clients.delete(tabs[0]!);
    clock.mockReturnValue(started + 30_000);
    await request(tabs[1]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(listSystemPresence()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lastActivityAt: started + 30_000,
          user: { id: "activity-rpc@example.test", email: "activity-rpc@example.test" },
        }),
      ]),
    );
  });

  it("rejects client timestamps, identity and content instead of accepting arbitrary telemetry", async () => {
    const { request, publish, tabs } = setup();
    for (const payload of [{ lastActivityAt: 1 }, { userId: "other" }, { key: "a" }]) {
      expect(await request(tabs[0], payload)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("invalid presence.activity params"),
        }),
      );
    }
    expect(publish).not.toHaveBeenCalled();
    expect(tabs[0]!.personPresence?.lastActivityAt).toBeUndefined();
  });

  it("denies nodes and operators without read scope before recording activity", async () => {
    const { tabs, request, publish } = setup();
    tabs[0]!.connect.scopes = ["operator.pairing"];
    expect(await request()).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN", message: "missing scope: operator.read" }),
    );
    tabs[0]!.connect.scopes = ["operator.read"];
    tabs[0]!.connect.role = "node";
    expect(await request()).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(publish).not.toHaveBeenCalled();
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

  it("does not invent activity for copied, retired or unidentified clients", async () => {
    const { tabs, clients, request, publish } = setup();
    expect(await request({ ...tabs[0]! })).toHaveBeenCalledWith(true, { ok: true }, undefined);
    clients.delete(tabs[0]!);
    expect(await request()).toHaveBeenCalledWith(true, { ok: true }, undefined);
    tabs[1]!.authenticatedUserId = undefined;
    expect(await request(tabs[1])).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(publish).not.toHaveBeenCalled();
    expect(tabs.every((tab) => tab.personPresence?.lastActivityAt === undefined)).toBe(true);
  });
});
