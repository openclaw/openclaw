import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  validateUsersLinkChannelIdentityResult,
  validateUsersLinkEmailResult,
  validateUsersListChannelIdentitiesResult,
  validateUsersUnlinkChannelIdentityResult,
  validateUsersSetRoleResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserChannelIdentity } from "../state/user-channel-identities.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  getUserProfileRole,
  resolveUserProfileId,
  setUserProfileRole,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";

const identity = { channelId: "discord", accountId: "team-bot", senderId: "100000000000000001" };
async function dispatch(
  method: string,
  params: unknown,
  scopes: string[],
  profileId: string,
  expectedProfileId?: string,
  cfg: OpenClawConfig = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: method,
      method,
      params,
      ...(expectedProfileId ? { expectedProfileId } : {}),
    },
    respond,
    client: {
      connId: "channel-identity-test",
      authenticatedUserId: "admin@example.test",
      authenticatedUserProfile: { profileId, displayName: "Admin", hasAvatar: false, updatedAt: 1 },
      connect: {
        role: "operator",
        scopes,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    } as Parameters<typeof handleGatewayRequest>[0]["client"],
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => cfg,
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
  });
  return respond.mock.calls[0];
}

it.each(["person", "shared owner"] as const)(
  "serves profile administration for %s through registered Gateway methods without main-thread SQL",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const admin =
        kind === "shared owner"
          ? ensureGatewayOwnerProfile(null)
          : ensureProfileForEmail("admin@example.test");
      const person = ensureProfileForEmail("person@example.test");
      const secondary = ensureProfileForEmail("secondary@example.test");
      if (kind === "person") {
        setUserProfileRole(admin.id, "admin");
      }
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "member",
            definitions: {
              admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
              member: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
            },
          },
        },
      };
      const link = { profileId: person.id, identity };
      const roleAssignment = { profileId: person.id, role: "admin" };
      const emailLink = { email: "secondary@example.test", targetProfileId: person.id };
      const request = (method: string, params: unknown, scopes = ["operator.admin"]) =>
        dispatch(method, params, scopes, admin.id, admin.id, cfg);
      for (const [method, params] of [
        ["users.linkChannelIdentity", link],
        ["users.listChannelIdentities", { profileId: person.id }],
        ["users.unlinkChannelIdentity", link],
        ["users.setRole", roleAssignment],
        ["users.linkEmail", emailLink],
      ] as const) {
        const denied = await request(method, params, ["operator.read", "operator.write"]);
        expect(denied).toEqual([false, undefined, expect.objectContaining({ code: "FORBIDDEN" })]);
      }
      expect(resolveUserChannelIdentity(identity)).toBeUndefined();
      const queries = vi.spyOn(DatabaseSync.prototype, "prepare");
      try {
        // Cover initial selected-account/role admission, worker grants and response guards
        // through the registered in-process route, which has no WS worker brand.
        const linked = await request("users.linkChannelIdentity", link);
        expect(linked).toEqual([true, link]);
        expect(validateUsersLinkChannelIdentityResult(linked?.[1])).toBe(true);
        const listed = await request("users.listChannelIdentities", { profileId: person.id });
        expect(listed).toEqual([true, { links: [link] }]);
        expect(validateUsersListChannelIdentitiesResult(listed?.[1])).toBe(true);
        const removed = await request("users.unlinkChannelIdentity", link);
        expect(removed).toEqual([true, { removed: true }]);
        expect(validateUsersUnlinkChannelIdentityResult(removed?.[1])).toBe(true);
        const assigned = await request("users.setRole", roleAssignment);
        expect(assigned?.[0]).toBe(true);
        expect(validateUsersSetRoleResult(assigned?.[1])).toBe(true);
        const merged = await request("users.linkEmail", emailLink);
        expect(merged?.[0]).toBe(true);
        expect(validateUsersLinkEmailResult(merged?.[1])).toBe(true);
        expect(queries).not.toHaveBeenCalled();
      } finally {
        queries.mockRestore();
      }
      expect(resolveUserChannelIdentity(identity)).toBeUndefined();
      expect(getUserProfileRole(person.id)).toBe("admin");
      expect(resolveUserProfileId(secondary.id)).toBe(person.id);
    });
  },
);

it("rejects malformed or conflicting assignments without changing the saved binding", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const admin = ensureProfileForEmail("admin@example.test");
    const other = ensureProfileForEmail("other@example.test");
    const link = { profileId: admin.id, identity };
    await dispatch("users.linkChannelIdentity", link, ["operator.admin"], admin.id);
    for (const params of [
      { ...link, identity: { ...identity, senderId: " " } },
      { ...link, unexpected: true },
      { ...link, profileId: other.id },
    ]) {
      const denied = await dispatch(
        "users.linkChannelIdentity",
        params,
        ["operator.admin"],
        admin.id,
      );
      expect(denied?.[0]).toBe(false);
      expect(denied?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
      expect(resolveUserChannelIdentity(identity)?.profileId).toBe(admin.id);
    }
  });
});
