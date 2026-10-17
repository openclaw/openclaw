import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { buildExecAutoReviewTranscript } from "../../agents/exec-auto-review-transcript.js";
import { castAgentMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import {
  captureCommandOwnerAssertion,
  getCommandOwnerAuthority,
} from "../../auto-reply/command-owner-authority.js";
import { prepareChannelRunAdmission } from "../../auto-reply/reply/channel-run-admission.js";
import { prepareInternalGetReplyOptions } from "../../auto-reply/reply/get-reply.types.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
} from "../../auto-reply/reply/inbound-meta.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import {
  createTestReplyOperation,
  queueCurrentReplyRunMessage,
} from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import {
  prepareReplyToolAuthority,
  resolveInboundReplyToolAuthorityOverlay,
} from "../../auto-reply/reply/reply-tool-authority.js";
import {
  stripInboundMetadata,
  stripLeadingInboundMetadata,
} from "../../auto-reply/reply/strip-inbound-meta.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { installDiscordRegistryHooks } from "../../auto-reply/test-helpers/command-auth-registry-fixture.js";
import { prepareChannelOperatorAdmin } from "../../gateway/channel-operator-authority.js";
import { mergeImportedChatHistoryMessages } from "../../gateway/cli-session-history.test-support.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createOperatorClient } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resolveGatewayScopedTools } from "../../gateway/tool-resolution.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../plugin-sdk/test-helpers/contracts-testkit.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { stageActivePluginRegistry } from "../../plugins/runtime.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
  resolveUserChannelAuthorizationPolicy,
} from "../../state/user-channel-identities.js";
import {
  linkEmail,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../../state/user-profile-writes.worker.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextAsyncParams,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
} from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import {
  registerOperatorAssignmentTests,
  withOperatorModels,
} from "./operator-assignment.test-support.js";
import {
  createCommandOwnerTestGateway,
  withAdminIngress,
} from "./operator-authority.test-support.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

function authorize(cfg: Parameters<typeof resolveCommandAuthorization>[0]["cfg"], ctx: MsgContext) {
  return resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true });
}
const authorityFor = (ctx: MsgContext) =>
  prepareInternalGetReplyOptions(undefined, ctx)?.operatorAuthority;
const requesterProfile = (prompt: string) =>
  JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)![1]!).requester_profile;
const namedProfile = (id: string) => ({ id, display_name: "Ada Lovelace" });
const expectNoRequester = (ctx: MsgContext) =>
  expect(buildInboundUserContextPrefix(ctx)).not.toContain("requester_profile");
const forgeSymbols = (ctx: MsgContext, value: unknown) => ({
  ...ctx,
  ...Object.fromEntries(Object.getOwnPropertySymbols(ctx).map((key) => [key, value])),
});
const githubIdentity = (login: string) =>
  syncGitHubIdentity({
    identity: { accountId: 123, login },
    authenticationAlias: { kind: "email", email: "ada@example.test" },
  });
async function hasSessionTools(
  cfg: Parameters<typeof authorize>[0],
  ctx: MsgContext,
  senderIsOwner: boolean,
) {
  const { tools } = await resolveGatewayScopedTools({
    cfg,
    sessionKey: ctx.SessionKey!,
    messageProvider: ctx.Provider!,
    senderIsOwner,
    surface: "loopback",
  });
  return tools.some((tool) => tool.name === "sessions");
}
function operatorFixture(fixture: Parameters<Parameters<typeof withAdminIngress>[0]>[0]) {
  return {
    ...fixture,
    admin: fixture.admins[0]!,
    prepare: (
      subject: Parameters<typeof prepareChannelOperatorAdmin>[1] = fixture.admins[0]!.identity,
    ) => prepareChannelOperatorAdmin(fixture.cfg, subject),
    closeDatabase: () =>
      closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(fixture.state.env)),
  };
}
function withOperator(
  run: (fixture: ReturnType<typeof operatorFixture>) => Promise<void>,
  mode: Parameters<typeof withAdminIngress>[1] = "role",
) {
  return withAdminIngress((fixture) => run(operatorFixture(fixture)), mode);
}

installDiscordRegistryHooks();
registerOperatorAssignmentTests();

it.each(["equivalent", "sessions", "sandbox", "agents", "roles-disabled"] as const)(
  "compares linked-channel steering permissions with %s roles",
  (difference) =>
    withOperator(
      async ({ cfg, admins, context, activatePolicy, gateway }) => {
        if (difference !== "roles-disabled") {
          const roles = structuredClone(cfg.gateway!.roles!);
          const otherRole = structuredClone(roles.definitions.admin!);
          if (difference === "sessions") {
            otherRole.sessions.others = "view";
          } else if (difference === "sandbox") {
            otherRole.sandbox = "required";
          } else if (difference === "agents") {
            otherRole.agents = ["main"];
          }
          roles.definitions.steerer = otherRole;
          setUserProfileRole(admins[1]!.profile.id, "steerer");
          await activatePolicy({ roles });
        }
        const overlays = [];
        for (const { identity } of admins) {
          const ctx = await context(identity.senderId);
          const operatorAuthority = expectDefined(authorityFor(ctx), "linked-channel authority");
          overlays.push(
            resolveInboundReplyToolAuthorityOverlay({
              ctx,
              operatorAuthority,
              senderIsOwner: true,
              disableTools: false,
            }),
          );
        }
        const owner = expectDefined(overlays[0], "owner overlay");
        const steerer = expectDefined(overlays[1], "steerer overlay");
        expect(owner.operatorAuthority!.scopes).toEqual(steerer.operatorAuthority!.scopes);
        expect(owner.operatorAuthority!.gatewayAccessGrant).toBeNull();
        expect(steerer.operatorAuthority!.gatewayAccessGrant).toBeNull();
        const uiCapture = expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: createOperatorClient({
              profileId: admins[0]!.profile.id,
              scopes: [...owner.operatorAuthority!.scopes],
            }),
            context: gateway,
            sourceAuthority: null,
          }),
          "Control UI operator authority",
        );
        const run = createQueueTestRun({ prompt: "Owner's channel request" });
        const { operatorAuthority, originatingChannel, toolsAllow, disableTools, ...runOverlay } =
          owner;
        Object.assign(run, { operatorAuthority, originatingChannel, toolsAllow, disableTools });
        Object.assign(run.run, runOverlay, { config: cfg, agentId: "main" });
        const operation = createTestReplyOperation({ sessionId: run.run.sessionId });
        try {
          await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
          await operation.bindToolAuthorityRouteAsync(run.run);
          const queueMessage = vi.fn(async () => {});
          operation.attachBackend({ kind: "embedded", cancel: vi.fn(), queueMessage });
          operation.setPhase("running");
          const accepted = difference === "equivalent" || difference === "roles-disabled";
          await expect(
            queueCurrentReplyRunMessage(run.run.sessionId, "Steering from another linked user", {
              isInboundUserMessage: true,
              toolAuthorityOverlay: steerer,
            }),
          ).resolves.toEqual(
            accepted
              ? { status: "accepted" }
              : { status: "rejected", reason: "tool_authority_mismatch" },
          );
          expect(queueMessage).toHaveBeenCalledTimes(accepted ? 1 : 0);
          expect(owner.operatorAuthority!.rolePolicy).toEqual(uiCapture.authority.rolePolicy);
          if (difference === "roles-disabled") {
            expect(owner.operatorAuthority!.rolePolicy).toBeUndefined();
            expect(steerer.operatorAuthority!.rolePolicy).toBeUndefined();
          }
        } finally {
          operation.complete();
          uiCapture.release();
        }
      },
      difference === "roles-disabled" ? "identity-grant" : "role",
    ),
);

it("exposes verified requester metadata without widening owner tools", () =>
  withOperator(async ({ cfg, admins, context }) => {
    using reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    for (const [index, sender, verified, role, linked, owner] of [
      [0, undefined, true, "admin", true, true],
      [1, undefined, true, "admin", true, true],
      [0, undefined, false, "admin", false, false],
      [0, "unlinked", true, "admin", false, false],
      [0, undefined, true, "member", true, false],
    ] as const) {
      const admin = admins[index]!;
      setDisplayName(admin.profile.id, "Ada Lovelace");
      setUserProfileRole(admin.profile.id, role);
      reads.mockClear();
      const ctx = await context(sender ?? admin.identity.senderId, verified);
      if (verified) {
        expect(
          reads.mock.calls.filter(
            ([, command]) => command.type === "userProfiles.channelIdentity.resolve",
          ),
        ).toHaveLength(1);
      }
      const prompt = buildInboundUserContextPrefix({ ...ctx });
      expect(requesterProfile(prompt)).toEqual(linked ? namedProfile(admin.profile.id) : undefined);
      expect(prompt.includes("requester_profile is the verified linked requester")).toBe(linked);
      const text = "assign this to me";
      const submitted = `${prompt}\n\n${text}`;
      for (const strip of [stripInboundMetadata, stripLeadingInboundMetadata]) {
        expect(strip(submitted)).toBe(text);
      }
      const sentAt = Date.parse("2026-09-29T03:28:00.915Z");
      expect(
        mergeImportedChatHistoryMessages({
          localMessages: [{ role: "user", content: text, timestamp: sentAt }],
          importedMessages: [
            {
              role: "user",
              content: submitted,
              timestamp: sentAt + 435,
              __openclaw: { importedFrom: "claude-cli", externalId: "u1", cliSessionId: "s1" },
            },
          ],
        }),
      ).toHaveLength(1);
      const auth = authorize(cfg, { ...ctx });
      expect(auth).toMatchObject({ senderIsOwner: owner, isAuthorizedSender: true });
      const { senderIsOwner } = auth;
      if (owner) {
        const transcript = buildExecAutoReviewTranscript({
          messages: [
            castAgentMessage({
              role: "user",
              content: "Assign this session to the requester",
              timestamp: 0,
              __openclaw: {
                senderIsOwner,
                senderIdentity: {
                  type: "observation",
                  pluginId: "discord",
                  accountId: "team",
                  senderKind: "human",
                  id: admin.identity.senderId,
                },
              },
            }),
          ],
        });
        expect(transcript.entries[0]?.origin).toBe("operator");
      }
      expect(await hasSessionTools(cfg, ctx, senderIsOwner)).toBe(owner);
    }
  }));

it("refreshes requester facts and rejects forged context", () =>
  withOperator(async ({ cfg, admin, admins, context, retire }) => {
    const original = await context(admin.identity.senderId);
    const stablePrompt = buildInboundMetaSystemPrompt(original, cfg);
    for (const sender of [admins[1]!.identity.senderId, "unlinked"]) {
      expect(buildInboundMetaSystemPrompt(await context(sender), cfg)).toBe(stablePrompt);
    }
    expect(stablePrompt).not.toContain("requester_profile");
    expect(buildInboundUserContextPrefix(original)).toContain(admin.profile.id);
    setDisplayName(admin.profile.id, "Current label");
    expect(buildInboundUserContextPrefix(await context(admin.identity.senderId))).toContain(
      '"display_name":"Current label"',
    );
    for (const forged of [
      structuredClone(original),
      { ...original, SenderId: admins[1]!.identity.senderId },
      { ...original, AccountId: "different-account" },
      { ...original, Provider: "slack" },
      { ...original, Surface: "webchat" },
      { ...original, OriginatingChannel: "slack" },
      forgeSymbols(original, { profileId: admin.profile.id, isCurrent: () => true }),
      {
        Provider: "discord",
        SenderId: admin.identity.senderId,
        RequesterProfile: { id: admin.profile.id },
      },
    ]) {
      expectNoRequester(forged);
    }
    const adminContext = await context(admin.identity.senderId);
    expect(authorize(cfg, adminContext).senderIsOwner).toBe(true);
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
      forgeSymbols(adminContext, { isCurrent: () => true }),
      forgeSymbols(adminContext, forgedAuthority),
    ]) {
      expect(authorize(cfg, ctx).senderIsOwner).toBe(false);
    }
    unlinkUserChannelIdentity(admin.profile.id, admin.identity);
    expectNoRequester(original);
    expectNoRequester(await context(admin.identity.senderId));
    linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
    const relinked = await context(admin.identity.senderId);
    expect(buildInboundUserContextPrefix(relinked)).toContain(admins[1]!.profile.id);
    retire();
    expectNoRequester(relinked);
  }));

it("keeps policy readable by schema-19 predecessors", () =>
  withOperator(async ({ cfg, activatePolicy }) => {
    for (const owners of [undefined, []]) {
      cfg.commands!.ownerAllowFrom = owners;
      await activatePolicy({});
      // Predecessor authority readers compare this entire persisted value to the role policy.
      expect
        .soft(readConfigMachineState("operator.channelPolicy"))
        .toEqual(resolveUserChannelAuthorizationPolicy(cfg.gateway));
    }
  }));

it.each(["role", "role-scopes", "grant", "link", "reassign", "host"] as const)(
  "revokes admitted channel owner authority when its %s changes",
  (change) =>
    withOperator(
      async ({ cfg, admin, admins, context, retire }) => {
        const ctx = await context(admin.identity.senderId);
        expect(authorize(cfg, ctx).senderIsOwner).toBe(true);
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
        const changes = {
          role: () => setUserProfileRole(admin.profile.id, "member"),
          "role-scopes": () => {
            cfg.gateway!.roles!.definitions.admin!.scopes = ["operator.read"];
          },
          grant: () => delete cfg.gateway!.auth!.identityScopes!["ada@example.test"],
          link: () => unlinkUserChannelIdentity(admin.profile.id, admin.identity),
          reassign: () => {
            unlinkUserChannelIdentity(admin.profile.id, admin.identity);
            linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
          },
          host: retire,
        };
        changes[change]();
        expect(authorize(cfg, ctx).senderIsOwner).toBe(false);
        expect(() => assertCurrent?.()).toThrow();
        prepared.close();
      },
      change === "grant" ? "identity-grant" : "role",
    ),
);

it.each([
  "role-restore",
  "relink",
  "reassign",
  "merge",
  "definition",
  "default",
  "identity-scopes",
] as const)("never recovers the original owner after %s retires its durable reference", (change) =>
  withOperator(
    async ({ cfg, admin, admins, activatePolicy, context, prepare, closeDatabase }) => {
      if (change === "default") {
        setUserProfileRole(admin.profile.id, null);
        await activatePolicy({ roles: { ...cfg.gateway!.roles!, default: "admin" } });
      }
      const assertCurrent =
        change === "definition"
          ? captureCommandOwnerAssertion(await context(admin.identity.senderId))
          : undefined;
      if (change === "definition") {
        expect(assertCurrent).toBeTypeOf("function");
        expect(assertCurrent).not.toThrow();
      }
      const admitted = await prepare();
      expect(admitted?.isCurrent(cfg)).toBe(true);
      const reference = admitted!.recoveryReference!;
      expect(reference).toBeDefined();
      if (change === "role-restore") {
        setUserProfileRole(admin.profile.id, "member");
        setUserProfileRole(admin.profile.id, "admin");
      } else if (change === "relink" || change === "reassign") {
        unlinkUserChannelIdentity(admin.profile.id, admin.identity);
        linkUserChannelIdentity(
          change === "relink" ? admin.profile.id : admins[1]!.profile.id,
          admin.identity,
        );
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
      if (change === "definition") {
        const fresh = await context(admin.identity.senderId);
        expect(authorize(cfg, fresh).senderIsOwner).toBe(true);
        expect(assertCurrent).toThrow();
      }
      expect(admitted?.isCurrent(cfg)).toBe(false);
      await closeDatabase();
      await expect(prepare(reference)).resolves.toBeUndefined();
      await expect(prepare(reference)).resolves.toBeUndefined();
    },
    change === "identity-scopes" ? "identity-grant" : "role",
  ),
);

it.each(["allowed", "revoked", "replaced", "unavailable"] as const)(
  "resumes only the original plugin grant when it is %s",
  (change) =>
    withOperator(async ({ cfg, admin, activatePolicy, context, prepare, closeDatabase }) => {
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
      const original = await prepare();
      const reference = original!.recoveryReference!;
      expect(reference).toBeDefined();
      const authority =
        change === "revoked" ? authorityFor(await context(admin.identity.senderId)) : undefined;
      const revoke = () => {
        if (change === "revoked" || change === "replaced") {
          lifetime.abort();
          grantId = change === "revoked" ? undefined : "78a7c3d0-c3a6-49a5-91e7-02c153e39ab5";
          lifetime = new AbortController();
        }
      };
      if (change === "revoked") {
        withOperatorModels(authority, revoke);
      } else {
        revoke();
      }
      unavailable = change === "unavailable";
      await closeDatabase();
      if (change === "unavailable") {
        await expect(prepare(reference)).rejects.toMatchObject({
          name: "GatewayOperatorAccessUnavailableError",
        });
      } else if (change === "allowed") {
        expect((await prepare(reference))?.isCurrent(cfg)).toBe(true);
      } else {
        await expect(prepare(reference)).resolves.toBeUndefined();
        // Restoring access creates a successor grant, never the retired grant's identity.
        grantId = "78a7c3d0-c3a6-49a5-91e7-02c153e39ab5";
        expect((await prepare())?.isCurrent(cfg)).toBe(true);
        await expect(prepare(reference)).resolves.toBeUndefined();
      }
    }),
);

it("rolls back policy retirement with its active reference", () =>
  withOperator(async ({ cfg, activatePolicy, prepare, closeDatabase }) => {
    const original = await prepare();
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
    await closeDatabase();
    expect((await prepare(original!.recoveryReference!))?.isCurrent(cfg)).toBe(true);
  }));

it.each(["role", "identity-grant", "missing", "malformed", "version", "extra", "basis"] as const)(
  "resumes only an exact, live JSON recovery reference: %s",
  (damage) =>
    withOperator(
      async ({ cfg, prepare, closeDatabase }) => {
        const admitted = await prepare();
        const reference = { ...admitted!.recoveryReference! };
        expect(reference.id).toBeTypeOf("string");
        const mutations: Record<string, object> = {
          missing: { id: "00000000-0000-4000-8000-000000000000" },
          malformed: { id: "corrupt" },
          version: { version: 2 },
          extra: { scopes: ["operator.admin"] },
        };
        const encoded = JSON.stringify({ ...reference, ...mutations[damage] });
        if (damage === "basis") {
          openOpenClawStateDatabase()
            .db.prepare(
              "UPDATE user_profile_identities SET authorization_basis_json = ? WHERE authorization_id = ?",
            )
            .run("{", reference.id);
        }
        if (damage === "role" || damage === "identity-grant") {
          expect(admitted?.isCurrent(cfg)).toBe(true);
          expect(admitted?.recoveryReference).toEqual({ version: 1, id: expect.any(String) });
          await closeDatabase();
          expect(admitted?.isCurrent(cfg)).toBe(false);
          const decoded = JSON.parse(encoded);
          const resumed = await prepare(decoded);
          expect(resumed?.isCurrent(cfg)).toBe(true);
          expect(resumed?.recoveryReference).toEqual(decoded);
        } else {
          await expect(prepare(JSON.parse(encoded))).resolves.toBeUndefined();
        }
      },
      damage === "identity-grant" ? "identity-grant" : "role",
    ),
);

it.each([
  { role: "maintainer", defaultRole: "member", identityGrant: false, owner: true, github: false },
  { role: null, defaultRole: "maintainer", identityGrant: false, owner: true, github: false },
  { role: "member", defaultRole: "maintainer", identityGrant: true, owner: false, github: false },
  { role: null, defaultRole: "member", identityGrant: false, owner: true, github: true },
])(
  "uses current channel role policy for $role with default $defaultRole (github=$github)",
  (scenario) =>
    withOperator(async ({ cfg, admin, context, activatePolicy }) => {
      setUserProfileRole(admin.profile.id, scenario.role);
      if (scenario.github) {
        githubIdentity("Channel-Admin");
        await activatePolicy({
          roles: {
            ...cfg.gateway!.roles!,
            assignments: { byGithubLogin: { "channel-admin": "admin" } },
          },
        });
      } else {
        const roles = cfg.gateway!.roles!;
        roles.definitions.maintainer = roles.definitions.admin!;
        delete roles.definitions.admin;
        roles.default = scenario.defaultRole;
        if (scenario.identityGrant) {
          cfg.gateway!.auth = { identityScopes: { "ada@example.test": ["operator.admin"] } };
        }
      }
      const ctx = await context(admin.identity.senderId);
      expect(authorize(cfg, ctx).senderIsOwner).toBe(scenario.owner);
      if (scenario.github) {
        const authority = expectDefined(authorityFor(ctx), "GitHub operator authority");
        expect(authority).toMatchObject({
          profileId: admin.profile.id,
          scopes: ["operator.admin"],
          rolePolicy: { sessionAccessCap: "write" },
        });
        githubIdentity("Renamed-Channel-Admin");
        expect(() => authority.assertCurrent()).toThrow();
        const renamed = await context(admin.identity.senderId);
        expect(authorityFor(renamed)).toBeUndefined();
      }
    }),
);

it("keeps configured owners independent of role and identity links", () =>
  withOperator(async ({ cfg, admins, context }) => {
    cfg.commands!.ownerAllowFrom = admins.map(({ identity }) => `discord:${identity.senderId}`);
    const contexts = await Promise.all(admins.map(({ identity }) => context(identity.senderId)));
    const assertions = contexts.map(captureCommandOwnerAssertion);
    for (const { profile, identity } of admins) {
      setUserProfileRole(profile.id, "member");
      unlinkUserChannelIdentity(profile.id, identity);
    }
    for (const [index, ctx] of contexts.entries()) {
      expect(authorize(cfg, ctx).senderIsOwner).toBe(true);
      expect(assertions[index]).toBeTypeOf("function");
      expect(assertions[index]).not.toThrow();
    }
    cfg.commands!.ownerAllowFrom.shift();
    expect(authorize(cfg, contexts[0]!).senderIsOwner).toBe(false);
    expect(assertions[0]).toThrow();
    expect(authorize(cfg, contexts[1]!).senderIsOwner).toBe(true);
    expect(assertions[1]).not.toThrow();
  }));

it("carries native Slack requester authority and keeps relay replays asserted", () =>
  withOperator(async ({ cfg, state, admin }) => {
    cfg.channels = { slack: { accounts: { team: { allowFrom: ["*"] } } } };
    const profile = admin.profile;
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
    const buildHostContext = createHostChannelInboundEventContextBuilder(
      buildChannelInboundEventContext,
      owner,
    );
    function buildContext(
      input: BuildChannelInboundEventContextAsyncParams,
    ): Promise<BuiltChannelInboundEventContext>;
    function buildContext(
      input: BuildChannelInboundEventContextParams,
    ): BuiltChannelInboundEventContext;
    function buildContext(input: BuildChannelInboundEventContextParams) {
      return buildHostContext(input);
    }
    const runtime = createPluginRuntimeMock({
      channel: {
        inbound: {
          ingress: createHostChannelIngressRuntime(owner),
          buildContext,
        },
      },
    });
    const { withSlackIngressIdentityTestHarness } = await loadBundledPluginFacade<{
      withSlackIngressIdentityTestHarness: (
        params: { cfg: typeof cfg; runtime: typeof runtime; stateDir: string },
        run: (harness: {
          contexts: MsgContext[];
          receiveSocket: (user: string) => Promise<void>;
          receiveHttp: (validSignature: boolean) => Promise<number>;
        }) => Promise<void>,
      ) => Promise<void>;
    }>({ pluginId: "slack", artifactBasename: "ingress.test-api.js" });
    await withSlackIngressIdentityTestHarness(
      { cfg, runtime, stateDir: state.stateDir },
      async ({ contexts, receiveSocket, receiveHttp }) => {
        expect(contexts).toHaveLength(1);
        const check = async (index: number, linked: boolean, isOwner: boolean) => {
          const turn = contexts[index]!;
          const prompt = buildInboundUserContextPrefix(turn);
          expect
            .soft(requesterProfile(prompt))
            .toEqual(linked ? namedProfile(profile.id) : undefined);
          const { senderIsOwner } = authorize(cfg, turn);
          expect.soft(senderIsOwner).toBe(isOwner);
          expect.soft(await hasSessionTools(cfg, turn, senderIsOwner)).toBe(isOwner);
        };
        await check(0, false, false);
        for (const [index, user, role, linked, isOwner] of [
          [1, "U123", "admin", true, true],
          [2, "U_UNLINKED", "admin", false, false],
          [3, "U123", "member", true, false],
        ] as const) {
          setUserProfileRole(profile.id, role);
          await receiveSocket(user);
          expect(contexts).toHaveLength(index + 1);
          await check(index, linked, isOwner);
        }
        setUserProfileRole(profile.id, "admin");
        expect(await receiveHttp(false)).toBe(401);
        expect(contexts).toHaveLength(4);
        expect(await receiveHttp(true)).toBe(200);
        expect(contexts).toHaveLength(5);
        await check(4, true, true);
      },
    );
  }));
