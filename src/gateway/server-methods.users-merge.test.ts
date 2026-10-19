import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { validateUsersMergeResult } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  linkUserChannelIdentity,
  resolveUserChannelIdentity,
} from "../state/user-channel-identities.js";
import {
  connectUserModelAccount,
  listUserModelAccounts,
  listUserProfileAuthLinks,
  setUserProfileAuthLink,
} from "../state/user-model-accounts.js";
import { getUserPreferences, setUserPreferences } from "../state/user-preferences.test-support.js";
import { getUserProfileListItem } from "../state/user-profile-list-item.test-support.js";
import {
  prepareUserProfileCatalog,
  prepareUserProfileIdentity,
  readResidentUserProfileIdentity,
} from "../state/user-profile-list.js";
import { setDisplayName, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { userProfilesDb } from "../state/user-profiles-internal.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createExpectedProfileBinding } from "./expected-profile.js";
import { resolveOperatorRolePolicyForProfile } from "./operator-role-policy.js";
import { authorizationClient } from "./server-methods.authorization.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  invalidateGatewayPolicyClient,
  registerGatewayPolicyResponse,
} from "./server/ws-policy-close.js";

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

afterEach(() => vi.restoreAllMocks());

function clientFor(profileId: string, scopes = ["operator.admin"]): GatewayClient {
  return authorizationClient(`users-merge-${profileId}`, scopes, {
    authenticatedUserId: `${profileId}@example.test`,
    authenticatedUserProfile: { profileId, displayName: "Person", hasAvatar: false, updatedAt: 1 },
  });
}

async function gateway() {
  const admin = ensureProfileForEmail("admin@example.test");
  setUserProfileRole(admin.id, "admin");
  const catalog = await prepareUserProfileCatalog();
  const context = {
    getRuntimeConfig: () => cfg,
    logGateway: { warn: vi.fn() },
    broadcast: vi.fn(),
    refreshConnectedUserProfile: vi.fn(),
    disconnectClientsForUserProfile: vi.fn(),
  };
  const dispatch = async (
    method: string,
    params: unknown,
    client = clientFor(admin.id),
    expectedProfileId = client.authenticatedUserProfile?.profileId,
  ) => {
    const respond = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: { type: "req", id: method, method, params, expectedProfileId },
      respond,
      client,
      isWebchatConnect: () => false,
      context: context as unknown as GatewayRequestContext,
    });
    expect(respond).toHaveBeenCalledTimes(1);
    return respond.mock.calls[0]!;
  };
  return {
    [Symbol.dispose]: catalog.release,
    admin,
    context,
    dispatch,
    merge: (sourceProfileId: string, targetProfileId: string) =>
      dispatch("users.merge", { sourceProfileId, targetProfileId }),
  };
}

function storedRedirect(profileId: string) {
  const { db } = openOpenClawStateDatabase();
  return executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profiles")
      .select("merged_into")
      .where("id", "=", profileId),
  ).rows[0]?.merged_into;
}

function expectFailure(response: Parameters<RespondFn>, message: string, exact = false) {
  expect(response[0]).toBe(false);
  expect(response[2]).toMatchObject({
    code: "INVALID_REQUEST",
    message: exact ? message : expect.stringContaining(message),
  });
}

function expectMerged(response: Parameters<RespondFn>, payload: object) {
  expect(response[0], JSON.stringify(response[2])).toBe(true);
  expect(response[1]).toMatchObject(payload);
}

it("merges an email-less person through admin RPC without main-thread SQL and retires captured authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    using rpc = await gateway();
    const providerIdentity = { login: "duplicate@github", name: "Duplicate" };
    const source = ensureProfileForTailscaleIdentity(providerIdentity);
    const target = ensureProfileForEmail("survivor@example.test");
    setDisplayName(target.id, "Survivor");
    setUserProfileRole(source.id, "admin");
    setUserProfileRole(target.id, "member");
    const identity = {
      channelId: "discord",
      accountId: "team-bot",
      senderId: "100000000000000001",
    };
    linkUserChannelIdentity(source.id, identity);
    expect(getUserProfileListItem(source.id).emails).toEqual([]);
    expect(setUserPreferences(source.id, { shared: "source", sourceOnly: true }).ok).toBe(true);
    expect(setUserPreferences(target.id, { shared: "target" }).ok).toBe(true);
    const account = connectUserModelAccount({
      ownerProfileId: source.id,
      credential: { type: "token", provider: "anthropic", token: "synthetic-merge-token" },
      assertCurrent: () => {},
    });
    for (const [profileId, authProfileId] of [
      [source.id, "openai:duplicate"],
      [target.id, "openai:survivor"],
    ] as const) {
      setUserProfileAuthLink({ profileId, provider: "openai", authProfileId });
    }
    const captured = await prepareUserProfileIdentity(source.id);
    using _ = { [Symbol.dispose]: () => captured.release() };
    const selected = await createExpectedProfileBinding(source.id, clientFor(source.id));
    expect(captured.readCurrentProfile().profileId).toBe(source.id);
    expect(() => selected?.assertCurrent()).not.toThrow();
    const params = { sourceProfileId: source.id, targetProfileId: target.id };
    const denied = await rpc.dispatch(
      "users.merge",
      params,
      clientFor(rpc.admin.id, ["operator.read", "operator.write"]),
    );
    expect(denied).toEqual([false, undefined, expect.objectContaining({ code: "FORBIDDEN" })]);
    expect(storedRedirect(source.id)).toBeNull();
    {
      using queries = vi.spyOn(DatabaseSync.prototype, "prepare");
      const response = await rpc.merge(source.id, target.id);
      expectMerged(response, {
        profile: { id: target.id, displayName: "Survivor", role: "member" },
        movedAliasKinds: ["provider", "channel"],
      });
      expect(validateUsersMergeResult(response[1])).toBe(true);
      expect(queries).not.toHaveBeenCalled();
    }
    expect(storedRedirect(source.id)).toBe(target.id);
    expect(readResidentUserProfileIdentity(source.id)?.profileId).toBe(target.id);
    expect(ensureProfileForTailscaleIdentity(providerIdentity).id).toBe(target.id);
    expect(resolveUserChannelIdentity(identity)?.profileId).toBe(target.id);
    expect(getUserPreferences(target.id)).toEqual({ shared: "target", sourceOnly: true });
    expect(listUserProfileAuthLinks(target.id)).toMatchObject([
      { provider: "anthropic", authProfileId: account.authProfileId },
      { provider: "openai", authProfileId: "openai:survivor" },
    ]);
    expect(listUserModelAccounts({ profileId: target.id }).accounts).toMatchObject([
      { authProfileId: account.authProfileId, provider: "anthropic", selected: true },
    ]);
    expect(() => captured.readCurrentProfile()).toThrow();
    expect(() => selected?.assertCurrent()).toThrow();
    const stale = await rpc.dispatch("users.prefs.get", {}, clientFor(source.id));
    expect(stale[0]).toBe(false);
    expect(stale[2]?.details).toMatchObject({ reason: "EXPECTED_PROFILE_MISMATCH" });
    expect(rpc.context.refreshConnectedUserProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: target.id, displayName: "Survivor" }),
    );
    expect(rpc.context.disconnectClientsForUserProfile.mock.calls.flat()).toEqual(
      expect.arrayContaining([source.id, target.id]),
    );
  });
});

it("flattens source cohorts, invalidates their cached roles, and rejects redirects and descendant cycles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    using rpc = await gateway();
    const ancestor = ensureProfileForEmail("ancestor@example.test");
    const source = ensureProfileForEmail("duplicate@example.test");
    const target = ensureProfileForEmail("survivor@example.test");
    const other = ensureProfileForEmail("other@example.test");
    setUserProfileRole(source.id, "admin");
    setUserProfileRole(target.id, "member");
    expect((await rpc.merge(ancestor.id, source.id))[0]).toBe(true);
    for (const id of [ancestor.id, source.id]) {
      expect(resolveOperatorRolePolicyForProfile(id, cfg)?.scopes).toEqual(["operator.admin"]);
    }
    expect(resolveOperatorRolePolicyForProfile(target.id, cfg)?.scopes).toEqual(["operator.read"]);
    rpc.context.disconnectClientsForUserProfile.mockClear();
    expectMerged(await rpc.merge(source.id, target.id), { movedAliasKinds: ["email"] });
    for (const id of [ancestor.id, source.id]) {
      expect(storedRedirect(id)).toBe(target.id);
      expect(resolveOperatorRolePolicyForProfile(id, cfg)?.scopes).toEqual(["operator.read"]);
    }
    expect(rpc.context.disconnectClientsForUserProfile.mock.calls.flat()).toEqual(
      expect.arrayContaining([ancestor.id, source.id, target.id]),
    );
    expectMerged(await rpc.merge(source.id, target.id), {
      profile: { id: target.id },
      movedAliasKinds: [],
    });
    expectFailure(await rpc.merge(source.id, other.id), target.id);
    for (const [from, into] of [
      [target.id, ancestor.id],
      [other.id, source.id],
    ] as const) {
      expectFailure(
        await rpc.merge(from, into),
        `target profile ${into} is merged into ${target.id}; choose the current merge head`,
        true,
      );
    }
    expect([target, other].map(({ id }) => storedRedirect(id))).toEqual([null, null]);
  });
});

it("rejects invalid pairs and both direct and redirected shared-owner identities without merging", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    using rpc = await gateway();
    const owner = ensureGatewayOwnerProfile(null);
    const source = ensureProfileForEmail("duplicate@example.test");
    const ownerAlias = ensureProfileForEmail("legacy-owner-alias@example.test");
    // Imported legacy state can contain a tombstone to the owner, even though new merges forbid it.
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ merged_into: owner.id })
          .where("id", "=", ownerAlias.id),
      );
    });
    const ownerError = "the shared owner profile cannot be merged";
    for (const [from, into, message] of [
      [source.id, source.id, "source and target profiles must differ"],
      ["missing-profile", source.id, "user profile not found: missing-profile"],
      [source.id, "missing-profile", "user profile not found: missing-profile"],
      [owner.id, source.id, ownerError],
      [source.id, owner.id, ownerError],
      [ownerAlias.id, source.id, ownerError],
      [source.id, ownerAlias.id, ownerError],
    ] as const) {
      expectFailure(await rpc.merge(from, into), message);
    }
    const malformed = await rpc.dispatch("users.merge", {
      sourceProfileId: source.id,
      targetProfileId: rpc.admin.id,
      unexpected: true,
    });
    expectFailure(malformed, "invalid users.merge params");
    expect([source, owner].map(({ id }) => storedRedirect(id))).toEqual([null, null]);
    expect(rpc.context.disconnectClientsForUserProfile).not.toHaveBeenCalled();
  });
});

it("delivers the merge response before closing the initiating administrator's retired connection", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    using rpc = await gateway();
    const target = ensureProfileForEmail("survivor@example.test");
    const events: string[] = [];
    const client = {
      ...clientFor(rpc.admin.id),
      socket: { close: vi.fn(() => events.push("close")) },
    };
    const respond = vi.fn<RespondFn>(() => events.push("response"));
    const policy = registerGatewayPolicyResponse("users.merge", client, respond);
    rpc.context.disconnectClientsForUserProfile.mockImplementation((id) => {
      if (id === rpc.admin.id) {
        events.push("disconnect");
        invalidateGatewayPolicyClient(client, {
          reason: "profile merged",
          code: 1008,
          message: "Profile changed; reconnect",
        });
      }
    });
    try {
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "self-merge",
          method: "users.merge",
          params: { sourceProfileId: rpc.admin.id, targetProfileId: target.id },
        },
        respond,
        client,
        isWebchatConnect: () => false,
        context: rpc.context as unknown as GatewayRequestContext,
      });
    } finally {
      policy?.finish();
    }
    expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls)).toBe(true);
    expect(events).toEqual(["disconnect", "response", "close"]);
    expect(storedRedirect(rpc.admin.id)).toBe(target.id);
  });
});
