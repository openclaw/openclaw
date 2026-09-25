import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  assertOperatorModelAllowed,
  bindOperatorModelExecution,
} from "../agents/admitted-run-context.js";
import { runWithModelFallback } from "../agents/model-fallback-runner.js";
import { resolveReplyOperatorAuthorityKey } from "../auto-reply/reply/reply-tool-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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

const guestRole = {
  sessions: { others: "view" },
  agents: ["guest-agent"],
  scopes: ["operator.read", "operator.write"],
} as const;

function roleConfig(defaultRole = true): OpenClawConfig {
  return {
    gateway: {
      roles: {
        ...(defaultRole ? { default: "guest" } : {}),
        definitions: {
          guest: {
            sessions: { others: guestRole.sessions.others },
            agents: [...guestRole.agents],
            scopes: [...guestRole.scopes],
          },
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

function identifiedClient(profileId: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read"],
    },
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

afterEach(() => closeOpenClawStateDatabaseForTest());

describe("operator role policy", () => {
  it.each(["invocation", "access", "gateway resolver"] as const)(
    "keeps independent %s dependencies separate while retaining inherited authority",
    async (dependencyKind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = ensureProfileForEmail("independent-model-custody@example.test");
        const cfg = roleConfig();
        cfg.agents = { defaults: { model: "fixture/a" } };
        const role = expectDefined(cfg.gateway?.roles?.definitions.guest, "guest role");
        role.modelPolicy = { allow: ["fixture/*"] };
        const client = identifiedClient(profile.id);
        const context = createGatewayTestContext();
        context.getRuntimeConfig = () => cfg;
        const controllers = [new AbortController(), new AbortController()];
        const dependencies = controllers.map((controller) => ({
          signal: controller.signal,
          assertCurrent: () => controller.signal.throwIfAborted(),
        }));
        const captures: NonNullable<
          Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>
        >[] = [];
        const capture = async (
          params: Parameters<typeof captureGatewayOperatorRunAuthority>[0],
        ) => {
          const result = expectDefined(
            await captureGatewayOperatorRunAuthority(params),
            "operator capture",
          );
          captures.push(result);
          return result.authority;
        };
        try {
          const [first, second] = await Promise.all(
            dependencies.map((dependency) =>
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
            client: {
              ...client,
              connect: { ...client.connect, scopes: [] },
              internal: { operatorRunAuthority: original },
            },
            context,
          });
          expect(narrowed.source).toBe(original.source);
          expect(narrowed.scopes).toEqual([]);
          expect(resolveReplyOperatorAuthorityKey(narrowed)).not.toBe(
            resolveReplyOperatorAuthorityKey(original),
          );
          expect(() =>
            assertOperatorModelAllowed(narrowed, { provider: "fixture", model: "b" }),
          ).not.toThrow();
          expectDefined(controllers[0], "first dependency").abort(new Error("dependency ended"));
          if (dependencyKind === "gateway resolver") {
            expect(original.assertCurrent).toThrow("authority is no longer active");
            expect(narrowed.assertCurrent).toThrow("authority is no longer active");
          } else {
            expect(original.signal?.aborted).toBe(true);
            expect(narrowed.signal?.aborted).toBe(true);
          }
          expect(independent.signal?.aborted).toBe(false);
          expect(independent.assertCurrent).not.toThrow();
        } finally {
          for (const captured of captures) {
            captured.release();
          }
        }
      });
    },
  );

  it.each([
    { ended: "request", independent: false },
    { ended: "access", independent: false },
    { ended: "access", independent: true },
  ] as const)(
    "retains request and selected access authority when $ended ends (independent: $independent)",
    async ({ ended, independent }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = ensureProfileForEmail("model-source-composition@example.test");
        const request = new AbortController();
        const access = new AbortController();
        const cfg = roleConfig();
        const client = identifiedClient(profile.id);
        const grant = { pluginId: "visitor-access", grantId: "synthetic-grant" };
        client.internal = {
          operatorAccessAuthority: {
            gatewayAccessGrant: grant,
            signal: access.signal,
            assertCurrent: () => access.signal.throwIfAborted(),
          },
        };
        const captured = (await captureGatewayOperatorRunAuthority({
          client,
          context: { getRuntimeConfig: () => cfg },
          ...(independent ? { sourceAuthority: null } : {}),
          invocationAuthority: {
            signal: request.signal,
            assertCurrent: () => request.signal.throwIfAborted(),
          },
        }))!;
        try {
          expect(captured.authority.gatewayAccessGrant).toEqual(independent ? null : grant);
          expect(captured.authority.assertCurrent).not.toThrow();
          const endedSource = ended === "request" ? request : access;
          const otherSource = ended === "request" ? access : request;
          endedSource.abort(new Error(`${ended} source ended`));
          expect(otherSource.signal.aborted).toBe(false);
          expect(captured.authority.signal?.aborted).toBe(!independent);
          if (independent) {
            expect(captured.authority.assertCurrent).not.toThrow();
          } else {
            expect(captured.authority.assertCurrent).toThrow("source ended");
          }
        } finally {
          captured.release();
        }
      });
    },
  );

  it("retires the original source on a profile merge while preserving unrelated sources", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = ensureProfileForEmail("source-role@example.test");
      const target = ensureProfileForEmail("target-role@example.test");
      const unrelated = ensureProfileForEmail("unrelated-role@example.test");
      const cfg = roleConfig();
      const capture = async (profileId: string) =>
        (await captureGatewayOperatorRunAuthority({
          client: identifiedClient(profileId),
          context: { getRuntimeConfig: () => cfg },
        }))!;
      const original = await capture(source.id);
      const unaffected = await capture(unrelated.id);
      try {
        original.authority.assertCurrent();
        linkEmail("source-role@example.test", target.id);
        expect(original.authority.signal?.aborted).toBe(true);
        expect(original.authority.signal?.reason).toEqual(
          new Error("operator source identity changed; start a new request"),
        );
        expect(() => original.authority.assertCurrent()).toThrow(
          "operator source identity changed; start a new request",
        );
        expect(unaffected.authority.signal?.aborted).toBe(false);
        expect(() => unaffected.authority.assertCurrent()).not.toThrow();
        const fresh = await capture(target.id);
        try {
          expect(() => fresh.authority.assertCurrent()).not.toThrow();
          expect(() => original.authority.assertCurrent()).toThrow("no longer active");
        } finally {
          fresh.release();
        }
      } finally {
        original.release();
        unaffected.release();
      }
    });
  });
  it("rejects retained admin authority after a role downgrade even when ordinary session work remains allowed", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("retained-admin@example.test");
      const cfg = roleConfig();
      setUserProfileRole(profile.id, "maintainer");
      const admin = identifiedClient(profile.id);
      admin.connect.scopes = ["operator.admin"];
      const reader = identifiedClient(profile.id);
      const source = (await captureGatewayOperatorRunAuthority({
        client: reader,
        context: { getRuntimeConfig: () => cfg },
      }))!;
      expect(authorizeCurrentOperatorRoleScopes(admin, cfg)).toBeUndefined();
      try {
        setUserProfileRole(profile.id, "guest");
        invalidateOperatorRolePolicy(profile.id);
        expect(authorizeCurrentOperatorRoleScopes(admin, cfg)).toMatchObject({ code: "FORBIDDEN" });
        // Session/agent access narrowed even though this source's scopes still fit.
        expect(authorizeCurrentOperatorRoleScopes(reader, cfg)).toBeUndefined();
        expect(source.authority.signal?.aborted).toBe(true);
        expect(() => source.authority.assertCurrent()).toThrow(
          "Your operator role changed; reconnect before continuing.",
        );
        const reconnected = identifiedClient(profile.id);
        reconnected.connect.scopes = ["operator.write"];
        expect(authorizeCurrentOperatorRoleScopes(reconnected, cfg)).toBeUndefined();
      } finally {
        source.release();
      }
    });
  });
  it.each(["agents", "sessions", "sandbox"] as const)(
    "retires only affected sources after a committed %s policy change with unchanged scopes",
    async (restriction) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
        const capture = async (profileId: string) =>
          expectDefined(
            await captureGatewayOperatorRunAuthority({
              client: identifiedClient(profileId),
              context,
            }),
            "operator source",
          );
        const original = await capture(profile.id);
        const unaffected = await capture(otherProfile.id);
        const releaseQueued = expectDefined(original.authority.retain, "source retention")();
        original.release();
        try {
          const candidate = structuredClone(initial);
          const changedRole = expectDefined(
            candidate.gateway?.roles?.definitions.guest,
            "guest role",
          );
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
          expect(original.authority.signal?.aborted).toBe(true);
          expect(original.authority.assertCurrent).toThrow("Your operator role changed");
          expect(unaffected.authority.signal?.aborted).toBe(false);
          expect(unaffected.authority.assertCurrent).not.toThrow();
        } finally {
          releaseQueued();
          original.release();
          unaffected.release();
        }
      });
    },
  );

  it("intersects current and original model choices without revoking allowed sibling or unrelated work", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const guest = ensureProfileForEmail("model-guest@example.test");
      const staff = ensureProfileForEmail("model-staff@example.test");
      setUserProfileRole(staff.id, "maintainer");
      let cfg = roleConfig();
      cfg.agents = {
        defaults: { model: { primary: "fixture/primary", fallbacks: ["fixture/fallback"] } },
      };
      cfg.gateway!.roles!.definitions.guest!.modelPolicy = { deny: ["fixture/restricted-*"] };
      const context = { getRuntimeConfig: () => cfg };
      const capture = async (profileId: string) =>
        expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: identifiedClient(profileId),
            context,
          }),
          "operator source",
        );
      const original = await capture(guest.id);
      const unaffected = await capture(staff.id);
      const primaryExecution = bindOperatorModelExecution(original.authority, {
        provider: "fixture",
        model: "primary",
      })!;
      const fallbackExecution = bindOperatorModelExecution(original.authority, {
        provider: "fixture",
        model: "fallback",
      })!;
      const releaseQueued = original.authority.retain!();
      original.release();
      try {
        assertOperatorModelAllowed(original.authority, { provider: "fixture", model: "primary" });
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
              agents: {
                defaults: {
                  model: {
                    primary: "fixture/next",
                    fallbacks: ["fixture/fallback", "fixture/restricted-new"],
                  },
                },
              },
            };
            publishOperatorRoleConfigChange(context);
          },
          run: execute,
        });
        expect(result.result).toBe("fallback");
        expect(execute.mock.calls.map((call) => call[1])).toEqual(["fallback"]);
        expect(primaryExecution.signal.aborted).toBe(true);
        expect(primaryExecution.assertCurrent).toThrow("operator role cannot use this model");
        expect(fallbackExecution.signal.aborted).toBe(false);
        expect(fallbackExecution.assertCurrent).not.toThrow();
        expect(original.authority.signal?.aborted).toBe(false);
        expect(original.authority.assertCurrent).not.toThrow();
        expect(() =>
          assertOperatorModelAllowed(original.authority, { provider: "fixture", model: "primary" }),
        ).toThrow("operator role cannot use this model");
        expect(() =>
          assertOperatorModelAllowed(original.authority, {
            provider: "fixture",
            model: "fallback",
          }),
        ).not.toThrow();
        expect(() =>
          assertOperatorModelAllowed(original.authority, { provider: "fixture", model: "next" }),
        ).toThrow("operator role cannot use this model");
        expect(() =>
          assertOperatorModelAllowed(unaffected.authority, {
            provider: "fixture",
            model: "restricted-new",
          }),
        ).not.toThrow();
        const fresh = await capture(guest.id);
        try {
          expect(fresh.authority.modelPolicy?.models).toEqual([
            { provider: "fixture", model: "next" },
            { provider: "fixture", model: "fallback" },
          ]);
          expect(() =>
            assertOperatorModelAllowed(fresh.authority, {
              provider: "fixture",
              model: "restricted-new",
            }),
          ).toThrow("operator role cannot use this model");
        } finally {
          fresh.release();
        }
      } finally {
        primaryExecution.release();
        fallbackExecution.release();
        expect(fallbackExecution.assertCurrent).toThrow("no longer active");
        releaseQueued();
        unaffected.release();
      }
    });
  });

  it.each([false, true])(
    "applies model-only role changes without revoking the source (original ceiling: %s)",
    async (bounded) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = ensureProfileForEmail("model-field@example.test");
        let cfg = roleConfig();
        cfg.agents = { defaults: { model: "fixture/a" } };
        if (bounded) {
          cfg.gateway!.roles!.definitions.guest!.modelPolicy = {
            allow: ["fixture/a", "fixture/b"],
          };
        }
        const context = { getRuntimeConfig: () => cfg };
        const client = identifiedClient(profile.id);
        const source = (await captureGatewayOperatorRunAuthority({ client, context }))!;
        const narrowed = (await captureGatewayOperatorRunAuthority({
          client: {
            ...client,
            connect: { ...client.connect, scopes: [] },
            internal: { operatorRunAuthority: source.authority },
          },
          context,
        }))!;
        try {
          cfg = structuredClone(cfg);
          cfg.gateway!.roles!.definitions.guest!.modelPolicy = {
            allow: ["fixture/b", "fixture/c"],
          };
          publishOperatorRoleConfigChange(context);
          expect(source.authority.signal?.aborted).toBe(false);
          expect(source.authority.assertCurrent).not.toThrow();
          expect(narrowed.authority.scopes).toEqual([]);
          expect(() =>
            assertOperatorModelAllowed(narrowed.authority, { provider: "fixture", model: "a" }),
          ).toThrow("operator role cannot use this model");
          expect(() =>
            assertOperatorModelAllowed(narrowed.authority, { provider: "fixture", model: "b" }),
          ).not.toThrow();
          expect(narrowed.authority.modelPolicy?.allows({ provider: "fixture", model: "c" })).toBe(
            !bounded,
          );
        } finally {
          narrowed.release();
          source.release();
        }
      });
    },
  );

  it("preserves legacy access only when operator roles are not configured", () => {
    expect(resolveOperatorRolePolicyForProfile("unread-profile", {})).toBeUndefined();
    expect(resolveOperatorRolePolicyForProfile(undefined, roleConfig())).toMatchObject({
      sessions: { others: "none" },
      agents: [],
      scopes: [],
    });
    expect(resolveOperatorRolePolicy(null, roleConfig())).toMatchObject({
      sessions: { others: "none" },
      agents: [],
      scopes: [],
    });
  });

  it("resolves explicit and default assignments from the durable profile", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("role-default@example.com");
      const cfg = roleConfig();

      expect(resolveOperatorRolePolicy(identifiedClient(profile.id), cfg)).toEqual(guestRole);

      setUserProfileRole(profile.id, "maintainer");
      invalidateOperatorRolePolicy(profile.id);

      expect(resolveOperatorRolePolicyForProfile(profile.id, cfg)).toEqual(
        cfg.gateway?.roles?.definitions.maintainer,
      );
    });
  });

  it("keeps human-derived sandbox restrictions separate from profile provenance", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("role-sandbox-creator@example.com");
      const cfg = roleConfig();
      const guest = cfg.gateway?.roles?.definitions.guest;
      if (!guest) {
        throw new Error("missing guest role");
      }
      guest.sandbox = "required";

      for (const source of ["profile", "channel", "unknown"] as const) {
        expect(
          resolveCreatorSandbox(cfg, { actor: { type: "human", source, id: profile.id } }),
        ).toBe("required");
      }
      expect(
        resolveCreatorSandbox(cfg, {
          actor: { type: "human", source: "profile", id: GATEWAY_OWNER_PROFILE_ID },
        }),
      ).toBeUndefined();
      expect(
        resolveCreatorSandbox(cfg, { actor: { type: "agent", id: profile.id } }),
      ).toBeUndefined();
      expect(
        resolveCreatorSandbox(cfg, { actor: { type: "system", id: profile.id } }),
      ).toBeUndefined();
      expect(
        resolveCreatorSandbox(cfg, { actor: { type: "human", source: "unknown" } }),
      ).toBeUndefined();
      expect(
        resolveCreatorSandbox({}, { actor: { type: "human", source: "profile", id: profile.id } }),
      ).toBeUndefined();

      setUserProfileRole(profile.id, "maintainer");
      invalidateOperatorRolePolicy(profile.id);

      expect(
        resolveCreatorSandbox(cfg, { actor: { type: "human", source: "profile", id: profile.id } }),
      ).toBeUndefined();
    });
  });

  it("keeps owner attribution out of named roles and preserves explicit authority", () => {
    const cfg = roleConfig();
    const owner = identifiedClient(GATEWAY_OWNER_PROFILE_ID);
    expect(resolveGatewayOperatorRoleActor(owner)).toBeUndefined();
    expect(resolveOperatorRolePolicyForProfile(GATEWAY_OWNER_PROFILE_ID, cfg)).toBeUndefined();
    expect(
      resolveOperatorRolePolicyForAssignment(GATEWAY_OWNER_PROFILE_ID, "guest", cfg),
    ).toBeUndefined();
    owner.internal = { operatorRoleActor: { kind: "system" } };
    expect(resolveGatewayOperatorRoleActor(owner)).toEqual({ kind: "system" });
    expect(resolveOperatorRolePolicy(owner, cfg)).toBeUndefined();
  });

  it("reads current verified identity while preserving explicit role authority", () => {
    const client = identifiedClient("profile-first");
    const profile = client.authenticatedUserProfile!;
    profile.displayName = "profile-other";
    expect(resolveGatewayOperatorRoleActor(client)).toEqual({
      kind: "operator",
      profileId: "profile-first",
    });

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
  });

  it("falls back from stale assignments to the configured default or denies access", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("role-stale@example.com");
      setUserProfileRole(profile.id, "retired");

      expect(resolveOperatorRolePolicyForProfile(profile.id, roleConfig())).toEqual(guestRole);
      expect(resolveOperatorRolePolicyForProfile(profile.id, roleConfig(false))).toMatchObject({
        sessions: { others: "none" },
        agents: [],
        scopes: [],
      });
    });
  });

  it("retains the prepared assignment until the owner explicitly invalidates it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("role-cache@example.com");
      const cfg = roleConfig();

      expect(resolveOperatorRolePolicyForProfile(profile.id, cfg)).toEqual(guestRole);
      setUserProfileRole(profile.id, "maintainer");
      expect(resolveOperatorRolePolicyForProfile(profile.id, cfg)).toEqual(guestRole);

      invalidateOperatorRolePolicy(profile.id);

      expect(resolveOperatorRolePolicyForProfile(profile.id, cfg)).toEqual(
        cfg.gateway?.roles?.definitions.maintainer,
      );
    });
  });

  it("authorizes only configured agents and rejects unidentified operators", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("role-agents@example.com");
      const cfg = roleConfig();

      expect(
        authorizeGatewaySessionCreation({
          cfg,
          profileId: profile.id,
          agentId: "guest-agent",
        }),
      ).toBeUndefined();
      expect(
        authorizeGatewaySessionCreation({ cfg, profileId: profile.id, agentId: "private-agent" }),
      ).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("private-agent"),
      });
      expect(
        authorizeGatewaySessionCreation({ cfg, profileId: undefined, agentId: "private-agent" }),
      ).toMatchObject({ code: "FORBIDDEN" });
      expect(
        authorizeGatewaySessionCreation({
          cfg,
          actor: { kind: "system" },
          agentId: "private-agent",
        }),
      ).toBeUndefined();
      const trackedOperator = identifiedClient(profile.id);
      delete trackedOperator.authenticatedUserProfile;
      trackedOperator.internal = {
        syntheticClient: true,
        operatorRoleActor: { kind: "operator", profileId: profile.id },
      };
      expect(
        authorizeGatewaySessionCreation({ cfg, client: trackedOperator, agentId: "private-agent" }),
      ).toMatchObject({ code: "FORBIDDEN" });
      expect(resolveOperatorRolePolicy(trackedOperator, cfg)).toEqual(guestRole);
      trackedOperator.internal.operatorRoleActor = { kind: "system" };
      expect(
        authorizeGatewaySessionCreation({ cfg, client: trackedOperator, agentId: "private-agent" }),
      ).toBeUndefined();
      expect(resolveOperatorRolePolicy(trackedOperator, cfg)).toBeUndefined();
    });
  });
});
