// Install synthetic OAuth and subprocess transport before RPC modules load.
// oxfmt-ignore
import { createGitHubTestClient, network, resetPersonalGitHubNetwork, tokens } from "./users-github.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import type { UsersGitHubAuthorizeStartResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  listGitHubDeviceAuthorizationRecords,
  listGitHubOAuthRecords,
  readGitHubDeviceAuthorizationRecord,
  writeGitHubDeviceAuthorizationRecord,
} from "../../agents/github-oauth-records.js";
import {
  prepareGitHubToolEnvironment,
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../../agents/github-tool-identity.js";
import { cleanupRetiredManagedGitHubProfiles } from "../../agents/github-tool-profile-cleanup.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimePluginScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveCommandEnv } from "../../process/exec-spawn.js";
import * as secretsRuntime from "../../secrets/runtime-state.js";
import {
  listSecretStoreEntries,
  readSecretStoreExecEnvironment,
  purgeExpiredSecretStoreEntries,
  writeSecretStoreEntry,
} from "../../secrets/store/secret-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { dumpGitBackupDatabase } from "../../snapshot/git-backup-codec.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as stateLease from "../../state/openclaw-state-lease.js";
import { observeUserGitHubConnectionAuthority } from "../../state/user-github-connection-events.js";
import {
  observeUserGitHubProfileRetirement,
  readUserGitHubConnectionAsync as readConnection,
} from "../../state/user-github-connections.js";
import { resolvePersonalGitHubOwnerInDatabase } from "../../state/user-github-connections.kernel.js";
import {
  expireUserGitHubAccessToken,
  expireUserGitHubAuthorization,
  updateUserGitHubConnection,
} from "../../state/user-github-connections.test-support.js";
import { getUserProfileListItem } from "../../state/user-profile-list-item.test-support.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { linkCanonicalUserProfileEmail } from "../../state/user-profile-writes.js";
import { linkEmail, setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { GitHubCliUnavailableError } from "../github-cli-preflight.js";
import { createGitHubOAuthLifecycle } from "../github-oauth-lifecycle.js";
import { bindPersonalGitHubPublicationSelection } from "../github-personal-publication.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import {
  expectReceiptBackedPersonalGitHubAuthority,
  preparePersonalGitHubPoll,
} from "./users-github.authority.test-support.js";

type AuthorityChange = Parameters<Parameters<typeof observeUserGitHubConnectionAuthority>[0]>[0];

let state: OpenClawTestState;
let lifecycle: ReturnType<typeof createGitHubOAuthLifecycle>;
let config: OpenClawConfig;
let clients: Set<GatewayClient>;
let context: GatewayRequestContext;
let alice: GatewayClient;
let bob: GatewayClient;
let profileCatalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>>;

function user(email: string, scopes = ["operator.read"]): GatewayClient {
  const client = createGitHubTestClient(ensureProfileForEmail(email), email, scopes);
  clients.add(client);
  return client;
}
const owner = (client = alice): string => client.authenticatedUserProfile!.profileId;
const resolveOwner = (profile: string, db = openOpenClawStateDatabase().db) =>
  resolvePersonalGitHubOwnerInDatabase(profile, db);
async function rpc(client: GatewayClient, method: string, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: `rpc-${method}`, method, params },
    client,
    context,
    respond,
    isWebchatConnect: () => false,
  });
  return respond;
}
async function start(client = alice): Promise<UsersGitHubAuthorizeStartResult> {
  const respond = await rpc(client, "users.github.authorize.start");
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]![1] as UsersGitHubAuthorizeStartResult;
}
function preparePoll(client = alice) {
  preparePersonalGitHubPoll(owner(client));
}
async function connect(client = alice) {
  const started = await start(client);
  preparePoll(client);
  const result = await rpc(client, "users.github.authorize.poll", { requestId: started.requestId });
  expect(result.mock.calls[0]?.[1]).toMatchObject({ status: "success" });
  const connection = (await readConnection(owner(client)))!;
  if (connection.selection.kind !== "connected") {
    throw new Error("Expected connected GitHub account");
  }
  return { ...connection, selection: connection.selection };
}

beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
  config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
  setRuntimeConfigSnapshot(config);
  clients = new Set();
  alice = user("alice@example.test");
  bob = user("bob@example.test");
  profileCatalog = await prepareUserProfileCatalog();
  resetPersonalGitHubNetwork();
  lifecycle = createGitHubOAuthLifecycle({
    scheduler: createTestGatewayScheduler(),
    getConfig: () => config,
    getPersistedConfig: async () => config,
    warn: vi.fn(),
  });
  context = {
    getRuntimeConfig: () => config,
    githubOAuthService: lifecycle,
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(
        [...clients].filter((client) => !filter || filter(client)).map((client) => client.connId!),
      ),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
});
afterEach(async () => {
  await lifecycle.stop();
  profileCatalog.release();
  await state.cleanup();
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
});

describe("personal GitHub through authenticated Gateway RPC", () => {
  it("uses committed profile authority at the effect without host reads", async () => {
    await expectReceiptBackedPersonalGitHubAuthority({
      client: alice,
      context,
      merge: () => linkEmail("alice@example.test", owner(bob)),
      disconnect: () => clients.delete(alice),
    });
  });

  it("revokes prepared publication credentials from the disconnect receipt without host reads", async () => {
    const connection = await connect();
    const bound = await bindPersonalGitHubPublicationSelection(
      {
        owner: owner(),
        assertCurrent() {},
        sessionId: "publication-session",
        sessionKey: "agent:main:publication",
        agentId: "main",
        lifecycleRevision: null,
      },
      { generation: connection.generation, account: connection.selection },
    );
    const reads = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(bound.assertCurrent().accountId).toBe(101);
      expect(reads.queries).toEqual([]);
      expect(await rpc(alice, "users.github.disconnect")).toHaveBeenCalledWith(true, {
        disconnected: true,
      });
      // Disconnect also retires profile files under a native SQLite lease.
      reads.queries.length = 0;
      expect(() => bound.assertCurrent()).toThrow();
      expect(reads.queries).toEqual([]);
    } finally {
      reads.restore();
    }
  });

  it.each(["users.github.status", "tools.github.status"])(
    "%s reports execution authentication instead of a resolved preview credential",
    async (method) => {
      const sourceConfig: OpenClawConfig = {
        ...config,
        gateway: {
          controlUi: {
            github: { token: { source: "env", provider: "default", id: "GH_TOKEN" } },
          },
        },
      };
      config = {
        ...config,
        gateway: { controlUi: { github: { token: "synthetic-preview" } } },
      };
      setRuntimeConfigSnapshot(config, sourceConfig);
      const snapshot = vi
        .spyOn(secretsRuntime, "getActiveSecretsRuntimeConfigSnapshot")
        .mockReturnValue({ config, sourceConfig, configRefsPrepared: true });
      vi.stubEnv("GH_TOKEN", "synthetic-preview");
      vi.stubEnv("GITHUB_TOKEN", "synthetic-native");
      network.command.mockImplementation(
        async (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
          const env = resolveCommandEnv({ argv, env: options.env });
          return {
            code: argv[0] === "git" ? 1 : 0,
            stdout: Buffer.from(
              argv[0] === "gh" ? env.GH_TOKEN || env.GITHUB_TOKEN || "synthetic-native" : "",
            ),
            stderr: Buffer.alloc(0),
          };
        },
      );
      try {
        const response = await rpc(
          alice,
          method,
          method === "tools.github.status" ? { agentId: "main", selectedScope: "agent" } : {},
        );
        expect(response.mock.calls[0]?.[0]).toBe(true);
        expect(response.mock.calls[0]?.[1]).toMatchObject({
          [method === "users.github.status" ? "system" : "effective"]: {
            source: "system-detected",
            credentialState: "available",
            account: { login: "system-bot" },
          },
        });
        expect(network.refresh).not.toHaveBeenCalled();
      } finally {
        snapshot.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["native", "managed"] as const)(
    "reads personal and %s system status without selecting an agent",
    async (systemKind) => {
      const profileId = "ghp_12121212121212121212121212121212";
      config.agents = {
        entries: {
          alpha: {
            workspace: state.path("alpha-workspace"),
            tools: { github: { profileId: "ghp_34343434343434343434343434343434" } },
          },
          beta: { workspace: state.path("beta-workspace") },
        },
      };
      if (systemKind === "managed") {
        config.tools = { github: { profileId } };
        await writeManagedGitHubProfileFiles(
          resolveManagedGitHubProfileDir({ scope: "system", agentId: "", profileId }),
          { login: "system-bot", token: "synthetic-native" },
        );
      }
      await connect();
      network.verify.mockClear();
      const response = await rpc(alice, "users.github.status");
      expect(response.mock.calls[0]?.[0]).toBe(true);
      expect(response.mock.calls[0]?.[1]).toMatchObject({
        personal: { state: "connected", account: { login: "personal-alice" } },
        system: {
          source: systemKind === "managed" ? "system-configured" : "system-detected",
          credentialState: "available",
          account: { login: "system-bot" },
        },
      });
      expect(network.verify.mock.calls.map(([token]) => token)).toEqual([
        "synthetic-native",
        tokens.accessToken,
      ]);
      const gitProbes = network.command.mock.calls.filter(([argv]) => argv[0] === "git");
      expect(gitProbes).toHaveLength(1);
      expect(gitProbes[0]?.[1]?.cwd).toBe(state.stateDir);
    },
  );

  it("keeps RPC writes off the Gateway thread and legacy completion synchronous", async () => {
    await start();
    const writes = vi.spyOn(StatementSync.prototype, "run");
    try {
      const pending = await start();
      expect(
        await rpc(alice, "users.github.authorize.cancel", { requestId: pending.requestId }),
      ).toHaveBeenCalledWith(true, { cancelled: true });
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
    }
    const pending = await start();
    const action = { owner: owner(), assertCurrent: () => {} };
    const publications: AuthorityChange[] = [];
    const unobserve = observeUserGitHubConnectionAuthority((commit) => publications.push(commit));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      await withPluginRuntimePluginScope(
        { pluginId: "personal-github-legacy-service-test" },
        async () => {
          expect(lifecycle.personal.cancelAuthorization(action, pending.requestId)).toBe(true);
          expect(publications).toHaveLength(1);
          expect((await readConnection(owner()))?.pending).toBeUndefined();
          expect(lifecycle.personal.cancelAuthorization(action, pending.requestId)).toBe(false);
          expect(publications).toHaveLength(1);
          const previous = (await readConnection(owner()))?.generation;
          expect(lifecycle.personal.disconnect(action)).toBeUndefined();
          expect(publications).toHaveLength(2);
          const disconnected = await readConnection(owner());
          expect(disconnected?.generation).not.toBe(previous);
          expect(disconnected?.selection).toEqual({ kind: "disconnected" });
        },
      );
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("personal.cancelAuthorizationAsync"),
        { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
      );
    } finally {
      unobserve();
      warning.mockRestore();
    }
  });

  it("rejects a missing GitHub CLI before creating personal authorization state", async () => {
    network.assertCli.mockImplementationOnce(() => {
      throw new GitHubCliUnavailableError();
    });

    const response = await rpc(alice, "users.github.authorize.start");

    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(response.mock.calls)).toContain(
      "GitHub CLI (`gh`) is required on the Gateway host. Install it and retry.",
    );
    expect(network.start).not.toHaveBeenCalled();
    expect(await readConnection(owner())).toBeUndefined();
  });

  it.each(["disconnect", "role"] as const)(
    "rechecks %s after personal status verification",
    async (race) => {
      await connect();
      const verify = network.verify.getMockImplementation()!;
      network.verify.mockImplementation(async (token, options) => {
        if (token === tokens.accessToken) {
          if (race === "disconnect") {
            await rpc(alice, "users.github.disconnect");
          } else {
            config.gateway = {
              roles: {
                definitions: { blocked: { scopes: [], agents: [], sessions: { others: "none" } } },
                default: "blocked",
              },
            };
            setUserProfileRole(owner(), "blocked");
            invalidateOperatorRolePolicy(owner());
          }
        }
        return await verify(token, options);
      });
      const response = await rpc(alice, "users.github.status");
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(response.mock.calls[0]?.[1]).toBeUndefined();
    },
  );

  it.each(["missing", "tokenless", "corrupt"])(
    "reports a %s personal profile unavailable despite native authentication",
    async (failure) => {
      const connected = await connect();
      if (connected.selection.kind !== "connected") {
        throw new Error("Expected connected profile");
      }
      const dir = resolveManagedGitHubProfileDir({
        scope: "personal",
        agentId: "",
        profileId: connected.selection.profileId,
      });
      if (failure === "missing") {
        await fs.rm(dir, { recursive: true });
      } else {
        await fs.writeFile(
          path.join(dir, "hosts.yml"),
          failure === "tokenless" ? "{}" : "github.com: [invalid",
          { mode: 0o600 },
        );
      }
      const response = await rpc(alice, "users.github.status");
      expect(response.mock.calls[0]?.[0]).toBe(true);
      expect(response.mock.calls[0]?.[1]).toMatchObject({
        personal: { state: "unavailable" },
        system: { credentialState: "available", account: { login: "system-bot" } },
      });
    },
  );

  it("preserves administrator System authorization and keeps its pending codes separate", async () => {
    alice.connect.scopes = ["operator.admin"];
    const system = await rpc(alice, "tools.github.authorize.start", {
      scope: "system",
      agentId: "main",
    });
    expect(system.mock.calls[0]?.[0]).toBe(true);
    expect(system.mock.calls[0]?.[1]).toMatchObject({
      requestId: expect.stringMatching(/^github-device-/),
    });
    expect((await rpc(alice, "users.github.status")).mock.calls[0]?.[1]).toMatchObject({
      personal: { pending: null, state: "disconnected" },
    });
  });

  it.each([
    { scope: "system", kind: "pat" },
    { scope: "agent", kind: "pat" },
    { scope: "system", kind: "oauth" },
    { scope: "agent", kind: "oauth" },
  ] as const)(
    "installs $scope $kind without mutating native GitHub authentication",
    async ({ scope, kind }) => {
      alice.connect.scopes = ["operator.admin"];
      await state.writeConfig(config);
      if (kind === "pat") {
        const secretName = "github-setup-11111111111111111111111111111111";
        await writeSecretStoreEntry({
          scope: { kind: "team" },
          name: secretName,
          value: tokens.accessToken,
          kind: "secret",
          updatedBy: "test",
        });
        const response = await rpc(alice, "tools.github.configure", {
          scope,
          agentId: "main",
          mode: "managed",
          secretName,
        });
        expect(response.mock.calls[0]?.[0]).toBe(true);
        expect(response.mock.calls[0]?.[1]).toMatchObject({
          selected: { identity: { credentialKind: "managed-pat", credentialState: "available" } },
        });
      } else {
        const response = await rpc(alice, "tools.github.authorize.start", {
          scope,
          agentId: "main",
        });
        expect(response.mock.calls[0]?.[0]).toBe(true);
        const { requestId } = response.mock.calls[0]![1] as { requestId: string };
        const pending = await readGitHubDeviceAuthorizationRecord(requestId);
        if (!pending) {
          throw new Error("Expected shared device authorization");
        }
        await writeGitHubDeviceAuthorizationRecord({ ...pending, nextPollAtMs: Date.now() });
        const polled = await rpc(alice, "tools.github.authorize.poll", { requestId });
        expect(polled.mock.calls[0]?.[1]).toMatchObject({ status: "success" });
      }
      config = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
      setRuntimeConfigSnapshot(config);
      const identity =
        scope === "system" ? config.tools?.github : config.agents?.entries?.main?.tools?.github;
      if (!identity) {
        throw new Error("Expected configured shared GitHub identity");
      }
      const dir = resolveManagedGitHubProfileDir({
        scope,
        agentId: "main",
        profileId: identity.profileId,
      });
      expect(parseYaml(await fs.readFile(path.join(dir, "hosts.yml"), "utf8"))).toMatchObject({
        "github.com": { user: "personal-alice", oauth_token: tokens.accessToken },
      });
      expect(network.verify.mock.calls.some(([token]) => token === tokens.accessToken)).toBe(true);
      expect(
        network.command.mock.calls.some(
          ([argv]) =>
            argv[0] === "gh" &&
            argv[1] === "auth" &&
            ["login", "logout", "switch"].includes(argv[2]),
        ),
      ).toBe(false);
      expect(
        JSON.stringify(prepareGitHubToolEnvironment({ config, agentId: "main" })),
      ).not.toContain(tokens.accessToken);
    },
  );

  it("lets an identified reader manage only My GitHub without changing sign-in or agent identity", async () => {
    const before = getUserProfileListItem(owner());
    const connection = await connect();
    const status = await rpc(alice, "users.github.status");
    expect(status.mock.calls[0]?.[1]).toMatchObject({
      personal: { state: "connected", account: { accountId: 101, login: "personal-alice" } },
      system: { source: "system-detected", account: { login: "system-bot" } },
    });
    expect(getUserProfileListItem(owner())).toEqual(before);
    expect(config.tools?.github).toBeUndefined();
    expect(prepareGitHubToolEnvironment({ config, agentId: "main" }).localIdentityEnv).toEqual({});
    expect(await rpc(alice, "users.self")).toHaveBeenCalledWith(true, { profile: before });
    for (const [method, missingScope] of [
      ["tools.github.authorize.start", "operator.admin"],
      ["tools.github.configure", "operator.admin"],
      ["secrets.store.set", "operator.admin"],
      ["sessions.github.publish", "operator.sessions.write"],
    ] as const) {
      const denied = await rpc(alice, method, {
        sessionKey: "agent:main:main",
        idempotencyKey: "reader",
      });
      expect(denied, method).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          details: {
            code: "MISSING_SCOPE",
            missingScope,
            requiredScopes: [missingScope],
          },
        }),
      );
    }
    const restarted = await start();
    expect((await readConnection(owner()))?.generation).toBe(connection.generation);
    expect(
      await rpc(alice, "users.github.authorize.cancel", { requestId: restarted.requestId }),
    ).toHaveBeenCalledWith(true, { cancelled: true });
    expect(await rpc(alice, "users.github.disconnect")).toHaveBeenCalledWith(true, {
      disconnected: true,
    });
    expect((await readConnection(owner()))?.selection.kind).toBe("disconnected");
    expect((await readConnection(owner()))?.generation).not.toBe(connection.generation);
  });

  it("preserves personal scope order and repairs corrupt state only on explicit disconnect", async () => {
    network.poll.mockResolvedValueOnce({
      status: "authorized",
      tokens: { ...tokens, scopes: ["workflow", "repo", "repo"] },
    });
    const connected = await connect();
    expect(connected.selection).toMatchObject({ scopes: ["workflow", "repo", "repo"] });
    const db = requireNativeSqliteDatabase(openOpenClawStateDatabase().db);
    db.prepare(
      "UPDATE secret_store_entries SET value = ? WHERE scope_kind = 'identity' AND scope_id = ? AND name = 'github-connection'",
    ).run(
      JSON.stringify({ ...connected, selection: { ...connected.selection, refreshToken: null } }),
      owner(),
    );
    // Out-of-owner corruption is observed when the physical database is reopened.
    closeOpenClawStateDatabaseByPath(db.location()!);
    await expect(readConnection(owner())).rejects.toThrow("Personal GitHub state is invalid");
    await expect(lifecycle.personal.refresh(owner())).rejects.toThrow(
      "Personal GitHub state is invalid",
    );
    expect(await rpc(alice, "users.github.disconnect")).toHaveBeenCalledWith(true, {
      disconnected: true,
    });
    expect((await readConnection(owner()))?.selection).toEqual({
      kind: "disconnected",
    });
  });

  it("rejects copied pending IDs before lookup, deduplication, or cancellation", async () => {
    const started = await start();
    preparePoll();
    const waiting = createDeferredCore<{ status: "authorized"; tokens: typeof tokens }>();
    network.poll.mockReturnValueOnce(waiting.promise);
    const pending = rpc(alice, "users.github.authorize.poll", { requestId: started.requestId });
    await vi.waitFor(() => expect(network.poll).toHaveBeenCalledOnce());
    expect(
      await rpc(bob, "users.github.authorize.poll", { requestId: started.requestId }),
    ).toHaveBeenCalledWith(true, { status: "expired" });
    expect(
      await rpc(bob, "users.github.authorize.cancel", { requestId: started.requestId }),
    ).toHaveBeenCalledWith(true, { cancelled: false });
    expect((await rpc(bob, "users.github.status")).mock.calls[0]?.[1]).toMatchObject({
      personal: { pending: null, account: null },
    });
    waiting.resolve({ status: "authorized", tokens });
    expect((await pending).mock.calls[0]?.[1]).toMatchObject({ status: "success" });
    expect(network.poll).toHaveBeenCalledOnce();
  });

  it("lets a shared-secret owner without a login read status and start My GitHub authorization", async () => {
    const profile = ensureGatewayOwnerProfile("Gateway Owner");
    delete alice.authenticatedUserId;
    alice.authenticatedUserProfile = {
      profileId: profile.id,
      displayName: profile.displayName,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    };
    alice.internal = { operatorRoleActor: { kind: "system" } };

    expect(await rpc(alice, "users.github.status")).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ personal: expect.objectContaining({ state: "disconnected" }) }),
    );
    const started = await start(alice);
    expect((await readConnection(profile.id))?.pending?.requestId).toBe(started.requestId);
  });

  it.each([
    "unbound",
    "synthetic",
    "synthetic-system",
    "copied-client",
    "system-without-profile",
    "operator-actor",
  ] as const)("rejects %s profile-like authorization", async (mode) => {
    let client = alice;
    if (mode === "unbound") {
      delete client.authenticatedUserProfile;
    }
    if (mode === "synthetic") {
      client.internal = { syntheticClient: true };
    }
    if (mode === "synthetic-system") {
      client.internal = { syntheticClient: true, operatorRoleActor: { kind: "system" } };
    }
    if (mode === "operator-actor") {
      client.internal = { operatorRoleActor: { kind: "operator", profileId: owner(client) } };
    }
    if (mode === "copied-client") {
      client = { ...client };
    }
    if (mode === "system-without-profile") {
      delete client.authenticatedUserId;
      delete client.authenticatedUserProfile;
      client.internal = { operatorRoleActor: { kind: "system" } };
    }
    for (const method of [
      "users.github.status",
      "users.github.authorize.start",
      "users.github.disconnect",
    ]) {
      expect((await rpc(client, method)).mock.calls[0]?.[0]).toBe(false);
    }
    expect(network.start).not.toHaveBeenCalled();
  });

  it.each(["cancel", "disconnect", "replacement", "merge", "role", "expiry"] as const)(
    "fences installation when %s wins the awaited poll",
    async (race) => {
      const started = await start();
      preparePoll();
      const waiting = createDeferredCore<{ status: "authorized"; tokens: typeof tokens }>();
      network.poll.mockReturnValueOnce(waiting.promise);
      const pending = rpc(alice, "users.github.authorize.poll", { requestId: started.requestId });
      await vi.waitFor(() => expect(network.poll).toHaveBeenCalledOnce());
      if (race === "cancel") {
        await rpc(alice, "users.github.authorize.cancel", { requestId: started.requestId });
      }
      if (race === "disconnect") {
        await rpc(alice, "users.github.disconnect");
      }
      if (race === "replacement") {
        await start();
      }
      if (race === "merge") {
        linkEmail("alice@example.test", owner(bob));
      }
      if (race === "role") {
        config.gateway = {
          roles: {
            definitions: { blocked: { scopes: [], agents: [], sessions: { others: "none" } } },
            default: "blocked",
          },
        };
        setUserProfileRole(owner(), "blocked");
        invalidateOperatorRolePolicy(owner());
      }
      if (race === "expiry") {
        expireUserGitHubAuthorization(owner());
      }
      waiting.resolve({ status: "authorized", tokens });
      const response = await pending;
      expect(response.mock.calls[0]?.[1]).not.toMatchObject({ status: "success" });
      expect((await readConnection(resolveOwner(owner())!))?.selection.kind).toBe("disconnected");
      expect(network.command.mock.calls.some(([argv]) => argv[1] === "auth")).toBe(false);
    },
  );

  it("does not let an older start overwrite a newer start or disconnected generation", async () => {
    const old = createDeferredCore<Awaited<ReturnType<typeof network.start>>>();
    const entered = createDeferredCore();
    network.start.mockImplementationOnce(() => {
      entered.resolve();
      return old.promise;
    });
    const pending = rpc(alice, "users.github.authorize.start");
    expect(
      await Promise.race([
        entered.promise.then(() => ({ started: true })),
        pending.then((response) => ({ response: response.mock.calls })),
      ]),
    ).toEqual({ started: true });
    expect(network.start).toHaveBeenCalledOnce();
    await rpc(alice, "users.github.disconnect");
    const newer = await start();
    old.resolve({
      deviceCode: "e".repeat(40),
      userCode: "EFGH-5678",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    });
    expect((await pending).mock.calls[0]?.[0]).toBe(false);
    expect((await readConnection(owner()))?.pending?.requestId).toBe(newer.requestId);
  });

  it.each(["cancel", "disconnect", "expiry"] as const)(
    "rechecks %s after credential verification before the final connection commit",
    async (race) => {
      const started = await start();
      preparePoll();
      const fallback = network.verify.getMockImplementation()!;
      network.verify.mockImplementation(async (token, options) => {
        const result = await fallback(token, options);
        if (token === tokens.accessToken) {
          if (race === "cancel") {
            await rpc(alice, "users.github.authorize.cancel", { requestId: started.requestId });
          }
          if (race === "disconnect") {
            await rpc(alice, "users.github.disconnect");
          }
          if (race === "expiry") {
            expireUserGitHubAuthorization(owner());
          }
        }
        return result;
      });
      expect(
        (await rpc(alice, "users.github.authorize.poll", { requestId: started.requestId })).mock
          .calls[0]?.[1],
      ).not.toMatchObject({ status: "success" });
      expect((await readConnection(owner()))?.selection.kind).toBe("disconnected");
    },
  );

  it.each(["absent", "disconnected", "connected"] as const)(
    "merges credentials only when the target is %s, cancels pending flows, and rotates authority",
    async (target) => {
      const source = await connect();
      if (target === "disconnected") {
        await rpc(bob, "users.github.disconnect");
      }
      if (target === "connected") {
        await connect(bob);
      }
      const previousTarget = await readConnection(owner(bob));
      await start();
      const retired: string[] = [];
      const observedOwners: Array<string | undefined> = [];
      const authorityOwners: Array<string | undefined> = [];
      const authoritySeenAtRetirement: number[] = [];
      const publications: AuthorityChange[] = [];
      const unobserveAuthority = observeUserGitHubConnectionAuthority((publication) => {
        authorityOwners.push(resolveOwner(owner()));
        publications.push(publication);
      });
      const unobserve = observeUserGitHubProfileRetirement((ids) => {
        authoritySeenAtRetirement.push(publications.length);
        observedOwners.push(resolveOwner(owner()));
        retired.push(...ids);
      });
      try {
        await linkCanonicalUserProfileEmail("alice@example.test", owner(bob));
      } finally {
        unobserve();
        unobserveAuthority();
      }
      expect(retired).toEqual(
        target === "absent" || source.selection.kind !== "connected"
          ? []
          : [source.selection.profileId],
      );
      expect(observedOwners).toEqual(target === "absent" ? [] : [owner(bob)]);
      expect(authorityOwners).toEqual([owner(bob)]);
      expect(authoritySeenAtRetirement).toEqual(target === "absent" ? [] : [1]);
      const merged = await readConnection(owner(bob));
      expect(merged?.selection).toEqual((previousTarget ?? source).selection);
      expect(merged?.pending).toBeUndefined();
      expect(merged?.generation).not.toBe(source.generation);
      expect(merged?.generation).not.toBe(previousTarget?.generation);
      expect(publications).toEqual([
        {
          kind: "user-github-connection",
          databasePath: openOpenClawStateDatabase().path,
          changedOwners: [owner(), owner(bob)],
          retiredProfileIds: retired,
        },
      ]);
      expect(JSON.stringify(publications)).not.toContain(tokens.accessToken);
      expect(JSON.stringify(publications)).not.toContain(tokens.refreshToken);
    },
  );

  it.each(["source", "target", "both", "source-with-absent-target"] as const)(
    "isolates corrupt %s GitHub state from canonical profile merging",
    async (corrupt) => {
      await connect();
      const target = corrupt === "source-with-absent-target" ? undefined : await connect(bob);
      const db = openOpenClawStateDatabase().db;
      for (const client of corrupt === "both"
        ? [alice, bob]
        : [corrupt.startsWith("source") ? alice : bob]) {
        db.prepare(
          "UPDATE secret_store_entries SET value = ? WHERE scope_kind = 'identity' AND scope_id = ? AND name = 'github-connection'",
        ).run("{invalid-personal-json", owner(client));
      }
      expect(() => linkEmail("alice@example.test", owner(bob))).not.toThrow();
      expect(resolveOwner(owner(), db)).toBe(owner(bob));
      const merged = await readConnection(owner(bob));
      expect(merged?.selection).toEqual(
        corrupt === "source" ? target!.selection : { kind: "disconnected" },
      );
      expect(merged?.generation).not.toBe(target?.generation);
      expect(merged?.pending).toBeUndefined();
      expect((await rpc(bob, "users.github.authorize.start")).mock.calls[0]?.[0]).toBe(true);
    },
  );

  it("rolls back the profile merge on a real database failure instead of classifying it as corrupt credentials", async () => {
    const before = await connect();
    const db = openOpenClawStateDatabase().db;
    db.exec(`CREATE TEMP TRIGGER reject_personal_merge BEFORE INSERT ON secret_store_entries
      BEGIN SELECT RAISE(ABORT, 'synthetic merge storage failure'); END`);
    expect(() => linkEmail("alice@example.test", owner(bob))).toThrow(
      "synthetic merge storage failure",
    );
    db.exec("DROP TRIGGER reject_personal_merge");
    expect(resolveOwner(owner(), db)).toBe(owner());
    expect(await readConnection(owner())).toEqual(before);
    expect(await readConnection(owner(bob))).toBeUndefined();
  });

  it("does not adopt credentials stranded on an alias by an older profile merge", async () => {
    await connect();
    profileCatalog.release();
    openOpenClawStateDatabase()
      .db.prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?")
      .run(owner(bob), owner());
    profileCatalog = await prepareUserProfileCatalog();
    expect((await rpc(alice, "users.github.status")).mock.calls[0]?.[1]).toMatchObject({
      personal: { state: "disconnected", account: null },
    });
    await lifecycle.personal.maintain();
    expect(await readConnection(owner(bob))).toBeUndefined();
    profileCatalog.release();
    openOpenClawStateDatabase()
      .db.prepare("DELETE FROM user_profiles WHERE id = ?")
      .run(owner(bob));
    profileCatalog = await prepareUserProfileCatalog();
    expect((await rpc(alice, "users.github.authorize.start")).mock.calls[0]?.[0]).toBe(false);
  });

  it("keeps private credentials outside generic store access, exec projection, backups, and shared cleanup", async () => {
    const connected = await connect();
    const dir = resolveManagedGitHubProfileDir({
      agentId: "",
      scope: "personal",
      profileId: connected.selection.profileId,
    });
    expect(dir).toContain(path.join("credentials", "github", "personal"));
    expect((await fs.stat(dir)).mode & 0o077).toBe(0);
    expect(await listSecretStoreEntries({ scope: { kind: "team" } })).toEqual([]);
    expect(await readSecretStoreExecEnvironment({ includeSecretSentinels: true })).toEqual({});
    expect(await listGitHubOAuthRecords()).toEqual([]);
    expect(await listGitHubDeviceAuthorizationRecords()).toEqual([]);
    await purgeExpiredSecretStoreEntries();
    await cleanupRetiredManagedGitHubProfiles({ config });
    expect(await fs.readFile(path.join(dir, "hosts.yml"), "utf8")).toContain(tokens.accessToken);
    const database = openOpenClawStateDatabase();
    const manifest = await dumpGitBackupDatabase({
      snapshotPath: database.path,
      outputPath: state.path("redacted-backup"),
      identity: { role: "global" },
      excludeSecrets: true,
    });
    expect(manifest.excludedTables).toContain("secret_store_entries");
    const status = (await rpc(alice, "users.github.status")).mock.calls[0]?.[1];
    expect(JSON.stringify(status)).not.toMatch(
      /synthetic-access|synthetic-refresh|ghp_|credentials/,
    );
  });

  it("skips maintenance leases for fresh personal connections", async () => {
    const connection = await connect();
    const lease = vi.spyOn(stateLease, "withOpenClawStateLease");
    try {
      await lifecycle.personal.maintain();
      expect(lease).not.toHaveBeenCalled();
      expect(network.refresh).not.toHaveBeenCalled();
      expect(await readConnection(owner())).toEqual(connection);
    } finally {
      lease.mockRestore();
    }
  });

  it.each(["fresh", "disconnected"])(
    "rechecks %s credentials after acquiring the refresh lease",
    async (kind) => {
      const connected = await connect();
      expireUserGitHubAccessToken(owner());
      const current =
        kind === "fresh"
          ? connected
          : {
              ...connected,
              selection: { kind: "disconnected" as const },
            };
      const acquire = stateLease.withOpenClawStateLease;
      const lease = vi
        .spyOn(stateLease, "withOpenClawStateLease")
        .mockImplementation((options, run) =>
          acquire(options, async (owned) => {
            updateUserGitHubConnection(
              owner(),
              () => current,
              () => owned.assertOwned(),
            );
            return run(owned);
          }),
        );
      try {
        await lifecycle.personal.refresh(owner());
        expect(lease).toHaveBeenCalled();
        expect(network.refresh).not.toHaveBeenCalled();
        expect(await readConnection(owner())).toEqual(current);
      } finally {
        lease.mockRestore();
      }
    },
  );

  it("preserves rotated tokens across merge and local materialization failure without preserving old action authority", async () => {
    const connection = await connect();
    expireUserGitHubAccessToken(owner());
    const refresh = createDeferredCore<{ status: "refreshed"; tokens: typeof tokens }>();
    network.refresh.mockReturnValueOnce(refresh.promise);
    const pending = lifecycle.personal.refresh(owner());
    await vi.waitFor(() => expect(network.refresh).toHaveBeenCalledOnce());
    linkEmail("alice@example.test", owner(bob));
    network.verify.mockResolvedValueOnce({ status: "unverified" });
    refresh.resolve({
      status: "refreshed",
      tokens: { ...tokens, accessToken: "new-access", refreshToken: "new-refresh" },
    });
    await expect(pending).rejects.toThrow();
    expect((await readConnection(owner(bob)))?.selection).toMatchObject({
      profileId: connection.selection.profileId,
      refreshToken: "new-refresh",
      refresh: { tokens: { accessToken: "new-access" } },
    });
    expect((await readConnection(owner(bob)))?.generation).not.toBe(connection.generation);
    await lifecycle.personal.refresh(owner(bob));
    expect((await readConnection(owner(bob)))?.selection).toMatchObject({
      refreshToken: "new-refresh",
    });
    expect((await readConnection(owner(bob)))?.selection).not.toHaveProperty("refresh");
    expect(network.refresh).toHaveBeenCalledOnce();
  });

  it("does not resurrect a disconnected selection from a late remote refresh", async () => {
    await connect();
    expireUserGitHubAccessToken(owner());
    const refresh = createDeferredCore<{ status: "refreshed"; tokens: typeof tokens }>();
    network.refresh.mockReturnValueOnce(refresh.promise);
    const pending = lifecycle.personal.refresh(owner());
    await vi.waitFor(() => expect(network.refresh).toHaveBeenCalledOnce());
    await rpc(alice, "users.github.disconnect");
    const generation = (await readConnection(owner()))?.generation;
    refresh.resolve({ status: "refreshed", tokens });
    await pending;
    await lifecycle.personal.maintain();
    expect(await readConnection(owner())).toMatchObject({
      generation,
      selection: { kind: "disconnected" },
    });
  });

  it.each([false, true])(
    "recovers an exact remote rotation after persistence failure, disconnected=%s",
    async (disconnect) => {
      await connect();
      expireUserGitHubAccessToken(owner());
      const db = openOpenClawStateDatabase().db;
      db.exec(
        "CREATE TRIGGER reject_rotation BEFORE UPDATE ON secret_store_entries WHEN NEW.value LIKE '%synthetic-rotated-refresh%' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
      );
      await expect(lifecycle.personal.refresh(owner())).rejects.toThrow("synthetic write failure");
      db.exec("DROP TRIGGER reject_rotation");
      if (disconnect) {
        await rpc(alice, "users.github.disconnect");
      }
      await lifecycle.personal.maintain();
      expect(network.refresh).toHaveBeenCalledOnce();
      expect((await readConnection(owner()))?.selection).toMatchObject(
        disconnect
          ? { kind: "disconnected" }
          : { kind: "connected", refreshToken: "synthetic-rotated-refresh" },
      );
    },
  );

  it("drains a remotely rotated refresh during shutdown and reopens the exact durable connection", async () => {
    const connection = await connect();
    expireUserGitHubAccessToken(owner());
    const refreshed = createDeferredCore<{ status: "refreshed"; tokens: typeof tokens }>();
    network.refresh.mockReturnValueOnce(refreshed.promise);
    const pending = lifecycle.personal.refresh(owner());
    await vi.waitFor(() => expect(network.refresh).toHaveBeenCalledOnce());
    const stop = lifecycle.stop();
    expect(network.refresh.mock.calls[0]?.[0]).not.toHaveProperty("signal");
    refreshed.resolve({
      status: "refreshed",
      tokens: { ...tokens, refreshToken: "shutdown-rotated" },
    });
    await pending;
    await stop;
    expect(await readConnection(owner())).toMatchObject({
      generation: connection.generation,
      selection: { refreshToken: "shutdown-rotated" },
    });
  });
});
