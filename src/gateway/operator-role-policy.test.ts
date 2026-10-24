import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  assertOperatorModelAllowed,
  bindOperatorModelExecution,
} from "../agents/admitted-run-context.js";
import { runWithModelFallback } from "../agents/model-fallback-runner.js";
import { resolveReplyOperatorAuthorityKey } from "../auto-reply/reply/reply-tool-authority.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { linkUserChannelIdentity } from "../state/user-channel-identities.js";
import { publishUserProfileAuthorityChange } from "../state/user-profile-events.js";
import {
  prepareUserProfileCatalog,
  publishUserProfilesChange,
} from "../state/user-profile-list.js";
import {
  linkEmail,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveChannelOperatorAdminAuthority } from "./channel-operator-authority.js";
import {
  hasCurrentGatewayOperatorAccess,
  resolveGatewayOperatorAccessAuthority,
} from "./operator-access-policy.js";
import {
  authorizeGatewaySessionCreation,
  authorizeCurrentOperatorRoleScopes,
  invalidateOperatorRolePolicy,
  publishOperatorRoleConfigChange,
  resolveCreatorSandbox,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicy,
  resolveOperatorRolePolicyForAssignment,
  resolveOperatorRolePolicyForProfile,
} from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import { createContext as createGatewayTestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";

function modelRef(model: string) {
  return { provider: "fixture", model };
}

const inState = (run: () => Promise<void>) => withOpenClawTestState({ scenario: "minimal" }, run);
const github = (accountId: number, login: string) =>
  syncGitHubIdentity({
    identity: { accountId, login },
    authenticationAlias: { kind: "github-login", login },
  });
type Source = NonNullable<Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>>;
type Authority = Source["authority"];
type CaptureInput = Parameters<typeof captureGatewayOperatorRunAuthority>[0];
const liveDependency = (controller: AbortController) => ({
  signal: controller.signal,
  assertCurrent: () => controller.signal.throwIfAborted(),
});
async function captureSource(input: CaptureInput) {
  const source = expectDefined(await captureGatewayOperatorRunAuthority(input), "operator source");
  return { ...source, [Symbol.dispose]: source.release };
}
function expectCurrent(authority: Pick<Authority, "signal" | "assertCurrent">, error?: string) {
  expect(authority.signal?.aborted).toBe(Boolean(error));
  if (error) {
    expect(authority.assertCurrent).toThrow(error);
  } else {
    expect(authority.assertCurrent).not.toThrow();
  }
}
function expectModel(authority: Authority, model: string, allowed: boolean) {
  const assertion = expect(() => assertOperatorModelAllowed(authority, modelRef(model)));
  if (allowed) {
    assertion.not.toThrow();
  } else {
    assertion.toThrow("operator role cannot use this model");
  }
}
const guestDefinition = (cfg: OpenClawConfig) =>
  expectDefined(cfg.gateway?.roles?.definitions.guest, "guest role");
function modelDefaults(primary: string, fallbacks?: string[]) {
  return { defaults: { model: fallbacks ? { primary, fallbacks } : primary } };
}
function narrowClient(client: GatewayClient, authority: Authority): GatewayClient {
  return {
    ...client,
    connect: { ...client.connect, scopes: [] },
    internal: { operatorRunAuthority: authority },
  };
}

const guestRole = {
  sessions: { others: "view" },
  agents: ["guest-agent"],
  scopes: ["operator.read", "operator.write"],
} satisfies GatewayOperatorRoleDefinition;

function roleConfig(defaultRole = true): OpenClawConfig {
  return {
    gateway: {
      roles: {
        ...(defaultRole ? { default: "guest" } : {}),
        definitions: {
          guest: structuredClone(guestRole),
          maintainer: {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.admin"],
          },
        },
      },
    },
  };
}

function roleFixture() {
  const profile = ensureProfileForEmail("operator@example.test");
  const cfg = roleConfig();
  const client = identifiedClient(profile.id);
  const context = { getRuntimeConfig: () => cfg };
  return { profile, cfg, client, context, capture: (id = profile.id) => captureRole(id, context) };
}

function identifiedClient(profileId: string): GatewayClient {
  return {
    connect: gatewayConnect(["operator.read"]),
    authenticatedUserProfile: gatewayProfile(profileId),
  };
}

async function captureRole(profileId: string, context: CaptureInput["context"]) {
  return captureSource({ client: identifiedClient(profileId), context });
}

function expectRole(
  profileId: string,
  cfg: OpenClawConfig,
  expected: ReturnType<typeof resolveOperatorRolePolicyForProfile>,
) {
  expect(resolveOperatorRolePolicyForProfile(profileId, cfg)).toEqual(expected);
}

afterEach(() => closeOpenClawStateDatabaseForTest());

describe("operator role policy", () => {
  it("resolves verified GitHub login assignments with explicit precedence and live config", () =>
    inState(async () => {
      const person = github(42, "Release-Operator");
      const unverified = ensureProfileForEmail("release-operator@example.test");
      const catalog = await prepareUserProfileCatalog();
      const cfg = roleConfig();
      const roles = expectDefined(cfg.gateway?.roles, "roles");
      roles.assignments = { byGithubLogin: { " release-OPERATOR ": "maintainer" } };
      using _ = { [Symbol.dispose]: catalog.release };

      expectRole(person.id, cfg, roles.definitions.maintainer);
      expectRole(unverified.id, cfg, guestRole);
      setUserProfileRole(person.id, "guest");
      invalidateOperatorRolePolicy(person.id);
      expectRole(person.id, cfg, guestRole);
      setUserProfileRole(person.id, "retired");
      invalidateOperatorRolePolicy(person.id);
      expectRole(person.id, cfg, roles.definitions.maintainer);
      roles.assignments.byGithubLogin = {};
      publishOperatorRoleConfigChange({});
      expectRole(person.id, cfg, guestRole);
      roles.assignments.byGithubLogin = { "release-operator": "maintainer" };
      publishOperatorRoleConfigChange({});
      expectRole(person.id, cfg, roles.definitions.maintainer);
      const access = resolveGatewayOperatorAccessAuthority(person.id, cfg);
      expect(access?.gatewayAccessGrant).toBeNull();
      expect(hasCurrentGatewayOperatorAccess(access)).toBe(true);
      setDisplayName(person.id, "Release Operator");
      expect(hasCurrentGatewayOperatorAccess(access)).toBe(true);
      github(42, "Renamed-Operator");
      expectRole(person.id, cfg, guestRole);
      expect(hasCurrentGatewayOperatorAccess(access)).toBe(false);
      expect(access?.signal.aborted).toBe(true);
    }));

  it.each([
    { route: "Gateway", roleSource: "assigned" },
    { route: "Gateway", roleSource: "empty mapping" },
    { route: "CLI", roleSource: "assigned" },
    { route: "CLI", roleSource: "empty mapping" },
  ] as const)(
    "preserves $route $roleSource authority when an irrelevant GitHub login changes",
    ({ route, roleSource }) =>
      inState(async () => {
        const login = route === "Gateway" ? "Explicit-Operator" : "Cli-Operator";
        const person = github(43, login);
        if (roleSource === "assigned") {
          setUserProfileRole(person.id, "maintainer");
        }
        const cfg = roleConfig();
        const roles = expectDefined(cfg.gateway?.roles, "roles");
        roles.default = "maintainer";
        roles.assignments = {
          byGithubLogin: roleSource === "assigned" ? { [login.toLowerCase()]: "guest" } : {},
        };
        using cleanup = new DisposableStack();
        let assertCurrent: () => void;
        if (route === "Gateway") {
          cleanup.defer((await prepareUserProfileCatalog()).release);
          const context = createGatewayTestContext();
          context.getRuntimeConfig = () => cfg;
          const source = cleanup.use(
            await captureSource({
              client: identifiedClient(person.id),
              context,
              sourceAuthority: resolveGatewayOperatorAccessAuthority(person.id, cfg),
            }),
          );
          assertCurrent = () => {
            expectCurrent(source.authority);
            expectRole(person.id, cfg, roles.definitions.maintainer);
          };
        } else {
          const identity = { channelId: "slack", accountId: "default", senderId: "cli-operator" };
          linkUserChannelIdentity(person.id, identity);
          const authority = expectDefined(
            resolveChannelOperatorAdminAuthority(cfg, identity),
            "CLI authority",
          );
          assertCurrent = () => expect(authority.isCurrent(cfg)).toBe(true);
        }
        const renamedLogin = route === "Gateway" ? "Renamed-Explicit-Operator" : "CLI-Operator";
        github(43, renamedLogin);
        assertCurrent();
      }),
  );

  it.each(["invocation", "access", "gateway resolver"] as const)(
    "keeps independent %s dependencies separate while retaining inherited authority",
    (dependencyKind) =>
      inState(async () => {
        const { cfg, client, context: runtimeContext } = roleFixture();
        cfg.agents = modelDefaults("fixture/a");
        guestDefinition(cfg).modelPolicy = { allow: ["fixture/*"] };
        const context = { ...createGatewayTestContext(), ...runtimeContext };
        const controllers = [new AbortController(), new AbortController()];
        using captures = new DisposableStack();
        const capture = async (params: CaptureInput) =>
          captures.use(await captureSource(params)).authority;
        const [first, second] = await Promise.all(
          controllers.map(liveDependency).map((dependency) =>
            capture({
              client,
              context:
                dependencyKind === "gateway resolver"
                  ? {
                      getRuntimeConfig: context.getRuntimeConfig,
                      resolveGatewayContext: () =>
                        dependency.signal.aborted ? undefined : context,
                    }
                  : context,
              ...(dependencyKind === "invocation"
                ? { invocationAuthority: dependency }
                : dependencyKind === "access"
                  ? { sourceAuthority: dependency }
                  : {}),
            }),
          ),
        );
        const original = expectDefined(first, "first source");
        const independent = expectDefined(second, "independent source");
        expect(resolveReplyOperatorAuthorityKey(independent)).not.toBe(
          resolveReplyOperatorAuthorityKey(original),
        );
        const narrowed = await capture({
          client: narrowClient(client, original),
          context,
        });
        expect(narrowed.source).toBe(original.source);
        expect(narrowed.scopes).toEqual([]);
        expect(resolveReplyOperatorAuthorityKey(narrowed)).not.toBe(
          resolveReplyOperatorAuthorityKey(original),
        );
        expectModel(narrowed, "b", true);
        expectDefined(controllers[0], "first dependency").abort(new Error("dependency ended"));
        if (dependencyKind === "gateway resolver") {
          expect(original.assertCurrent).toThrow("authority is no longer active");
          expect(narrowed.assertCurrent).toThrow("authority is no longer active");
        } else {
          expect(original.signal?.aborted).toBe(true);
          expect(narrowed.signal?.aborted).toBe(true);
        }
        expectCurrent(independent);
      }),
  );

  it.each([
    { ended: "request", independent: false },
    { ended: "access", independent: false },
    { ended: "access", independent: true },
  ] as const)(
    "retains request and selected access authority when $ended ends (independent: $independent)",
    ({ ended, independent }) =>
      inState(async () => {
        const { client, context } = roleFixture();
        const request = new AbortController();
        const access = new AbortController();
        const grant = { pluginId: "visitor-access", grantId: "synthetic-grant" };
        client.internal = {
          operatorAccessAuthority: {
            gatewayAccessGrant: grant,
            ...liveDependency(access),
          },
        };
        const captured = await captureSource({
          client,
          context,
          ...(independent ? { sourceAuthority: null } : {}),
          invocationAuthority: liveDependency(request),
        });
        using _ = { [Symbol.dispose]: captured.release };

        expect(captured.authority.gatewayAccessGrant).toEqual(independent ? null : grant);
        expect(captured.authority.assertCurrent).not.toThrow();
        const endedSource = ended === "request" ? request : access;
        const otherSource = ended === "request" ? access : request;
        endedSource.abort(new Error(`${ended} source ended`));
        expect(otherSource.signal.aborted).toBe(false);
        expectCurrent(captured.authority, independent ? undefined : "source ended");
      }),
  );

  it("retires the original source on a profile merge while preserving unrelated sources", () =>
    inState(async () => {
      const source = ensureProfileForEmail("source-role@example.test");
      const target = ensureProfileForEmail("target-role@example.test");
      const unrelated = ensureProfileForEmail("unrelated-role@example.test");
      const cfg = roleConfig();
      const capture = (profileId: string) =>
        captureRole(profileId, { getRuntimeConfig: () => cfg });
      using original = await capture(source.id);
      using unaffected = await capture(unrelated.id);
      original.authority.assertCurrent();
      linkEmail("source-role@example.test", target.id);
      const error = "operator source identity changed; start a new request";
      expectCurrent(original.authority, error);
      expect(original.authority.signal?.reason).toEqual(new Error(error));
      expectCurrent(unaffected.authority);
      using fresh = await capture(target.id);

      expect(() => fresh.authority.assertCurrent()).not.toThrow();
      expectCurrent(original.authority, error);
    }));
  it("rejects retained admin authority after a role downgrade even when ordinary session work remains allowed", () =>
    inState(async () => {
      const { profile, cfg, client: reader, capture } = roleFixture();
      setUserProfileRole(profile.id, "maintainer");
      const admin = identifiedClient(profile.id);
      admin.connect.scopes = ["operator.admin"];
      using source = await capture();
      expect(authorizeCurrentOperatorRoleScopes(admin, cfg)).toBeUndefined();

      setUserProfileRole(profile.id, "guest");
      invalidateOperatorRolePolicy(profile.id);
      expect(authorizeCurrentOperatorRoleScopes(admin, cfg)).toMatchObject({ code: "FORBIDDEN" });
      expect(authorizeCurrentOperatorRoleScopes(reader, cfg)).toBeUndefined();
      expectCurrent(source.authority, "Your operator role changed; reconnect before continuing.");
      const reconnected = identifiedClient(profile.id);
      reconnected.connect.scopes = ["operator.write"];
      expect(authorizeCurrentOperatorRoleScopes(reconnected, cfg)).toBeUndefined();
    }));
  it.each(["agents", "sessions", "sandbox"] as const)(
    "retires only affected sources after a committed %s policy change with unchanged scopes",
    (restriction) =>
      inState(async () => {
        const profile = ensureProfileForEmail("committed-role-source@example.test");
        const otherProfile = ensureProfileForEmail("committed-role-unaffected@example.test");
        setUserProfileRole(otherProfile.id, "maintainer");
        const initial = roleConfig();
        let runtimeConfig = initial;
        let committedConfig = initial;
        const context = {
          getRuntimeConfig: () => runtimeConfig,
          getCommittedRuntimeConfig: () => committedConfig,
        };
        const capture = (profileId: string) => captureRole(profileId, context);
        const original = await capture(profile.id);
        const unaffected = await capture(otherProfile.id);
        const releaseQueued = expectDefined(original.authority.retain, "source retention")();
        original.release();
        try {
          const candidate = structuredClone(initial);
          const changedRole = guestDefinition(candidate);
          if (restriction === "agents") {
            changedRole.agents = [];
          } else if (restriction === "sessions") {
            changedRole.sessions.others = "none";
          } else {
            changedRole.sandbox = "required";
          }
          expect(
            authorizeCurrentOperatorRoleScopes(identifiedClient(profile.id), candidate),
          ).toBeUndefined();
          runtimeConfig = candidate;
          expect(original.authority.assertCurrent).not.toThrow();
          runtimeConfig = initial;
          expect(original.authority.signal?.aborted).toBe(false);

          committedConfig = { ...initial, logging: { level: "debug" } };
          publishOperatorRoleConfigChange(context);
          expect(original.authority.signal?.aborted).toBe(false);
          committedConfig = candidate;
          publishOperatorRoleConfigChange({});
          expect(original.authority.signal?.aborted).toBe(false);
          publishOperatorRoleConfigChange(context);
          expectCurrent(original.authority, "Your operator role changed");
          expectCurrent(unaffected.authority);
        } finally {
          releaseQueued();
          original.release();
          unaffected.release();
        }
      }),
  );

  it("intersects current and original model choices without revoking allowed sibling or unrelated work", () =>
    inState(async () => {
      const guest = ensureProfileForEmail("model-guest@example.test");
      const staff = ensureProfileForEmail("model-staff@example.test");
      setUserProfileRole(staff.id, "maintainer");
      let cfg = roleConfig();
      cfg.agents = modelDefaults("fixture/primary", ["fixture/fallback"]);
      guestDefinition(cfg).modelPolicy = { deny: ["fixture/restricted-*"] };
      const context = { getRuntimeConfig: () => cfg };
      const capture = (profileId: string) => captureRole(profileId, context);
      const original = await capture(guest.id);
      const unaffected = await capture(staff.id);
      const primaryExecution = bindOperatorModelExecution(original.authority, modelRef("primary"))!;
      const fallbackExecution = bindOperatorModelExecution(
        original.authority,
        modelRef("fallback"),
      )!;
      const releaseQueued = original.authority.retain!();
      original.release();
      try {
        assertOperatorModelAllowed(original.authority, modelRef("primary"));
        cfg = { ...cfg, logging: { level: "debug" } };
        publishOperatorRoleConfigChange(context);
        expect(original.authority.signal?.aborted).toBe(false);
        const execute = vi.fn(async (_provider: string, model: string) => model);
        const result = await runWithModelFallback({
          cfg,
          provider: "fixture",
          model: "primary",
          operatorAuthority: original.authority,
          manifestPlugins: [],
          skipAuthProfileRuntime: true,
          prepareCandidateChain: () => {
            cfg = {
              ...cfg,
              agents: modelDefaults("fixture/next", ["fixture/fallback", "fixture/restricted-new"]),
            };
            publishOperatorRoleConfigChange(context);
          },
          run: execute,
        });
        expect(result.result).toBe("fallback");
        expect(execute.mock.calls.map((call) => call[1])).toEqual(["fallback"]);
        expectCurrent(primaryExecution, "operator role cannot use this model");
        expectCurrent(fallbackExecution);
        expectCurrent(original.authority);
        expectModel(original.authority, "primary", false);
        expectModel(original.authority, "fallback", true);
        expectModel(original.authority, "next", false);
        expectModel(unaffected.authority, "restricted-new", true);
        const fresh = await capture(guest.id);
        using _ = { [Symbol.dispose]: fresh.release };

        expect(fresh.authority.modelPolicy?.models).toEqual([
          modelRef("next"),
          modelRef("fallback"),
        ]);
        expectModel(fresh.authority, "restricted-new", false);
      } finally {
        primaryExecution.release();
        fallbackExecution.release();
        expect(fallbackExecution.assertCurrent).toThrow("no longer active");
        releaseQueued();
        unaffected.release();
      }
    }));

  it.each([false, true])(
    "applies model-only role changes without revoking the source (original ceiling: %s)",
    (bounded) =>
      inState(async () => {
        const profile = ensureProfileForEmail("model-field@example.test");
        let cfg = roleConfig();
        cfg.agents = modelDefaults("fixture/a");
        if (bounded) {
          guestDefinition(cfg).modelPolicy = { allow: ["fixture/a", "fixture/b"] };
        }
        const context = { getRuntimeConfig: () => cfg };
        const client = identifiedClient(profile.id);
        using source = await captureSource({ client, context });
        using narrowed = await captureSource({
          client: narrowClient(client, source.authority),
          context,
        });
        cfg = structuredClone(cfg);
        guestDefinition(cfg).modelPolicy = { allow: ["fixture/b", "fixture/c"] };
        publishOperatorRoleConfigChange(context);
        expectCurrent(source.authority);
        expect(narrowed.authority.scopes).toEqual([]);
        expectModel(narrowed.authority, "a", false);
        expectModel(narrowed.authority, "b", true);
        expect(narrowed.authority.modelPolicy?.allows(modelRef("c"))).toBe(!bounded);
      }),
  );

  it.each(["legacy", "prepared", "unknown"] as const)(
    "resolves %s assignments and denies unavailable role authority",
    async (assignment) => {
      const cfg = roleConfig();
      const denied = { sessions: { others: "none" }, agents: [], scopes: [] };
      if (assignment === "legacy") {
        expect(resolveOperatorRolePolicyForProfile("unread-profile", {})).toBeUndefined();
        expect(resolveOperatorRolePolicyForProfile(undefined, cfg)).toMatchObject(denied);
        expect(resolveOperatorRolePolicy(null, cfg)).toMatchObject(denied);
        return;
      }
      await inState(async () => {
        const profile = ensureProfileForEmail("role-assignment@example.test");
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        if (assignment === "unknown") {
          setUserProfileRole(profile.id, "retired");
        } else {
          expect(resolveOperatorRolePolicy(identifiedClient(profile.id), cfg)).toEqual(guestRole);
        }
        expectRole(profile.id, cfg, guestRole);
        if (assignment === "unknown") {
          expect(resolveOperatorRolePolicyForProfile(profile.id, roleConfig(false))).toMatchObject(
            denied,
          );
          return;
        }
        setUserProfileRole(profile.id, "maintainer");
        expectRole(profile.id, cfg, cfg.gateway?.roles?.definitions.maintainer);
      });
    },
  );

  it("reads committed role changes and deletion without a role cache or main-thread SQL", () =>
    inState(async () => {
      const { profile, cfg } = roleFixture();
      setUserProfileRole(profile.id, "maintainer");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const sql = observeMainThreadSql();
      try {
        expectRole(profile.id, cfg, cfg.gateway?.roles?.definitions.maintainer);
        sql.expectIdle();

        setUserProfileRole(profile.id, "guest");
        sql.clear();
        expectRole(profile.id, cfg, guestRole);
        expect(
          authorizeGatewaySessionCreation({ cfg, profileId: profile.id, agentId: "private-agent" }),
        ).toMatchObject({ code: "FORBIDDEN" });
        sql.expectIdle();

        // Model a committed owner deletion, including the same publication used by profile writers.
        runOpenClawStateWriteTransaction(({ db }) => {
          db.prepare("DELETE FROM user_profiles WHERE id = ?").run(profile.id);
          publishUserProfileAuthorityChange(db, profile.id);
          publishUserProfilesChange(db, profile.id);
        });
        sql.clear();
        expect(() => resolveOperatorRolePolicyForProfile(profile.id, cfg)).toThrow(
          "user profile not found",
        );
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    }));

  it("keeps human-derived sandbox restrictions separate from profile provenance", () =>
    inState(async () => {
      const { profile, cfg } = roleFixture();
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      guestDefinition(cfg).sandbox = "required";
      const sandbox = (
        actor: NonNullable<Parameters<typeof resolveCreatorSandbox>[1]>["actor"],
        config = cfg,
      ) => resolveCreatorSandbox(config, { actor });
      const human = { type: "human", source: "profile", id: profile.id } as const;
      for (const source of ["profile", "channel", "unknown"] as const) {
        expect(sandbox({ ...human, source })).toBe("required");
      }
      expect(sandbox({ ...human, id: GATEWAY_OWNER_PROFILE_ID })).toBeUndefined();
      expect(sandbox({ type: "agent", id: profile.id })).toBeUndefined();
      expect(sandbox({ type: "system", id: profile.id })).toBeUndefined();
      expect(sandbox({ type: "human", source: "unknown" })).toBeUndefined();
      expect(sandbox(human, {})).toBeUndefined();
      setUserProfileRole(profile.id, "maintainer");
      invalidateOperatorRolePolicy(profile.id);
      expect(sandbox(human)).toBeUndefined();
    }));

  it.each([GATEWAY_OWNER_PROFILE_ID, "profile-first"])(
    "reads current verified and explicit actor identity for %s",
    (profileId) => {
      const client = identifiedClient(profileId);
      if (profileId === GATEWAY_OWNER_PROFILE_ID) {
        const cfg = roleConfig();
        expect(resolveGatewayOperatorRoleActor(client)).toBeUndefined();
        expect(resolveOperatorRolePolicyForProfile(profileId, cfg)).toBeUndefined();
        expect(
          resolveOperatorRolePolicyForAssignment(profileId, "guest", cfg, null),
        ).toBeUndefined();
        client.internal = { operatorRoleActor: { kind: "system" } };
        expect(resolveGatewayOperatorRoleActor(client)).toEqual({ kind: "system" });
        expect(resolveOperatorRolePolicy(client, cfg)).toBeUndefined();
        return;
      }
      const profile = client.authenticatedUserProfile!;
      profile.displayName = "profile-other";
      expect(resolveGatewayOperatorRoleActor(client)).toEqual({ kind: "operator", profileId });
      profile.profileId = "profile-next";
      expect(resolveGatewayOperatorRoleActor(client)).toEqual({
        kind: "operator",
        profileId: "profile-next",
      });
      client.internal = { operatorRoleActor: { kind: "operator", profileId: "profile-explicit" } };
      expect(resolveGatewayOperatorRoleActor(client)).toEqual({
        kind: "operator",
        profileId: "profile-explicit",
      });
      client.internal = undefined;
      client.authenticatedUserProfile = undefined;
      client.authenticatedUserId = "profile-unverified";
      expect(resolveGatewayOperatorRoleActor(client)).toBeUndefined();
      expect(resolveGatewayOperatorRoleActor(null)).toBeUndefined();
      expect(resolveGatewayOperatorRoleActor(undefined)).toBeUndefined();
    },
  );

  it("authorizes only configured agents and rejects unidentified operators", () =>
    inState(async () => {
      const { profile, cfg } = roleFixture();
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      type WithoutConfig<T> = T extends unknown ? Omit<T, "cfg"> : never;
      const create = (
        input: WithoutConfig<Parameters<typeof authorizeGatewaySessionCreation>[0]>,
      ) => authorizeGatewaySessionCreation({ cfg, ...input });
      expect(create({ profileId: profile.id, agentId: "guest-agent" })).toBeUndefined();
      expect(create({ profileId: profile.id, agentId: "private-agent" })).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("private-agent"),
      });
      expect(create({ profileId: undefined, agentId: "private-agent" })).toMatchObject({
        code: "FORBIDDEN",
      });
      expect(create({ actor: { kind: "system" }, agentId: "private-agent" })).toBeUndefined();
      const trackedOperator = identifiedClient(profile.id);
      delete trackedOperator.authenticatedUserProfile;
      trackedOperator.internal = {
        syntheticClient: true,
        operatorRoleActor: { kind: "operator", profileId: profile.id },
      };
      expect(create({ client: trackedOperator, agentId: "private-agent" })).toMatchObject({
        code: "FORBIDDEN",
      });
      expect(resolveOperatorRolePolicy(trackedOperator, cfg)).toEqual(guestRole);
      trackedOperator.internal.operatorRoleActor = { kind: "system" };
      expect(create({ client: trackedOperator, agentId: "private-agent" })).toBeUndefined();
      expect(resolveOperatorRolePolicy(trackedOperator, cfg)).toBeUndefined();
    }));
});
