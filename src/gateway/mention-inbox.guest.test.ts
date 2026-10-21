import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { SESSION_KEY, mentionRoles, withMentionInbox } from "./mention-inbox.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createBroadcastPeer } from "./server-broadcast.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

it.each(["operator.sessions.read", "operator.sessions.write"] as const)(
  "delivers and manages only the current guest's Inbox with %s",
  async (scope) => {
    const cfg: OpenClawConfig = mentionRoles({
      guest: { agents: "*", scopes: [scope], sessions: { others: "view" } },
      denied: { agents: "*", scopes: [], sessions: { others: "none" } },
    });
    await withMentionInbox(async (f) => {
      setUserProfileRole(f.bob.id, "guest");
      invalidateOperatorRolePolicy(f.bob.id);
      f.bobClient.connect.scopes = [scope];
      f.bobSecond.connect.scopes = [scope];
      f.carolClient.connect.scopes = ["operator.read"];
      const peer = createBroadcastPeer("bob-one", true);
      const connected = Object.assign(f.bobClient, {
        socket: peer.client.socket,
        usesSharedGatewayAuth: false,
        authenticatedUserProfile: {
          profileId: f.bob.id,
          displayName: "Bob",
          hasAvatar: false,
          avatarRevision: "1",
          updatedAt: f.bob.updatedAt,
        },
      });
      const broadcaster = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([connected]),
      });
      f.broadcast.mockImplementation(broadcaster.broadcastToConnIds);
      const context = {
        mentionInbox: f.inbox,
        getRuntimeConfig: () => cfg,
      } as GatewayRequestContext;
      async function request(
        method: string,
        params: Record<string, unknown> = {},
        client: GatewayClient = connected,
      ) {
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: { type: "req", id: "guest-inbox", method, params },
          client,
          context,
          respond,
          isWebchatConnect: () => true,
        });
        expect(respond).toHaveBeenCalledOnce();
        const [success, payload, error] = respond.mock.calls[0]!;
        return { success, payload, error };
      }
      const expectItems = async (
        items: unknown[],
        method = "mentions.list",
        params: Record<string, unknown> = {},
        client: GatewayClient = connected,
      ) => {
        expect(await request(method, params, client)).toMatchObject({
          success: true,
          payload: { items },
          error: undefined,
        });
      };
      const expectError = async (
        code: string,
        method = "mentions.list",
        params: Record<string, unknown> = {},
      ) => {
        expect(await request(method, params)).toMatchObject({
          success: false,
          payload: undefined,
          error: { code },
        });
      };

      await f.post();
      expect(peer.frames).toMatchObject([
        { event: "mentions.changed", payload: { gatewayInstanceId: "mention-gateway" } },
      ]);
      expect(f.push.mock.calls[0]?.[0].recipientProfileId).toBe(f.bob.id);
      await expectItems([
        {
          sessionKey: SESSION_KEY,
          messageId: "message-source-one",
          senderProfileId: f.alice.id,
        },
      ]);
      const item = (await f.items(connected))[0]!;
      await expectItems([], "mentions.list", {}, f.carolClient);
      await expectItems([], "mentions.dismiss", { ids: [item.id] }, f.carolClient);
      await expectError("INVALID_REQUEST", "mentions.list", { profileId: f.carol.id });
      await expectItems([item], "mentions.list", {}, f.bobSecond);
      await expectItems([], "mentions.dismiss", { ids: [item.id] });
      expect(await f.items(f.bobSecond)).toEqual([]);
      await f.post();
      expect(await f.items()).toEqual([]);

      await f.post("before-revocation");
      const delayed = f.push.mock.calls.at(-1)?.[0];
      expect(delayed?.isCurrent()).toBe(true);
      const retained = (await f.items(connected))[0]!;
      await f.setSession({ visibility: "draft" });
      await f.inbox.invalidateAsync();
      await expectItems([]);
      await expectItems([], "mentions.dismiss", { ids: [retained.id] });
      expect(delayed?.isCurrent()).toBe(false);
      await f.setSession({ visibility: "shared" });
      await expectItems([retained]);
      expect(delayed?.isCurrent()).toBe(true);
      setUserProfileRole(f.bob.id, "denied");
      invalidateOperatorRolePolicy(f.bob.id);
      await expectError("FORBIDDEN");
      await expectError("FORBIDDEN", "mentions.dismiss", { ids: [item.id] });
      expect(delayed?.isCurrent()).toBe(false);
    }, cfg);
  },
);
