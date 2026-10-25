import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  bindOperatorModelExecution,
  readAdmittedRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  callInProcessGatewayTool,
  callInProcessGatewayToolWithCreation,
} from "../../agents/tools/in-process-gateway.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import {
  captureCommandOwnerAssertion,
  CommandOwnerRevokedError,
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
import type { MsgContext } from "../../auto-reply/templating.js";
import { installDiscordRegistryHooks } from "../../auto-reply/test-helpers/command-auth-registry-fixture.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { prepareChannelOperatorAdmin } from "../../gateway/channel-operator-authority.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createSessionMutationTestContext } from "../../gateway/server-methods/sessions-mutations.owner.test-support.js";
import { initializeSessionReadContext } from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { createOperatorClient } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { resolveGatewayScopedTools } from "../../gateway/tool-resolution.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../plugin-sdk/test-helpers/contracts-testkit.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { stageActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
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
import { createHostIngressFixture } from "./host-ingress.test-support.js";
import { withAdminIngress } from "./operator-authority.test-support.js";

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

it.each(["equivalent", "sessions", "sandbox", "agents", "roles-disabled"] as const)(
  "keeps linked-channel steering requester-bound with %s roles",
  async (difference) => {
    await withAdminIngress(
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
        for (const { identity } of [admins[0]!, admins[1]!, admins[0]!]) {
          const ctx = await context(identity.senderId);
          const operatorAuthority = expectDefined(
            prepareInternalGetReplyOptions(undefined, ctx)?.operatorAuthority,
            "linked-channel operator authority",
          );
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
        const reconnect = expectDefined(overlays[2], "same-requester reconnect overlay");
        const ownerAuthority = owner.operatorAuthority!;
        const steererAuthority = steerer.operatorAuthority!;
        expect(ownerAuthority.scopes).toEqual(steererAuthority.scopes);
        expect([ownerAuthority.gatewayAccessGrant, steererAuthority.gatewayAccessGrant]).toEqual([
          null,
          null,
        ]);
        const uiCapture = expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: createOperatorClient({
              profileId: admins[0]!.profile.id,
              scopes: [...ownerAuthority.scopes],
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
          const equivalent = difference === "equivalent" || difference === "roles-disabled";
          const policy = expect(ownerAuthority.rolePolicy);
          if (equivalent) {
            policy.toEqual(steererAuthority.rolePolicy);
          } else {
            policy.not.toEqual(steererAuthority.rolePolicy);
          }
          const steer = (toolAuthorityOverlay: typeof steerer) =>
            queueCurrentReplyRunMessage(run.run.sessionId, "Steering request", {
              isInboundUserMessage: true,
              toolAuthorityOverlay,
            });
          await expect(steer(steerer)).resolves.toEqual({
            status: "rejected",
            reason: "tool_authority_mismatch",
          });
          expect(queueMessage).not.toHaveBeenCalled();
          await expect(steer(reconnect)).resolves.toEqual({ status: "accepted" });
          expect(queueMessage).toHaveBeenCalledOnce();
          expect(ownerAuthority.rolePolicy).toEqual(uiCapture.authority.rolePolicy);
          if (difference === "roles-disabled") {
            expect([ownerAuthority.rolePolicy, steererAuthority.rolePolicy]).toEqual([
              undefined,
              undefined,
            ]);
          }
        } finally {
          operation.complete();
          uiCapture.release();
        }
      },
      difference === "roles-disabled" ? "identity-grant" : "role",
    );
  },
);

it("refreshes requester facts and rejects forged context", () =>
  withOperator(async ({ cfg, admin, admins, context, retire }) => {
    using reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const original = await context(admin.identity.senderId);
    expect(
      reads.mock.calls.filter(
        ([, command]) => command.type === "userProfiles.channelIdentity.resolve",
      ),
    ).toHaveLength(1);
    const stablePrompt = buildInboundMetaSystemPrompt(original, cfg);
    for (const sender of [admins[1]!.identity.senderId, "unlinked"]) {
      expect(buildInboundMetaSystemPrompt(await context(sender), cfg)).toBe(stablePrompt);
    }
    expect(stablePrompt).not.toContain("requester_profile");
    expect(buildInboundUserContextPrefix({ ...original })).toContain(admin.profile.id);
    expect(authorize(cfg, { ...original })).toMatchObject({
      senderIsOwner: true,
      isAuthorizedSender: true,
    });
    setDisplayName(admin.profile.id, "Current label");
    expect(buildInboundUserContextPrefix(await context(admin.identity.senderId))).toContain(
      '"display_name":"Current label"',
    );
    for (const forged of [
      await context(admin.identity.senderId, false),
      await context("unlinked"),
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

it.each(["role-scopes", "grant", "host"] as const)(
  "revokes admitted channel authority after an unpublished %s change",
  (change) =>
    withOperator(
      async ({ cfg, admin, context, retire }) => {
        const ctx = await context(admin.identity.senderId);
        expect(authorize(cfg, ctx).senderIsOwner).toBe(true);
        using prepared = prepareRun(cfg, ctx, `linked-admin-${change}`, false);
        const assertCurrent = resolveAdmittedRunActiveAssertion(await prepared.admit("embedded"));
        expect(assertCurrent).toBeTypeOf("function");
        expect(assertCurrent).not.toThrow();
        if (change === "host") {
          retire();
        } else if (change === "grant") {
          delete cfg.gateway!.auth!.identityScopes!["ada@example.test"];
        } else {
          cfg.gateway!.roles!.definitions.admin!.scopes = ["operator.read"];
        }
        expect(authorize(cfg, ctx).senderIsOwner).toBe(false);
        expect(assertCurrent).toThrow();
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
      const ctx = await context(admin.identity.senderId);
      expect(authorize(cfg, ctx).senderIsOwner).toBe(true);
      const run = prepareRun(cfg, ctx, `linked-admin-${change}`, false);
      const assertCurrent = resolveAdmittedRunActiveAssertion(await run.admit("embedded"));
      expect(assertCurrent).toBeTypeOf("function");
      expect(assertCurrent).not.toThrow();
      const admitted = await prepare();
      expect(admitted?.isCurrent(cfg)).toBe(true);
      const reference = admitted!.recoveryReference!;
      expect(reference).toBeDefined();
      if (change === "role-restore") {
        setUserProfileRole(admin.profile.id, "member");
        expect(authorize(cfg, ctx).senderIsOwner).toBe(false);
        expect(assertCurrent).toThrow();
        setUserProfileRole(admin.profile.id, "admin");
      } else if (change === "relink" || change === "reassign") {
        unlinkUserChannelIdentity(admin.profile.id, admin.identity);
        expect(authorize(cfg, ctx).senderIsOwner).toBe(false);
        expect(assertCurrent).toThrow();
        linkUserChannelIdentity(
          change === "relink" ? admin.profile.id : admins[1]!.profile.id,
          admin.identity,
        );
      } else if (change === "merge") {
        linkEmail("ada@example.test", admins[1]!.profile.id);
      } else if (change === "identity-scopes") {
        const original = structuredClone(cfg.gateway!.auth!);
        await activatePolicy({ auth: { ...original, identityScopes: undefined } });
        expect(authorize(cfg, ctx).senderIsOwner).toBe(false);
        expect(assertCurrent).toThrow();
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
      }
      expect(authorize(cfg, ctx).senderIsOwner).toBe(false);
      expect(assertCurrent).toThrow();
      expect(admitted?.isCurrent(cfg)).toBe(false);
      run.close();
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
    const { ingress, buildContext } = createHostIngressFixture("slack", cfg);
    const runtime = createPluginRuntimeMock({
      channel: {
        inbound: { ingress, buildContext },
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
          expect(prompt.includes("requester_profile is the verified linked requester")).toBe(
            linked,
          );
          const { senderIsOwner } = authorize(cfg, turn);
          expect(authorize(cfg, { ...turn }).isAuthorizedSender).toBe(true);
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

type Fixture = Parameters<Parameters<typeof withAdminIngress>[0]>[0];
const humanSessionKey = "agent:main:dashboard:human-created";
const spawnedSessionKey = "agent:main:dashboard:agent-created";
const revokedMessage = "Channel operator authority changed; send a new request.";
const agent = { type: "agent", id: "main" } as const;
const human = (id: string) => ({ type: "human", id }) as const;
const withSlack = (run: (fixture: Fixture) => Promise<void>) =>
  withAdminIngress(run, "role", "slack");
function autoClose<T extends { close: () => void }>(resource: T) {
  return { ...resource, [Symbol.dispose]: () => resource.close() };
}
function withOperatorModels(
  authority: Parameters<typeof bindOperatorModelExecution>[0],
  revoke: () => void,
) {
  const models = Array.from({ length: 2 }, () => bindOperatorModelExecution(authority, undefined));
  try {
    for (const model of models) {
      expect(model?.signal.aborted).toBe(false);
    }
    revoke();
    for (const model of models) {
      expect(model?.signal).toMatchObject({ aborted: true, reason: { message: revokedMessage } });
      expect(model?.signal.reason).toBeInstanceOf(CommandOwnerRevokedError);
    }
  } finally {
    for (const model of models) {
      model?.release();
    }
  }
}

function prepareRun(
  cfg: Fixture["cfg"],
  turn: MsgContext,
  runId = "channel-assignment",
  includeOperator = true,
) {
  return autoClose(
    prepareChannelRunAdmission({
      cfg,
      runId,
      agentId: "main",
      ingressKind: "channel",
      boundary: includeOperator ? turn.Provider! : "test.channel",
      assertSourceCurrent: captureCommandOwnerAssertion(turn),
      operatorAuthority: includeOperator ? authorityFor(turn) : undefined,
    }),
  );
}

async function prepareAssignment(fixture: Fixture, turn: MsgContext, nativeAgent = false) {
  const { cfg, state, gateway, admins } = fixture;
  const sessionKey = turn.SessionKey!;
  const scope = (key: string) => ({ agentId: "main", sessionKey: key, env: state.env });
  const session = (key: string, entry: Parameters<typeof upsertSessionEntryCore>[1]) =>
    upsertSessionEntryCore(scope(key), { updatedAt: 1, visibility: "shared", ...entry });
  await session(sessionKey, { sessionId: "channel-requester", createdActor: agent });
  await session(humanSessionKey, {
    sessionId: "human-created",
    createdVia: "operator",
    createdActor: { type: "human", source: "profile", id: admins[1]!.profile.id },
  });
  Object.assign(gateway, createSessionMutationTestContext(cfg));
  gateway.resolveGatewayContext = () => gateway;
  gateway.loadGatewayModelCatalogSnapshot = async () => ({
    agentId: "main",
    agentDir: state.agentDir("main"),
    workspaceDir: state.workspaceDir,
    config: cfg,
    catalogComplete: true,
    entries: [],
    routeVariants: [],
  });
  await initializeSessionReadContext(gateway);
  const prepared = prepareRun(cfg, turn);
  const admitted = await prepared.admit("embedded");
  const operatorAuthority = readAdmittedRunOperatorAuthority(admitted);
  const tools = (
    await resolveGatewayScopedTools({
      cfg,
      sessionKey,
      messageProvider: turn.Provider,
      surface: "loopback",
      senderIsOwner: resolveCommandAuthorization({ cfg, ctx: turn, commandAuthorized: true })
        .senderIsOwner,
      admittedRunContext: admitted,
    })
  ).tools;
  const run = <T>(action: () => Promise<T>) =>
    withPluginRuntimeGatewayRequestScope(
      {
        context: gateway,
        // Plugin calls retain a profileless client; native tools use the admitted binding.
        client: nativeAgent ? null : createSyntheticPluginRuntimeClient(),
        isWebchatConnect: () => false,
      },
      () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            gatewayContextResolver: () => gateway,
            operationalRunInstance: admitted.operationalRunInstance,
            operatorAuthority,
            receiptAuthority: resolveAdmittedRunActiveAssertion(admitted),
          },
          action,
        ),
    );
  const execute = (name: string, ...args: Parameters<(typeof tools)[number]["execute"]>) =>
    run(() => {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool).toBeDefined();
      return tool!.execute(...args);
    });
  const sessions = (action: string, params: Record<string, unknown> = {}) =>
    execute("sessions", action, { action, ...params });
  const assign = (target = humanSessionKey, ownerId = admins[0]!.profile.id) =>
    sessions("assign_owner", { sessionKey: target, ownerType: "human", ownerId });
  return {
    operatorAuthority,
    tools,
    run,
    assign,
    scope,
    execute,
    sessions,
    [Symbol.dispose]: () => prepared.close(),
  };
}

it("recovers an unknown channel owner through the canonical profile directory", () =>
  withAdminIngress(async (fixture) => {
    const requester = fixture.admins[0]!;
    syncGitHubIdentity({
      identity: { accountId: 42, login: "fixture-requester" },
      authenticationAlias: { kind: "email", email: "ada@example.test" },
    });
    const turn = await fixture.context(requester.identity.senderId);
    using assignment = await prepareAssignment(fixture, turn, true);
    await expect(assignment.assign(humanSessionKey, requester.identity.senderId)).rejects.toThrow(
      "Gateway profile ID",
    );
    expect(loadSessionEntry(assignment.scope(humanSessionKey))?.owner).toBeUndefined();
    const directory = await assignment.sessions("owner_profiles", { githubAccountIds: [42] });
    expect(directory.details).toEqual({
      profiles: [
        {
          id: requester.profile.id,
          displayName: "ada",
          githubIdentity: {
            login: "fixture-requester",
            profileUrl: "https://github.com/fixture-requester",
            avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
          },
        },
      ],
      githubProfiles: [{ accountId: 42, profileId: requester.profile.id }],
    });
    const unknown = await assignment.sessions("owner_profiles", { githubAccountIds: [999] });
    expect(unknown.details).toEqual({ profiles: [], githubProfiles: [] });
    expect((await assignment.assign(humanSessionKey, requester.profile.id)).details).toMatchObject({
      status: "updated",
      owner: human(requester.profile.id),
    });
    expect(loadSessionEntry(assignment.scope(humanSessionKey))?.owner?.actor).toEqual(
      human(requester.profile.id),
    );
  }));

it.each([
  { channel: "slack", role: "admin" },
  { channel: "discord", role: "member" },
] as const)(
  "assigns visible and newly created sessions to the linked $channel $role",
  ({ channel, role }) =>
    withAdminIngress(
      async (fixture) => {
        setUserProfileRole(fixture.admins[0]!.profile.id, role);
        const turn = await fixture.context(fixture.admins[0]!.identity.senderId);
        const metadata = JSON.parse(
          buildInboundUserContextPrefix(turn).match(/```json\n([\s\S]*?)\n```/)![1]!,
        );
        using assignment = await prepareAssignment(fixture, turn, channel === "discord");
        const { operatorAuthority, tools, execute, sessions, assign, run, scope } = assignment;
        const requester = human(metadata.requester_profile.id);
        const updated = { status: "updated", owner: human(fixture.admins[0]!.profile.id) };
        if (role === "member") {
          expect(operatorAuthority).toBeUndefined();
          const tool = tools.find((entry) => entry.name === "sessions")!;
          expect(tool.parameters).toHaveProperty(
            "properties.action.enum",
            expect.arrayContaining(["assign_owner"]),
          );
          for (const [action, params] of [
            ["patch", { label: "forbidden" }],
            ["owner_profiles", {}],
          ] as const) {
            await expect(sessions(action, params)).rejects.toThrow("Only assign_owner");
          }
        }
        if (role === "admin") {
          expect((await assign(humanSessionKey, requester.id)).details).toMatchObject(updated);
        }
        await run(() =>
          callInProcessGatewayToolWithCreation(
            "sessions.create",
            {
              key: spawnedSessionKey,
              agentId: "main",
              visibility: "shared",
              parentSessionKey: turn.SessionKey,
              spawnDepth: 1,
            },
            {
              via: "spawn",
              actor: agent,
              requesterSessionKey: turn.SessionKey,
              inheritedToolPolicy: { version: 1, allow: [], deny: [] },
            },
          ),
        );
        expect(loadSessionEntry(scope(spawnedSessionKey))).toMatchObject({
          createdVia: "spawn",
          createdActor: agent,
          owner: { actor: role === "admin" ? requester : agent },
        });
        expect((await assign(spawnedSessionKey, requester.id)).details).toMatchObject(updated);
        const listed = await execute("sessions_list", "read-owner", {
          search: spawnedSessionKey,
        });
        expect(listed.details).toMatchObject({
          sessions: [{ key: spawnedSessionKey, createdActor: agent, owner: { actor: requester } }],
        });
        for (const key of role === "admin"
          ? [humanSessionKey, spawnedSessionKey]
          : [spawnedSessionKey]) {
          expect(loadSessionEntry(scope(key))?.owner?.actor).toEqual(requester);
        }
      },
      "role",
      channel,
    ),
);

it.each(["unlink", "role", "lifecycle", "gateway", "database", "stale-copy"] as const)(
  "rejects a retained Slack assignment after its %s authority changes",
  (change) =>
    withSlack(async (fixture) => {
      const admin = fixture.admins[0]!;
      const original = await fixture.context(admin.identity.senderId);
      const turn = change === "stale-copy" ? { ...original } : original;
      using assignment = await prepareAssignment(fixture, turn);
      expect(assignment.operatorAuthority?.profileId).toBe(admin.profile.id);
      const changes = {
        unlink: () => unlinkUserChannelIdentity(admin.profile.id, admin.identity),
        role: () => setUserProfileRole(admin.profile.id, "member"),
        lifecycle: fixture.retire,
        "stale-copy": fixture.retire,
        gateway: fixture.replaceGatewayContext,
        database: () =>
          closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(fixture.state.env)),
      };
      await changes[change]();
      await expect(assignment.assign()).rejects.toThrow(revokedMessage);
      expect(loadSessionEntry(assignment.scope(humanSessionKey))?.owner).toBeUndefined();
    }),
);

it.each(["unlink", "role"] as const)(
  "cancels an active Slack model execution when its %s authority changes",
  (change) =>
    withSlack(async ({ cfg, admins, context }) => {
      const admin = admins[0]!;
      const turn = await context(admin.identity.senderId);
      using prepared = prepareRun(cfg, turn, "slack-model-cancellation");
      const admitted = await prepared.admit("embedded");
      const authority = readAdmittedRunOperatorAuthority(admitted);
      withOperatorModels(authority, () => {
        if (change === "unlink") {
          unlinkUserChannelIdentity(admin.profile.id, admin.identity);
        } else {
          setUserProfileRole(admin.profile.id, "member");
        }
      });
    }),
);

it.each([
  "asserted",
  "unlinked",
  "member",
  "cloned",
  "configured-owner",
  "configured-owner-linked",
] as const)("does not give a %s Slack sender an operator principal", async (kind) => {
  await withSlack(async (fixture) => {
    const admin = fixture.admins[0]!;
    if (kind === "member") {
      setUserProfileRole(admin.profile.id, "member");
    }
    const configuredOwner = kind === "configured-owner" || kind === "configured-owner-linked";
    if (configuredOwner) {
      fixture.cfg.commands!.ownerAllowFrom = [`slack:${admin.identity.senderId}`];
      if (kind === "configured-owner") {
        unlinkUserChannelIdentity(admin.profile.id, admin.identity);
      }
    }
    const original = await fixture.context(
      kind === "unlinked" ? "unlinked" : admin.identity.senderId,
      kind !== "asserted",
    );
    const turn = kind === "cloned" ? structuredClone(original) : original;
    using assignment = await prepareAssignment(fixture, turn);
    expect(assignment.operatorAuthority).toBeUndefined();
    await expect(
      assignment.run(() =>
        callInProcessGatewayTool("sessions.assignOwner", {
          key: humanSessionKey,
          owner: human(admin.profile.id),
        }),
      ),
    ).rejects.toThrow(/was not found/);
    expect(loadSessionEntry(assignment.scope(humanSessionKey))?.owner).toBeUndefined();
  });
});
