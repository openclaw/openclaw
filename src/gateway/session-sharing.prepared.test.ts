import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareProjectedSessionSharing, prepareSessionSharing } from "./session-sharing.js";
import { sharingPolicyClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("refreshes retained sharing facts on profile changes and clears them when identity detaches", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const source = ensureProfileForEmail("source@example.test");
    const target = ensureProfileForEmail("target@example.test");
    const client = sharingPolicyClient({ user: source.id }) as GatewayWsClient;
    prepareGatewayRecipientProfile(client);
    expect(client.preparedSessionProfile).toEqual({
      profileId: source.id,
      aliases: new Set([source.id]),
      role: null,
    });
    const stop = onUserProfilesChanged(() => prepareGatewayRecipientProfile(client));
    try {
      setUserProfileRole(source.id, "view");
      expect(client.preparedSessionProfile?.role).toBe("view");
      setUserProfileRole(target.id, "none");
      linkEmail("source@example.test", target.id);
      expect(client.preparedSessionProfile).toEqual({
        profileId: target.id,
        aliases: new Set([source.id, target.id]),
        role: "none",
      });
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const sharing = prepareProjectedSessionSharing({
        cfg: rolePolicyConfig(),
        client,
        isMember: () => false,
      });
      expect(sharing.sessionCap).toBe("none");
      expect(sharing.isCreator({ type: "human", source: "profile", id: source.id })).toBe(true);
      expect(sharing.entryFilter?.("agent:main:foreign", { visibility: "shared" })).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
      client.authenticatedUserProfile = undefined;
      prepareGatewayRecipientProfile(client);
      expect(client.preparedSessionProfile).toBeUndefined();
    } finally {
      stop();
    }
  });
});

it("uses fresh prepared caller, alias, role, and membership facts without querying SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("owner@example.test");
    const oldOwner = ensureProfileForEmail("old-owner@example.test");
    const target = {
      agentId: "main",
      canonicalKey: "agent:main:shared",
      storeKey: "agent:main:shared",
      storeKeys: ["agent:main:shared"],
      storePath: "/unused/prepared-sharing",
      entry: {
        sessionId: "shared-session",
        updatedAt: 1,
        visibility: "shared" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: oldOwner.id },
      },
    };
    const client = sharingPolicyClient({ user: owner.id });
    const cfg = rolePolicyConfig();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    for (const [aliases, sessionCap, member, expectedRole, visible] of [
      [new Set([owner.id, oldOwner.id]), undefined, false, "owner", true],
      [new Set([owner.id]), undefined, false, "viewer", true],
      [new Set([owner.id]), undefined, true, "member", true],
      [new Set([owner.id]), "write", false, "member", true],
      [new Set([owner.id]), "none", true, "viewer", false],
    ] as const) {
      const sharing = prepareSessionSharing(
        { cfg, client },
        { aliases, sessionCap, isMember: () => member },
      );
      expect(sharing.roleForTarget(target)).toBe(expectedRole);
      expect(sharing.entryFilter?.(target.canonicalKey, target.entry)).toBe(visible);
      expect(sharing.authorizeTarget(target) === null).toBe(visible);
    }
    client.authenticatedUserProfile!.profileId = oldOwner.id;
    const fresh = prepareSessionSharing(
      { cfg, client },
      { aliases: new Set([oldOwner.id]), sessionCap: "none", isMember: () => false },
    );
    expect(fresh.roleForTarget(target)).toBe("owner");
    expect(fresh.entryFilter?.(target.canonicalKey, target.entry)).toBe(true);
    expect(fresh.authorizeTarget(target)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
