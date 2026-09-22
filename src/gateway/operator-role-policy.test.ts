import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayAccessReadScope } from "./gateway-access-revision.js";
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
  it("retires the original source on a profile merge while preserving unrelated sources", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = ensureProfileForEmail("source-role@example.test");
      const target = ensureProfileForEmail("target-role@example.test");
      const unrelated = ensureProfileForEmail("unrelated-role@example.test");
      const cfg = roleConfig();
      const capture = (profileId: string) =>
        captureGatewayOperatorRunAuthority({
          client: identifiedClient(profileId),
          context: { getRuntimeConfig: () => cfg },
        })!;
      const original = capture(source.id);
      const unaffected = capture(unrelated.id);
      const accessRead = createGatewayAccessReadScope();
      accessRead.dependOnSessionKeys(["agent:main:unrelated-requester"]);
      try {
        original.authority.assertCurrent();
        expect(accessRead.isCurrent()).toBe(true);
        linkEmail("source-role@example.test", target.id);
        expect(accessRead.isCurrent()).toBe(false);
        expect(original.authority.signal?.aborted).toBe(true);
        expect(original.authority.signal?.reason).toEqual(
          new Error("operator source identity changed; start a new request"),
        );
        expect(() => original.authority.assertCurrent()).toThrow(
          "operator source identity changed; start a new request",
        );
        expect(unaffected.authority.signal?.aborted).toBe(false);
        expect(() => unaffected.authority.assertCurrent()).not.toThrow();
        const fresh = capture(target.id);
        try {
          expect(() => fresh.authority.assertCurrent()).not.toThrow();
          expect(() => original.authority.assertCurrent()).toThrow("no longer active");
        } finally {
          fresh.release();
        }
      } finally {
        original.release();
        unaffected.release();
        accessRead.dispose();
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
      const source = captureGatewayOperatorRunAuthority({
        client: reader,
        context: { getRuntimeConfig: () => cfg },
      })!;
      expect(authorizeCurrentOperatorRoleScopes(admin, cfg)).toBeUndefined();
      const accessRead = createGatewayAccessReadScope();
      accessRead.dependOnSessionKeys(["agent:main:unrelated-requester"]);
      try {
        expect(accessRead.isCurrent()).toBe(true);
        setUserProfileRole(profile.id, "guest");
        invalidateOperatorRolePolicy(profile.id);
        expect(accessRead.isCurrent()).toBe(false);
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
        accessRead.dispose();
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
        const capture = (profileId: string) =>
          expectDefined(
            captureGatewayOperatorRunAuthority({ client: identifiedClient(profileId), context }),
            "operator source",
          );
        const original = capture(profile.id);
        const unaffected = capture(otherProfile.id);
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
