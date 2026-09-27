import { expect, it } from "vitest";
import { withSlackIngressIdentityTestHarness } from "../../../extensions/slack/ingress.test-api.js";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { buildExecAutoReviewTranscript } from "../../agents/exec-auto-review-transcript.js";
import { castAgentMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import {
  captureCommandOwnerAssertion,
  getCommandOwnerAuthority,
} from "../../auto-reply/command-owner-authority.js";
import { prepareChannelRunAdmission } from "../../auto-reply/reply/channel-run-admission.js";
import { buildInboundMetaSystemPrompt } from "../../auto-reply/reply/inbound-meta.js";
import { installDiscordRegistryHooks } from "../../auto-reply/test-helpers/command-auth-registry-fixture.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { prepareChannelOperatorAdmin } from "../../gateway/channel-operator-authority.js";
import { createSessionMutationTestContext } from "../../gateway/server-methods/sessions-mutations.owner.test-support.js";
import { resolveGatewayScopedTools } from "../../gateway/tool-resolution.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../plugin-sdk/test-helpers/contracts-testkit.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { stageActivePluginRegistry } from "../../plugins/runtime.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
  resolveUserChannelAuthorizationPolicy,
} from "../../state/user-channel-identities.js";
import { linkEmail, setDisplayName, setUserProfileRole } from "../../state/user-profiles.js";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import {
  createCommandOwnerTestGateway,
  withAdminIngress,
} from "./operator-authority.test-support.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

installDiscordRegistryHooks();

it("exposes a verified linked requester in trusted metadata without widening owner tools", async () => {
  await withAdminIngress(async ({ cfg, state, admins, context }) => {
    const admin = admins[0]!;
    setDisplayName(admin.profile.id, "Ada Lovelace");
    for (const scenario of [
      { sender: admin.identity.senderId, verified: true, role: "admin", linked: true, owner: true },
      {
        sender: admin.identity.senderId,
        verified: false,
        role: "admin",
        linked: false,
        owner: false,
      },
      { sender: "unlinked", verified: true, role: "admin", linked: false, owner: false },
      {
        sender: admin.identity.senderId,
        verified: true,
        role: "member",
        linked: true,
        owner: false,
      },
    ]) {
      setUserProfileRole(admin.profile.id, scenario.role);
      const ctx = await context(scenario.sender, scenario.verified);
      const prompt = buildInboundMetaSystemPrompt({ ...ctx }, cfg);
      const metadata = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)![1]!);
      expect(metadata.requester_profile).toEqual(
        scenario.linked ? { id: admin.profile.id, display_name: "Ada Lovelace" } : undefined,
      );
      const { senderIsOwner } = resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true });
      expect(senderIsOwner).toBe(scenario.owner);
      const tools = resolveGatewayScopedTools({
        cfg,
        sessionKey: ctx.SessionKey!,
        messageProvider: "discord",
        senderIsOwner,
        surface: "loopback",
      }).tools;
      expect(tools.some((tool) => tool.name === "sessions")).toBe(scenario.owner);
      if (scenario.owner) {
        const sessionKey = ctx.SessionKey!;
        const scope = { agentId: "main", sessionKey, env: state.env };
        await upsertSessionEntryCore(scope, {
          sessionId: "requester-assignment",
          updatedAt: 1,
          visibility: "shared",
        });
        const gateway = createSessionMutationTestContext(cfg);
        const tool = tools.find((entry) => entry.name === "sessions")!;
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            gatewayContextResolver: () => gateway,
            operationalRunInstance: { instanceId: "requester-instance", runId: "requester-run" },
            receiptAuthority: () => true,
          },
          async () => {
            const result = await tool.execute("assign-requester", {
              action: "assign_owner",
              ownerType: "human",
              ownerId: metadata.requester_profile.id,
            });
            expect(result.details).toMatchObject({
              status: "updated",
              owner: { type: "human", id: admin.profile.id },
            });
          },
        );
        expect(loadSessionEntry(scope)?.owner?.actor).toMatchObject({
          type: "human",
          id: admin.profile.id,
        });
      }
    }
  });
});

it("refreshes requester facts on later turns and rejects unlinked or forged context", async () => {
  await withAdminIngress(async ({ cfg, admins, context, retire }) => {
    const admin = admins[0]!;
    const original = await context(admin.identity.senderId);
    expect(buildInboundMetaSystemPrompt(original, cfg)).toContain(admin.profile.id);
    setDisplayName(admin.profile.id, "Current label");
    expect(buildInboundMetaSystemPrompt(await context(admin.identity.senderId), cfg)).toContain(
      '"display_name": "Current label"',
    );
    for (const forged of [
      JSON.parse(JSON.stringify(original)),
      { ...original, SenderId: admins[1]!.identity.senderId },
      { ...original, AccountId: "different-account" },
      { ...original, Provider: "slack" },
      { ...original, Surface: "webchat" },
      { ...original, OriginatingChannel: "slack" },
      {
        ...original,
        ...Object.fromEntries(
          Object.getOwnPropertySymbols(original).map((key) => [
            key,
            { profileId: admin.profile.id, isCurrent: () => true },
          ]),
        ),
      },
      {
        Provider: "discord",
        SenderId: admin.identity.senderId,
        RequesterProfile: { id: admin.profile.id },
      },
    ]) {
      expect(buildInboundMetaSystemPrompt(forged, cfg)).not.toContain("requester_profile");
    }
    unlinkUserChannelIdentity(admin.profile.id, admin.identity);
    expect(buildInboundMetaSystemPrompt(original, cfg)).not.toContain("requester_profile");
    expect(buildInboundMetaSystemPrompt(await context(admin.identity.senderId), cfg)).not.toContain(
      "requester_profile",
    );
    linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
    const relinked = await context(admin.identity.senderId);
    expect(buildInboundMetaSystemPrompt(relinked, cfg)).toContain(admins[1]!.profile.id);
    retire();
    expect(buildInboundMetaSystemPrompt(relinked, cfg)).not.toContain("requester_profile");
  });
});

it("keeps native policy readable by schema-19 predecessors without configured owners", async () => {
  await withAdminIngress(async ({ cfg, activatePolicy }) => {
    for (const owners of [undefined, []]) {
      cfg.commands!.ownerAllowFrom = owners;
      await activatePolicy({});
      // Predecessor authority readers compare this entire persisted value to the role policy.
      expect
        .soft(readConfigMachineState("operator.channelPolicy"))
        .toEqual(resolveUserChannelAuthorizationPolicy(cfg.gateway));
    }
  });
});

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
        const prepared = prepareChannelRunAdmission({
          cfg,
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
        prepared.close();
      },
      change === "grant" ? "identity-grant" : "role",
    );
  },
);

it.each(["definition", "default", "identity-scopes"] as const)(
  "does not revive an admitted channel owner after restoring its policy %s",
  async (change) => {
    await withAdminIngress(
      async ({ cfg, admins, context, activatePolicy }) => {
        const admin = admins[0]!;
        if (change === "default") {
          setUserProfileRole(admin.profile.id, null);
          await activatePolicy({ roles: { ...cfg.gateway!.roles!, default: "admin" } });
        }
        const ctx = await context(admin.identity.senderId);
        const assertCurrent = captureCommandOwnerAssertion(ctx);
        expect(assertCurrent).toBeTypeOf("function");
        expect(assertCurrent).not.toThrow();
        const restored = structuredClone(cfg.gateway!);
        const revoked = structuredClone(restored);
        if (change === "definition") {
          revoked.roles!.definitions.admin!.scopes = ["operator.read"];
        } else if (change === "default") {
          revoked.roles!.default = "member";
        } else {
          delete revoked.auth!.identityScopes;
        }
        await activatePolicy(revoked);
        await activatePolicy(restored);

        const fresh = await context(admin.identity.senderId);
        expect(
          resolveCommandAuthorization({ cfg, ctx: fresh, commandAuthorized: true }).senderIsOwner,
        ).toBe(true);
        expect(assertCurrent).toThrow();
      },
      change === "identity-scopes" ? "identity-grant" : "role",
    );
  },
);

it.each(["role", "identity-grant"] as const)(
  "recovers an original %s owner from its exact JSON reference across a database lifecycle",
  async (authority) => {
    await withAdminIngress(async ({ cfg, admins }) => {
      const admitted = await prepareChannelOperatorAdmin(cfg, admins[0]!.identity);
      expect(admitted?.isCurrent(cfg)).toBe(true);
      expect(admitted?.recoveryReference).toEqual({ version: 1, id: expect.any(String) });
      const encoded = JSON.stringify(admitted!.recoveryReference);
      await closeOpenClawStateDatabaseAsync();
      expect(admitted?.isCurrent(cfg)).toBe(false);
      const reference = JSON.parse(encoded);
      const resumed = await prepareChannelOperatorAdmin(cfg, reference);
      expect(resumed?.isCurrent(cfg)).toBe(true);
      expect(resumed?.recoveryReference).toEqual(reference);
    }, authority);
  },
);

it.each([
  "role",
  "role-restore",
  "unlink",
  "relink",
  "reassign",
  "merge",
  "definition",
  "default",
  "identity-scopes",
] as const)(
  "never recovers the original owner after %s retires its durable reference",
  async (change) => {
    await withAdminIngress(
      async ({ cfg, admins, activatePolicy }) => {
        const admin = admins[0]!;
        if (change === "default") {
          setUserProfileRole(admin.profile.id, null);
          await activatePolicy({ roles: { ...cfg.gateway!.roles!, default: "admin" } });
        }
        const admitted = await prepareChannelOperatorAdmin(cfg, admin.identity);
        expect(admitted?.isCurrent(cfg)).toBe(true);
        const reference = admitted!.recoveryReference!;
        expect(reference).toBeDefined();
        if (change === "role" || change === "role-restore") {
          setUserProfileRole(admin.profile.id, "member");
          if (change === "role-restore") {
            setUserProfileRole(admin.profile.id, "admin");
          }
        } else if (change === "unlink" || change === "relink" || change === "reassign") {
          unlinkUserChannelIdentity(admin.profile.id, admin.identity);
          if (change !== "unlink") {
            linkUserChannelIdentity(
              change === "relink" ? admin.profile.id : admins[1]!.profile.id,
              admin.identity,
            );
          }
        } else if (change === "merge") {
          linkEmail("ada@example.test", admins[1]!.profile.id);
        } else if (change === "identity-scopes") {
          const original = structuredClone(cfg.gateway!.auth!);
          await activatePolicy({ auth: { ...original, identityScopes: undefined } });
          await activatePolicy({ auth: original });
        } else {
          const original = structuredClone(cfg.gateway!.roles!);
          const revoked = structuredClone(original);
          if (change === "definition") {
            revoked.definitions.admin!.scopes = ["operator.read"];
          } else {
            revoked.default = "member";
          }
          await activatePolicy({ roles: revoked });
          await activatePolicy({ roles: original });
        }
        expect(admitted?.isCurrent(cfg)).toBe(false);
        await closeOpenClawStateDatabaseAsync();
        await expect(prepareChannelOperatorAdmin(cfg, reference)).resolves.toBeUndefined();
        await expect(prepareChannelOperatorAdmin(cfg, reference)).resolves.toBeUndefined();
      },
      change === "identity-scopes" ? "identity-grant" : "role",
    );
  },
);

it.each(["allowed", "revoked", "replaced", "unavailable"] as const)(
  "resumes only the original plugin grant when it is %s",
  async (change) => {
    await withAdminIngress(async ({ cfg, admins, activatePolicy }) => {
      const pluginId = "channel-owner-access";
      const originalId = "86633673-b1dd-4500-85e2-b6e6e490810f";
      let grantId: string | undefined = originalId;
      let lifetime = new AbortController();
      let unavailable = false;
      const { config, registry } = createPluginRegistryFixture(cfg);
      registerVirtualTestPlugin({
        registry,
        config,
        id: pluginId,
        name: "Channel owner access",
        register(api) {
          const current = () => {
            if (unavailable) {
              throw new Error("Policy store is unavailable");
            }
            const signal = lifetime.signal;
            return grantId
              ? { grantId, signal, assertCurrent: () => signal.throwIfAborted() }
              : undefined;
          };
          api.registerGatewayAccessPolicy({
            authorize: current,
            resume: ({ grantId: requested }) => (requested === grantId ? current() : undefined),
          });
        },
      });
      stageActivePluginRegistry(registry.registry, null, "default");
      const roles = structuredClone(cfg.gateway!.roles!);
      roles.definitions.admin!.accessPolicyPlugin = pluginId;
      await activatePolicy({ roles });
      const original = await prepareChannelOperatorAdmin(cfg, admins[0]!.identity);
      const reference = original!.recoveryReference!;
      expect(reference).toBeDefined();
      if (change === "revoked" || change === "replaced") {
        lifetime.abort();
        grantId = change === "revoked" ? undefined : "78a7c3d0-c3a6-49a5-91e7-02c153e39ab5";
        lifetime = new AbortController();
      }
      unavailable = change === "unavailable";
      await closeOpenClawStateDatabaseAsync();
      if (change === "unavailable") {
        await expect(prepareChannelOperatorAdmin(cfg, reference)).rejects.toMatchObject({
          name: "GatewayOperatorAccessUnavailableError",
        });
      } else if (change === "allowed") {
        expect((await prepareChannelOperatorAdmin(cfg, reference))?.isCurrent(cfg)).toBe(true);
      } else {
        await expect(prepareChannelOperatorAdmin(cfg, reference)).resolves.toBeUndefined();
        // Restoring access creates a successor grant, never the retired grant's identity.
        grantId = "78a7c3d0-c3a6-49a5-91e7-02c153e39ab5";
        expect((await prepareChannelOperatorAdmin(cfg, admins[0]!.identity))?.isCurrent(cfg)).toBe(
          true,
        );
        await expect(prepareChannelOperatorAdmin(cfg, reference)).resolves.toBeUndefined();
      }
    });
  },
);

it("keeps the active policy and its reference when durable policy retirement rolls back", async () => {
  await withAdminIngress(async ({ cfg, admins, activatePolicy }) => {
    const original = await prepareChannelOperatorAdmin(cfg, admins[0]!.identity);
    const activeRoles = structuredClone(cfg.gateway!.roles!);
    const changed = structuredClone(activeRoles);
    changed.definitions.admin!.scopes = ["operator.read"];
    const db = openOpenClawStateDatabase().db;
    db.exec(`CREATE TRIGGER fail_policy_publication BEFORE UPDATE ON config_machine_state
      WHEN NEW.state_key = 'operator.channelPolicy'
      BEGIN SELECT RAISE(ABORT, 'fixture policy write failed'); END;`);
    await expect(activatePolicy({ roles: changed })).rejects.toThrow("fixture policy write failed");
    expect(cfg.gateway!.roles).toEqual(activeRoles);
    db.exec("DROP TRIGGER fail_policy_publication");
    await closeOpenClawStateDatabaseAsync();
    expect(
      (await prepareChannelOperatorAdmin(cfg, original!.recoveryReference!))?.isCurrent(cfg),
    ).toBe(true);
  });
});

it.each(["missing", "malformed", "version", "extra", "basis"] as const)(
  "fails closed on a %s recovery reference without treating its ID as authority",
  async (damage) => {
    await withAdminIngress(async ({ cfg, admins }) => {
      const admitted = await prepareChannelOperatorAdmin(cfg, admins[0]!.identity);
      const reference = { ...admitted!.recoveryReference! };
      expect(reference.id).toBeTypeOf("string");
      let encoded = JSON.stringify(reference);
      if (damage === "missing") {
        encoded = JSON.stringify({ ...reference, id: "00000000-0000-4000-8000-000000000000" });
      }
      if (damage === "malformed") {
        encoded = JSON.stringify({ ...reference, id: "corrupt" });
      }
      if (damage === "version") {
        encoded = JSON.stringify({ ...reference, version: 2 });
      }
      if (damage === "extra") {
        encoded = JSON.stringify({ ...reference, scopes: ["operator.admin"] });
      }
      if (damage === "basis") {
        openOpenClawStateDatabase()
          .db.prepare(
            "UPDATE user_profile_identities SET authorization_basis_json = ? WHERE authorization_id = ?",
          )
          .run("{", reference.id);
      }
      await expect(prepareChannelOperatorAdmin(cfg, JSON.parse(encoded))).resolves.toBeUndefined();
    });
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

it("carries native Slack requester authority through preparation and keeps replayed relay input asserted", async () => {
  await withAdminIngress(async ({ cfg, state, admins }) => {
    cfg.channels = { slack: { accounts: { team: { allowFrom: ["*"] } } } };
    const profile = admins[0]!.profile;
    setDisplayName(profile.id, "Ada Lovelace");
    linkUserChannelIdentity(profile.id, {
      channelId: "slack",
      accountId: "team",
      senderId: "U123",
    });
    const gateway = createCommandOwnerTestGateway(cfg);
    const owner = {
      channelId: "slack",
      isLive: () => true,
      resolveGatewayContext: () => gateway,
    };
    const runtime = createPluginRuntimeMock({
      channel: {
        inbound: {
          ingress: createHostChannelIngressRuntime(owner),
          buildContext: createHostChannelInboundEventContextBuilder(
            buildChannelInboundEventContext,
            owner,
          ),
        },
      },
    });
    await withSlackIngressIdentityTestHarness(
      { cfg, runtime, stateDir: state.stateDir },
      async ({ contexts, receiveSocket, receiveHttp }) => {
        expect(contexts).toHaveLength(1);
        const check = (index: number, linked: boolean, isOwner: boolean) => {
          const turn = contexts[index]!;
          const prompt = buildInboundMetaSystemPrompt(turn, cfg);
          const metadata = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)![1]!);
          expect
            .soft(metadata.requester_profile)
            .toEqual(linked ? { id: profile.id, display_name: "Ada Lovelace" } : undefined);
          const { senderIsOwner } = resolveCommandAuthorization({
            cfg,
            ctx: turn,
            commandAuthorized: true,
          });
          expect.soft(senderIsOwner).toBe(isOwner);
          const { tools } = resolveGatewayScopedTools({
            cfg,
            sessionKey: turn.SessionKey!,
            messageProvider: "slack",
            senderIsOwner,
            surface: "loopback",
          });
          expect.soft(tools.some((tool) => tool.name === "sessions")).toBe(isOwner);
        };
        check(0, false, false);
        for (const [index, user, role, linked, isOwner] of [
          [1, "U123", "admin", true, true],
          [2, "U_UNLINKED", "admin", false, false],
          [3, "U123", "member", true, false],
        ] as const) {
          setUserProfileRole(profile.id, role);
          await receiveSocket(user);
          expect(contexts).toHaveLength(index + 1);
          check(index, linked, isOwner);
        }
        setUserProfileRole(profile.id, "admin");
        expect(await receiveHttp(false)).toBe(401);
        expect(contexts).toHaveLength(4);
        expect(await receiveHttp(true)).toBe(200);
        expect(contexts).toHaveLength(5);
        check(4, true, true);
      },
    );
  });
});
