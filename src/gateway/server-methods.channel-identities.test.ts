import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { validateUsersLinkEmailResult as validProfile } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserChannelIdentity } from "../state/user-channel-identities.js";
import {
  prepareUserProfileCatalog,
  readResidentUserProfileIdentity,
} from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { gatewayRequest } from "./request-frame.test-support.js";
import { authorizationClient } from "./server-methods.authorization.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";

const identity = { channelId: "discord", accountId: "team-bot", senderId: "100000000000000001" };
function createRequests(profileId: string, expectedProfileId?: string, cfg: OpenClawConfig = {}) {
  return async (action: string, params: unknown, scopes = ["operator.admin"]) => {
    const method = `users.${action}`;
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        ...gatewayRequest(method, method, params),
        ...(expectedProfileId ? { expectedProfileId } : {}),
      },
      respond,
      isWebchatConnect: () => false,
      client: authorizationClient("channel-identity-test", scopes, {
        authenticatedUserId: "admin@example.test",
        authenticatedUserProfile: gatewayProfile(profileId, "Admin"),
      }),
      context: {
        getRuntimeConfig: () => cfg,
        logGateway: { warn: vi.fn() },
      } as unknown as GatewayRequestContext,
    });
    return respond.mock.calls[0];
  };
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
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
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
      const request = createRequests(admin.id, admin.id, cfg);
      const email = { email: "secondary@example.test", targetProfileId: person.id };
      const operations = [
        ["linkChannelIdentity", link, link],
        ["listChannelIdentities", { profileId: person.id }, { links: [link] }],
        ["unlinkChannelIdentity", link, { removed: true }],
        ["setRole", { profileId: person.id, role: "admin" }, validProfile],
        ["linkEmail", email, validProfile],
      ] as const;
      for (const [method, params] of operations) {
        const denied = await request(method, params, ["operator.read", "operator.write"]);
        expect(denied).toEqual([false, undefined, expect.objectContaining({ code: "FORBIDDEN" })]);
      }
      expect(resolveUserChannelIdentity(identity)).toBeUndefined();
      {
        using queries = vi.spyOn(DatabaseSync.prototype, "prepare");
        // Cover admission, worker grants and response guards without a WS worker brand.
        for (const [method, params, expected] of operations) {
          const result = await request(method, params);
          expect(result?.[0]).toBe(true);
          if (typeof expected === "function") {
            expect(expected(result?.[1])).toBe(true);
          } else {
            expect(result).toEqual([true, expected]);
          }
        }
        expect(queries).not.toHaveBeenCalled();
      }
      expect(resolveUserChannelIdentity(identity)).toBeUndefined();
      expect(readResidentUserProfileIdentity(person.id)?.role).toBe("admin");
      expect(readResidentUserProfileIdentity(secondary.id)?.profileId).toBe(person.id);
    });
  },
);

it("rejects malformed or conflicting assignments without changing the saved binding", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const admin = ensureProfileForEmail("admin@example.test");
    const other = ensureProfileForEmail("other@example.test");
    const link = { profileId: admin.id, identity };
    const request = createRequests(admin.id);
    await request("linkChannelIdentity", link);
    for (const params of [
      { ...link, identity: { ...identity, senderId: " " } },
      { ...link, unexpected: true },
      { ...link, profileId: other.id },
    ]) {
      const denied = await request("linkChannelIdentity", params);
      expect(denied).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
      expect(resolveUserChannelIdentity(identity)?.profileId).toBe(admin.id);
    }
  });
});
