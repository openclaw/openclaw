import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareProjectedSessionSharing, prepareSessionSharing } from "./session-sharing.js";
import {
  sharingPolicyClient,
  sharingPolicyTarget,
  rolePolicyConfig,
} from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("reuses interleaved audience keys and copies scope snapshots without iteration", () => {
  const cfg = rolePolicyConfig();
  let revision = {};
  const clients = ["alice", "bob"].map((user) => sharingPolicyClient({ user }));
  const key = (client: (typeof clients)[number]) =>
    prepareProjectedSessionSharing({ cfg, client, isMember: () => false }).getCacheKey(revision);
  const initial = clients.map(key);
  const scopes = clients[0]!.connect.scopes!;
  const iterate = vi.spyOn(scopes, Symbol.iterator);
  for (let i = 0; i < 3; i++) {
    expect(clients.map(key)).toEqual(initial);
  }
  // A publication retires the keys; native array copying avoids iterable expansion.
  revision = {};
  expect(clients.map(key)).toEqual(initial);
  expect(iterate).not.toHaveBeenCalled();
  iterate.mockRestore();

  // Scope values, not the array identity, remain live authorization inputs.
  scopes[0] = "operator.admin";
  expect(key(clients[0]!)).not.toBe(initial[0]);
  expect(key(clients[1]!)).toBe(initial[1]);
  scopes[0] = "operator.read";
  expect(key(clients[0]!)).toBe(initial[0]);
  clients[0]!.connect.scopes = [];
  const empty = key(clients[0]!);
  clients[0]!.connect.scopes = undefined;
  expect(key(clients[0]!)).not.toBe(empty);
});

it("refreshes retained sharing facts on profile changes and clears them when identity detaches", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const source = ensureProfileForEmail("source@example.test");
    const target = ensureProfileForEmail("target@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const client = sharingPolicyClient({ user: source.id }) as GatewayWsClient;
    prepareGatewayRecipientProfile(client);
    const stop = onUserProfilesChanged(() => prepareGatewayRecipientProfile(client));
    const cfg = rolePolicyConfig();
    let revision = {};
    const share = () => prepareProjectedSessionSharing({ cfg, client, isMember: () => false });
    const key = () => share().getCacheKey(revision);
    try {
      const initialKey = key();
      setUserProfileRole(source.id, "view");
      expect(client.preparedSessionProfile?.role).toBe("view");
      expect(key()).toBe(initialKey);
      setUserProfileRole(target.id, "none");
      linkEmail("source@example.test", target.id);
      expect(client.preparedSessionProfile).toEqual({
        profileId: target.id,
        aliases: new Set([source.id, target.id]),
        role: "none",
        githubLogin: null,
      });
      const mergedKey = key();
      expect(mergedKey).not.toBe(initialKey);
      client.connect.scopes!.push("operator.admin");
      expect(key()).not.toBe(mergedKey);
      client.connect.scopes!.pop();
      expect(key()).toBe(mergedKey);
      // The owner retires the revision when publishing same-object policy edits.
      cfg.gateway!.roles!.definitions.none!.sessions.others = "view";
      revision = {};
      expect(key()).not.toBe(mergedKey);
      cfg.gateway!.roles!.definitions.none!.sessions.others = "none";
      revision = {};
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const sharing = share();
      expect(sharing.sessionCap).toBe("none");
      expect(sharing.isCreator({ type: "human", source: "profile", id: source.id })).toBe(true);
      expect(sharing.entryFilter?.("agent:main:foreign", { visibility: "shared" })).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
      client.authenticatedUserProfile = undefined;
      prepareGatewayRecipientProfile(client);
      expect(client.preparedSessionProfile).toBeUndefined();
      expect(key()).not.toBe(mergedKey);
    } finally {
      stop();
    }
  });
});

it("uses fresh prepared caller, alias, role, and membership facts without querying SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const owner = ensureProfileForEmail("owner@example.test");
    const oldOwner = ensureProfileForEmail("old-owner@example.test");
    const target = sharingPolicyTarget({ type: "human", id: oldOwner.id });
    target.entry.visibility = "shared";
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
      [new Set([owner.id]), "invited", false, "viewer", false],
      [new Set([owner.id]), "invited", true, "member", true],
    ] as const) {
      const sharing = prepareSessionSharing(
        { cfg, client },
        { aliases, sessionCap, isMember: () => member },
      );
      expect(sharing.roleForTarget(target)).toBe(expectedRole);
      expect(sharing.canReadTarget(target)).toBe(visible);
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
