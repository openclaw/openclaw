import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  participationAllowsTool,
  type ParticipationCeiling,
} from "../agents/participation-ceiling.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { prepareSessionEventTargetForHost } from "../auto-reply/reply/session-event-target.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  addSessionMember,
  removeSessionMember,
  setSessionMemberAccess,
} from "../config/sessions/session-sharing-store.native.js";
import { createTestCronOperatorSource } from "../cron/execution-context.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { authorizeAgentTurnSession } from "./agent-turn/agent-turn-source-admission.js";
import { captureCronJobTurnTarget } from "./cron-job-turn-target.js";
import { readParticipantPublicationAuthority } from "./github-publication-participation.js";
import { bindInProcessSessionRun } from "./in-process-session-run.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { prepareGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { normalizeGatewayOperatorRecoverySnapshot } from "./operator-run-recovery-source.codec.js";
import { pairedOperator, recoveryFixture } from "./operator-run-recovery.test-support.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createCronJob } from "./server-methods/cron.validation.test-support.js";
import { authorizeGatewayMethod } from "./server-methods/method-authorization.js";
import { resolveInProcessGatewayDispatch } from "./server-plugin-in-process-authority.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { prepareSessionDelegatedOperatorAuthority } from "./session-delegated-operator-source.js";
import {
  prepareSessionSystemTurnAuthority,
  resolveSessionMutationAuthorizationAsync,
} from "./session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

function snapshotFor(entry: Awaited<ReturnType<typeof readSessionEntryReadOnlyInWorker>>) {
  const source = entry?.delegatedOperatorSource;
  if (source?.kind !== "gateway") {
    throw new Error("missing gateway source");
  }
  return source.snapshot;
}

async function fixture(stateDir: string, tools = ["read", "write"]) {
  const cfg = rolePolicyConfig();
  const role = cfg.gateway!.roles!.definitions.invited!;
  role.sessions.maxInvitedAccess = "send";
  role.sessions.invitedTools = tools;
  role.scopes = ["operator.sessions.read"];
  role.sandbox = "required";
  setRuntimeConfigSnapshot(cfg);
  const client = roleClient("invited", "child-participant");
  client.connect.scopes = [...role.scopes];
  client.internal = { authenticatedOperator: true };
  const profileId = client.authenticatedUserProfile!.profileId;
  const source = { agentId: "main", sessionKey: "agent:main:participation-root" };
  const root = "/synthetic/participation-root";
  await upsertSessionEntryCore(source, {
    sessionId: "root-id",
    lifecycleRevision: "root-life",
    updatedAt: 1,
    visibility: "read-only",
    permissionMode: "full",
    sessionRoot: root,
    createdActor: { type: "human", source: "profile", id: "original-creator" },
  });
  addSessionMember(source, { identityId: profileId, addedBy: "original-creator", access: "send" });
  const ceiling: ParticipationCeiling = {
    kind: "send",
    profileId,
    sessionKey: source.sessionKey,
    permission: "guarded",
    tools,
    source: {
      agentId: "main",
      sessionId: "root-id",
      lifecycleRevision: "root-life",
      creatorProfileId: "original-creator",
      root,
    },
  };
  const recovery = await recoveryFixture(stateDir, profileId, {
    config: cfg,
    device: pairedOperator(),
    scopes: role.scopes,
  });
  const snapshot = expectDefined(
    normalizeGatewayOperatorRecoverySnapshot({
      ...recovery.snapshot,
      version: 2,
      participationCeiling: ceiling,
    }),
    "child source",
  );
  const child = { agentId: "main", sessionKey: "agent:main:subagent:participation-child" };
  await upsertSessionEntryCore(child, {
    sessionId: "child-id",
    updatedAt: 1,
    spawnedBy: source.sessionKey,
    parentSessionKey: source.sessionKey,
    delegatedOperatorSource: { kind: "gateway", snapshot },
    createdActor: { type: "human", source: "profile", id: profileId },
  });
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  context.resolveGatewayContext = () => context;
  const entry = await readSessionEntryReadOnlyInWorker(child);
  const prepare = () =>
    prepareSessionDelegatedOperatorAuthority({ context, agentId: "main", entry });
  return { cfg, role, client, profileId, source, child, ceiling, context, entry, prepare };
}

function withFixture(
  run: (f: Awaited<ReturnType<typeof fixture>>, stateDir: string) => Promise<void>,
  tools?: string[],
) {
  return withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async ({ stateDir }) => run(await fixture(stateDir, tools), stateDir),
  );
}

it("restores every child turn from its original invitation and accepts reinvitation", async () => {
  await withFixture(async (f) => {
    const first = (await f.prepare())!;
    expect(first.authority.scopes).toEqual(["operator.sessions.read"]);
    expect(first.authority.participationCeiling).toEqual(f.ceiling);
    first.release();
    const second = (await f.prepare())!;
    setSessionMemberAccess(f.source, { identityId: f.profileId, access: "read" });
    await expect(f.prepare()).rejects.toThrow();
    second.release();
    removeSessionMember(f.source, f.profileId);
    addSessionMember(f.source, {
      identityId: f.profileId,
      addedBy: "original-creator",
      access: "send",
    });
    const reinvited = (await f.prepare())!;
    expect(participationAllowsTool(reinvited.authority.participationCeiling!, "read")).toBe(true);
    expect(reinvited.authority.participationCeiling).toEqual(first.authority.participationCeiling);
    reinvited.release();
    const restart = (await prepareSessionSystemTurnAuthority({
      context: f.context,
      ...f.child,
      sessionId: "child-id",
    }))!;
    expect(restart.authority.profileId).toBe(f.profileId);
    expect(restart.authority.participationCeiling?.source).toEqual(f.ceiling.source);
    restart.release();
    expect(
      (await readSessionEntryReadOnlyInWorker(f.source))?.delegatedOperatorSource,
    ).toBeUndefined();
  });
});

it("refuses missing child envelopes and changed original agent, incarnation, creator, or root", async () => {
  await withFixture(async (f) => {
    await expect(
      prepareSessionDelegatedOperatorAuthority({
        context: f.context,
        agentId: "main",
        entry: { ...f.entry!, delegatedOperatorSource: { kind: "unavailable" } },
      }),
    ).rejects.toThrow("original participant source");
    for (const patch of [
      { agentId: "other" },
      { sessionId: "replacement" },
      { lifecycleRevision: "replacement" },
      { creatorProfileId: "replacement" },
      { root: "/outside" },
    ]) {
      await expect(
        prepareSessionDelegatedOperatorAuthority({
          context: f.context,
          agentId: "main",
          entry: {
            ...f.entry!,
            delegatedOperatorSource: {
              kind: "gateway",
              snapshot: expectDefined(
                normalizeGatewayOperatorRecoverySnapshot({
                  ...snapshotFor(f.entry),
                  version: 2,
                  participationCeiling: {
                    ...f.ceiling,
                    sessionKey: patch.agentId
                      ? `agent:${patch.agentId}:participation-root`
                      : f.ceiling.sessionKey,
                    source: { ...f.ceiling.source!, ...patch },
                  },
                }),
                "patched source",
              ),
            },
          },
        }),
      ).rejects.toThrow();
    }
  });
});

it("admits only a host-bound child and keeps its started run after membership downgrade", async () => {
  await withFixture(async (f) => {
    f.role.sandbox = "required";
    setRuntimeConfigSnapshot(f.cfg);
    const request = bindInProcessSessionRun(
      { sessionKey: f.child.sessionKey, idempotencyKey: "child-run" },
      {
        sessionKey: f.child.sessionKey,
        sessionId: "child-id",
        lifecycleRevision: null,
        runId: "child-run",
      },
    );
    const registry = createGatewayMethodRegistry([]);
    expect(
      authorizeGatewayMethod(
        "agent",
        { ...f.client, internal: { syntheticClient: true } },
        { ...request },
        registry,
        f.context,
      ).error,
    ).not.toBeNull();
    const captured = (await f.prepare())!;
    using _ = { [Symbol.dispose]: captured.release };
    f.client.internal = { ...f.client.internal, operatorRunAuthority: captured.authority };
    const dispatch = authorizeGatewayMethod("agent", f.client, request, registry, f.context);
    expect(dispatch.error).toBeNull();
    const result = await resolveSessionMutationAuthorizationAsync({
      client: f.client,
      context: f.context,
      method: "agent",
      requestParams: request,
      sessionScope: dispatch.sessionScope,
    });
    expect(result.error).toBeNull();
    expect(result.authorization?.participationCeiling?.source).toEqual(f.ceiling.source);
    const run = result.authorization?.retainForRun?.();
    result.authorization?.release?.();
    const invocation = expectDefined(
      await prepareGatewayOperatorRunAuthority({
        client: f.client,
        context: f.context,
        invocationAuthority: run,
      }),
      "participant run authority",
    );
    onTestFinished(invocation.release);
    expect(run?.participationAuthority?.scopes).toEqual(["operator.sessions.read"]);
    run?.assertCurrent();
    await expect(
      withPluginRuntimeGatewayRequestScope(
        { context: f.context, isWebchatConnect: () => false },
        () =>
          authorizeAgentTurnSession({
            cfg: f.cfg,
            principal: f.client,
            ...f.child,
            entry: f.entry,
          }),
      ),
    ).resolves.toBeUndefined();
    setSessionMemberAccess(f.source, { identityId: f.profileId, access: "read" });
    expect(invocation.authority.signal?.aborted).toBe(false);
    expect(() => run!.assertCurrent()).not.toThrow();
    await expect(f.prepare()).rejects.toThrow();
  });
});

it.each(["captured", "unavailable"] as const)(
  "keeps the interrupted participant's %s operator source during restart",
  async (sourceKind) => {
    await withFixture(async (f, stateDir) => {
      f.cfg.agents = { defaults: { model: "fixture/a" } };
      f.role.modelPolicy = { allow: ["fixture/a"] };
      setRuntimeConfigSnapshot(f.cfg);
      const recovery = await recoveryFixture(stateDir, f.profileId, {
        config: f.cfg,
        device: pairedOperator(),
        scopes: f.role.scopes,
      });
      f.role.modelPolicy = { allow: ["fixture/a", "fixture/b"] };
      setRuntimeConfigSnapshot(f.cfg);
      const preparation = prepareSessionSystemTurnAuthority({
        context: recovery.context,
        ...f.child,
        sessionId: f.entry!.sessionId,
        preserveRecordedSource: true,
        operatorSource:
          sourceKind === "captured"
            ? {
                kind: "gateway",
                snapshot: expectDefined(
                  normalizeGatewayOperatorRecoverySnapshot({
                    ...recovery.snapshot,
                    version: 2,
                    participationCeiling: f.ceiling,
                  }),
                  "participant source",
                ),
              }
            : { kind: "unavailable" },
      });
      if (sourceKind === "unavailable") {
        await expect(preparation.then((result) => result?.release())).rejects.toThrow(
          "cannot be recovered",
        );
        return;
      }
      const restored = (await preparation)!;
      try {
        expect(restored.authority.participationCeiling).toEqual(f.ceiling);
        expect(restored.authority.modelPolicy?.allows({ provider: "fixture", model: "a" })).toBe(
          true,
        );
        expect(restored.authority.modelPolicy?.allows({ provider: "fixture", model: "b" })).toBe(
          false,
        );
      } finally {
        restored.release();
      }
    });
  },
);

it("binds participant publication to the current native child without scope or owner-action grants", async () => {
  await withFixture(
    async (f) => {
      const source = (await f.prepare())!;
      using _ = { [Symbol.dispose]: source.release };
      const client = {
        ...f.client,
        internal: { syntheticClient: true as const, operatorRunAuthority: source.authority },
      };
      const registry = createGatewayMethodRegistry([]);
      const request = { ...f.child, idempotencyKey: "participant-publication" };
      expect(
        authorizeGatewayMethod("sessions.github.publish", client, request, registry, f.context)
          .error,
      ).not.toBeNull();
      await withGatewayToolCallerIdentity(
        { ...f.child, operatorAuthority: source.authority },
        async () => {
          const dispatch = authorizeGatewayMethod(
            "sessions.github.publish",
            client,
            request,
            registry,
            f.context,
          );
          expect(dispatch).toEqual({ error: null, participationRequired: true });
          withPluginRuntimeGatewayRequestScope(
            { context: f.context, isWebchatConnect: () => false },
            () => {
              const routed = resolveInProcessGatewayDispatch("sessions.github.publish", request, {
                forceSyntheticClient: true,
                syntheticScopeMode: "minimum",
              });
              expect(routed.client.connect.scopes).toEqual(["operator.sessions.read"]);
              expect(routed.client.internal?.operatorRunAuthority?.profileId).toBe(f.profileId);
            },
          );
          const admitted = await resolveSessionMutationAuthorizationAsync({
            client,
            context: f.context,
            method: "sessions.github.publish",
            requestParams: request,
            participationRequired: dispatch.participationRequired,
          });
          expect(admitted.error).toBeNull();
          admitted.authorization?.assertCurrent();
          admitted.authorization?.release?.();
          expect(client.connect.scopes).toEqual(["operator.sessions.read"]);
          for (const action of ["inspect", "merge", "close"]) {
            expect(() =>
              readParticipantPublicationAuthority("sessions.github.action", { ...request, action }),
            ).toThrow("Participating GitHub");
          }
          for (const invalid of [
            { ...request, sessionKey: f.source.sessionKey },
            { ...request, agentId: "other" },
            { ...request, publishingSessionKey: f.source.sessionKey },
          ]) {
            expect(() =>
              readParticipantPublicationAuthority("sessions.github.publish", invalid),
            ).toThrow("Participating GitHub");
          }
        },
      );
    },
    ["read", "github_publish"],
  );
});

it.each(["sessions.patch", "sessions.abort", "chat.abort"])(
  "keeps participant tool %s under the invited session's management policy",
  async (method) =>
    withFixture(async (f) => {
      f.role.scopes.push("operator.write");
      f.client.connect.scopes = [...f.role.scopes];
      setRuntimeConfigSnapshot(f.cfg);
      const restored = (await f.prepare())!;
      onTestFinished(restored.release);
      const authority = createAdmittedRunOperatorAuthority({
        ...restored.authority,
        scopes: f.role.scopes,
      });
      for (const operatorRunAuthority of [undefined, authority]) {
        const result = await resolveSessionMutationAuthorizationAsync({
          context: f.context,
          client: { ...f.client, internal: { ...f.client.internal, operatorRunAuthority } },
          method,
          requestParams: { sessionKey: f.source.sessionKey, key: f.source.sessionKey },
        });
        try {
          expect(result.error ?? result.authorization?.participationCeiling).toBeTruthy();
        } finally {
          result.authorization?.release?.();
        }
      }
    }),
);

it.each(["read", "suggest"] as const)(
  "refuses detached repair at work start after participant becomes %s",
  async (access) => {
    await withFixture(async (f) => {
      setSessionMemberAccess(f.source, { identityId: f.profileId, access });
      const stored = createTestCronOperatorSource(f.source.sessionKey);
      stored.source.snapshot = snapshotFor(f.entry);
      const job = { ...createCronJob({ sessionKey: f.source.sessionKey }), operatorSource: stored };
      const context = createContext();
      context.getRuntimeConfig = () => f.cfg;
      context.resolveGatewayContext = () => context;
      context.cron = { ...context.cron, getJob: () => job };
      const target = await captureCronJobTurnTarget({ job, ...f.source, context });
      await expect(prepareSessionEventTargetForHost(target)).rejects.toThrow();
    });
  },
);
