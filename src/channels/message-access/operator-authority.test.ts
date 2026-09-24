import { expect, it } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { buildExecAutoReviewTranscript } from "../../agents/exec-auto-review-transcript.js";
import { castAgentMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import {
  captureCommandOwnerAssertion,
  getCommandOwnerAuthority,
} from "../../auto-reply/command-owner-authority.js";
import { prepareChannelRunAdmission } from "../../auto-reply/reply/channel-run-admission.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { resolveFollowupDeliveryContextKey } from "../../auto-reply/reply/queue/delivery-context.js";
import { installDiscordRegistryHooks } from "../../auto-reply/test-helpers/command-auth-registry-fixture.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { withAdminIngress } from "./operator-authority.test-support.js";

installDiscordRegistryHooks();

it("recognizes every linked Team admin through host ingress and gives Guardian operator provenance", async () => {
  await withAdminIngress(async ({ cfg, admins, context }) => {
    for (const { identity } of admins) {
      const ctx = await context(identity.senderId);
      const auth = resolveCommandAuthorization({ cfg, ctx: { ...ctx }, commandAuthorized: true });
      expect(auth).toMatchObject({ senderIsOwner: true, isAuthorizedSender: true });
      const transcript = buildExecAutoReviewTranscript({
        messages: [
          castAgentMessage({
            role: "user",
            content: "Assign this session to the requester",
            timestamp: 0,
            __openclaw: {
              senderIsOwner: auth.senderIsOwner,
              senderIdentity: {
                type: "observation",
                pluginId: "discord",
                accountId: "team",
                senderKind: "human",
                id: identity.senderId,
              },
            },
          }),
        ],
      });
      expect(transcript.entries[0]?.origin).toBe("operator");
    }
    const ordinary = await context("ordinary-member");
    expect(
      resolveCommandAuthorization({ cfg, ctx: ordinary, commandAuthorized: true }),
    ).toMatchObject({ senderIsOwner: false, isAuthorizedSender: true });
    const adminContext = await context("100");
    const authority = getCommandOwnerAuthority(adminContext);
    const constructor: unknown = authority && Reflect.get(authority, "constructor");
    const forgedAuthority =
      typeof constructor === "function"
        ? Reflect.construct(constructor, [{ isCurrent: () => true }])
        : { isCurrent: () => true };
    for (const ctx of [
      await context("100", false),
      await context("100", true, "different-bot"),
      structuredClone(adminContext),
      {
        Provider: "discord",
        AccountId: "team",
        SenderId: "100",
        GatewayClientScopes: ["operator.admin"],
      },
      {
        ...adminContext,
        ...Object.fromEntries(
          Object.getOwnPropertySymbols(adminContext).map((key) => [key, { isCurrent: () => true }]),
        ),
      },
      {
        ...adminContext,
        ...Object.fromEntries(
          Object.getOwnPropertySymbols(adminContext).map((key) => [key, forgedAuthority]),
        ),
      },
    ]) {
      expect(resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true }).senderIsOwner).toBe(
        false,
      );
    }
  });
});

it("collects unchanged channel identities but separates a relinked person's new requests", async () => {
  await withAdminIngress(async ({ admins, context }) => {
    const admin = admins[0]!;
    const releases: Array<() => void> = [];
    const capture = async () => {
      const authority = getCommandOwnerAuthority(
        await context(admin.identity.senderId),
      )?.captureOperator();
      if (!authority) {
        throw new Error("Expected linked channel operator authority");
      }
      releases.push(authority.release);
      return {
        ...createQueueTestRun({ prompt: "queue this request" }),
        operatorAuthority: authority.authority,
      };
    };
    try {
      const before = await capture();
      const unchanged = await capture();
      const originalKey = resolveFollowupDeliveryContextKey(before);
      expect(resolveFollowupDeliveryContextKey(unchanged)).toBe(originalKey);
      unlinkUserChannelIdentity(admin.profile.id, admin.identity);
      linkUserChannelIdentity(admin.profile.id, admin.identity);
      const after = await capture();
      expect(() => before.operatorAuthority.assertCurrent()).toThrow();
      expect(resolveFollowupDeliveryContextKey(after)).not.toBe(originalKey);
      expect(() => after.operatorAuthority.assertCurrent()).not.toThrow();
    } finally {
      for (const release of releases) {
        release();
      }
    }
  });
});

it.each(["role", "role-scopes", "grant", "link", "reassign", "host"] as const)(
  "revokes admitted channel owner authority when its %s changes",
  async (change) => {
    await withAdminIngress(
      async ({ cfg, admins, context, retire }) => {
        const admin = admins[0]!;
        const ctx = await context(admin.identity.senderId);
        expect(
          resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true }).senderIsOwner,
        ).toBe(true);
        const operator = getCommandOwnerAuthority(ctx)?.captureOperator?.();
        expect(operator?.authority.profileId).toBe(admin.profile.id);
        const prepared = prepareChannelRunAdmission({
          cfg,
          operatorAuthority: operator?.authority,
          runId: `linked-admin-${change}`,
          agentId: "main",
          ingressKind: "channel",
          boundary: "test.channel",
          assertSourceCurrent: captureCommandOwnerAssertion(ctx),
        });
        const admitted = await prepared.admit("embedded");
        const assertCurrent = resolveAdmittedRunActiveAssertion(admitted);
        expect(assertCurrent).toBeTypeOf("function");
        expect(() => assertCurrent?.()).not.toThrow();
        if (change === "role") {
          setUserProfileRole(admin.profile.id, "member");
        }
        if (change === "role-scopes") {
          cfg.gateway!.roles!.definitions.admin!.scopes = ["operator.read"];
        }
        if (change === "grant") {
          delete cfg.gateway!.auth!.identityScopes!["ada@example.test"];
        }
        if (change === "link") {
          unlinkUserChannelIdentity(admin.profile.id, admin.identity);
        }
        if (change === "reassign") {
          unlinkUserChannelIdentity(admin.profile.id, admin.identity);
          linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
        }
        if (change === "host") {
          retire();
        }
        expect(
          resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true }).senderIsOwner,
        ).toBe(false);
        expect(() => assertCurrent?.()).toThrow();
        expect(() => operator?.authority.assertCurrent()).toThrow();
        expect(operator?.authority.signal?.aborted).toBe(true);
        prepared.close();
        operator?.release();
      },
      change === "grant" ? "identity-grant" : "role",
    );
  },
);

it.each([
  { role: "maintainer", defaultRole: "member", identityGrant: false, owner: true },
  { role: null, defaultRole: "maintainer", identityGrant: false, owner: true },
  { role: "member", defaultRole: "maintainer", identityGrant: true, owner: false },
])("uses current channel role policy for $role with default $defaultRole", async (scenario) => {
  await withAdminIngress(async ({ cfg, admins, context }) => {
    const roles = cfg.gateway!.roles!;
    roles.definitions.maintainer = roles.definitions.admin!;
    delete roles.definitions.admin;
    roles.default = scenario.defaultRole;
    if (scenario.identityGrant) {
      cfg.gateway!.auth = { identityScopes: { "ada@example.test": ["operator.admin"] } };
    }
    const admin = admins[0]!;
    setUserProfileRole(admin.profile.id, scenario.role);
    const ctx = await context(admin.identity.senderId);
    expect(resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true }).senderIsOwner).toBe(
      scenario.owner,
    );
  });
});

it("keeps configured owners independent of Team role and identity links", async () => {
  await withAdminIngress(async ({ cfg, admins, context }) => {
    cfg.commands!.ownerAllowFrom = admins.map(({ identity }) => `discord:${identity.senderId}`);
    const contexts = await Promise.all(admins.map(({ identity }) => context(identity.senderId)));
    const assertions = contexts.map(captureCommandOwnerAssertion);
    for (const { profile, identity } of admins) {
      setUserProfileRole(profile.id, "member");
      unlinkUserChannelIdentity(profile.id, identity);
    }
    for (const [index, ctx] of contexts.entries()) {
      expect(resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true }).senderIsOwner).toBe(
        true,
      );
      expect(assertions[index]).toBeTypeOf("function");
      expect(assertions[index]).not.toThrow();
    }
    cfg.commands!.ownerAllowFrom.shift();
    expect(
      resolveCommandAuthorization({ cfg, ctx: contexts[0]!, commandAuthorized: true })
        .senderIsOwner,
    ).toBe(false);
    expect(assertions[0]).toThrow();
    expect(
      resolveCommandAuthorization({ cfg, ctx: contexts[1]!, commandAuthorized: true })
        .senderIsOwner,
    ).toBe(true);
    expect(assertions[1]).not.toThrow();
  });
});
