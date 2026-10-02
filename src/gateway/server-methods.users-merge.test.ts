import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { validateUsersMergeResult } from "../../packages/gateway-protocol/src/index.js";
import { registerUsersCli } from "../cli/users-cli.js";
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
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { setDisplayName, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { userProfilesDb } from "../state/user-profiles-internal.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  getUserProfileListItem,
  resolveUserProfileId,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createExpectedProfileBinding } from "./expected-profile.js";
import { resolveOperatorRolePolicyForProfile } from "./operator-role-policy.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  invalidateGatewayPolicyClient,
  registerGatewayPolicyResponse,
} from "./server/ws-policy-close.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());
vi.mock("../cli/gateway-rpc.js", () => ({ callGatewayFromCli }));

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

afterEach(() => {
  vi.restoreAllMocks();
  callGatewayFromCli.mockReset();
});

function clientFor(profileId: string, scopes = ["operator.admin"]): GatewayClient {
  return {
    connId: `users-merge-${profileId}`,
    authenticatedUserId: `${profileId}@example.test`,
    authenticatedUserProfile: { profileId, displayName: "Person", hasAvatar: false, updatedAt: 1 },
    connect: {
      role: "operator",
      scopes,
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as GatewayClient;
}

function gateway() {
  const admin = ensureProfileForEmail("admin@example.test");
  setUserProfileRole(admin.id, "admin");
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

it("merges an email-less person through admin RPC without main-thread SQL and retires captured authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const rpc = gateway();
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
    setUserProfileAuthLink({
      profileId: source.id,
      provider: "openai",
      authProfileId: "openai:duplicate",
    });
    setUserProfileAuthLink({
      profileId: target.id,
      provider: "openai",
      authProfileId: "openai:survivor",
    });
    const captured = await prepareUserProfileIdentity(source.id);
    const selected = await createExpectedProfileBinding(source.id, clientFor(source.id));
    expect(captured.readCurrentProfile().profileId).toBe(source.id);
    expect(() => selected?.assertCurrent()).not.toThrow();
    const params = { sourceProfileId: source.id, targetProfileId: target.id };
    try {
      const denied = await rpc.dispatch(
        "users.merge",
        params,
        clientFor(rpc.admin.id, ["operator.read", "operator.write"]),
      );
      expect(denied).toEqual([false, undefined, expect.objectContaining({ code: "FORBIDDEN" })]);
      expect(storedRedirect(source.id)).toBeNull();
      const queries = vi.spyOn(DatabaseSync.prototype, "prepare");
      try {
        const response = await rpc.merge(source.id, target.id);
        expect(response[0], JSON.stringify(response[2])).toBe(true);
        expect(response[1]).toMatchObject({
          profile: { id: target.id, displayName: "Survivor", role: "member" },
          movedAliasKinds: ["provider", "channel"],
        });
        expect(validateUsersMergeResult(response[1])).toBe(true);
        expect(queries).not.toHaveBeenCalled();
      } finally {
        queries.mockRestore();
      }
      expect(storedRedirect(source.id)).toBe(target.id);
      expect(resolveUserProfileId(source.id)).toBe(target.id);
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
    } finally {
      captured.release();
    }
  });
});

it("flattens source cohorts, invalidates their cached roles, and rejects redirects and descendant cycles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const rpc = gateway();
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
    const merged = await rpc.merge(source.id, target.id);
    expect(merged[0], JSON.stringify(merged[2])).toBe(true);
    expect(merged[1]).toMatchObject({ movedAliasKinds: ["email"] });
    for (const id of [ancestor.id, source.id]) {
      expect(storedRedirect(id)).toBe(target.id);
      expect(resolveOperatorRolePolicyForProfile(id, cfg)?.scopes).toEqual(["operator.read"]);
    }
    expect(rpc.context.disconnectClientsForUserProfile.mock.calls.flat()).toEqual(
      expect.arrayContaining([ancestor.id, source.id, target.id]),
    );
    const repeat = await rpc.merge(source.id, target.id);
    expect(repeat[0], JSON.stringify(repeat[2])).toBe(true);
    expect(repeat[1]).toMatchObject({ profile: { id: target.id }, movedAliasKinds: [] });
    const elsewhere = await rpc.merge(source.id, other.id);
    expect(elsewhere[0]).toBe(false);
    expect(elsewhere[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining(target.id),
    });
    for (const [from, into] of [
      [target.id, ancestor.id],
      [other.id, source.id],
    ] as const) {
      const rejected = await rpc.merge(from, into);
      expect(rejected[0]).toBe(false);
      expect(rejected[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: `target profile ${into} is merged into ${target.id}; choose the current merge head`,
      });
    }
    expect(storedRedirect(target.id)).toBeNull();
    expect(storedRedirect(other.id)).toBeNull();
  });
});

it("rejects invalid pairs and both direct and redirected shared-owner identities without merging", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const rpc = gateway();
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
      const rejected = await rpc.merge(from, into);
      expect(rejected[0]).toBe(false);
      expect(rejected[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining(message),
      });
    }
    const malformed = await rpc.dispatch("users.merge", {
      sourceProfileId: source.id,
      targetProfileId: rpc.admin.id,
      unexpected: true,
    });
    expect(malformed[0]).toBe(false);
    expect(malformed[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("invalid users.merge params"),
    });
    expect(storedRedirect(source.id)).toBeNull();
    expect(storedRedirect(owner.id)).toBeNull();
    expect(rpc.context.disconnectClientsForUserProfile).not.toHaveBeenCalled();
  });
});

it("delivers the merge response before closing the initiating administrator's retired connection", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const rpc = gateway();
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

it("runs users merge CLI arguments through the registered RPC and emits its survivor result", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const rpc = gateway();
    const source = ensureProfileForTailscaleIdentity({ login: "cli-duplicate@github" });
    const target = ensureProfileForEmail("cli-survivor@example.test");
    callGatewayFromCli.mockImplementation(async (method, _options, params, rpcOptions) => {
      const response = await rpc.dispatch(
        method,
        params,
        clientFor(rpc.admin.id, rpcOptions.scopes),
      );
      if (!response[0]) {
        throw new Error(response[2]?.message ?? "Gateway request failed");
      }
      return response[1];
    });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command().exitOverride();
    registerUsersCli(program);
    await program.parseAsync([
      "node",
      "openclaw",
      "users",
      "merge",
      source.id,
      "--into",
      target.id,
      "--json",
    ]);
    const response = JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join(""));
    expect(response).toMatchObject({ profile: { id: target.id }, movedAliasKinds: ["provider"] });
    expect(storedRedirect(source.id)).toBe(target.id);
  });
});
