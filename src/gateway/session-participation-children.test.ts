import { expect, it } from "vitest";
import type { ParticipationCeiling } from "../agents/participation-ceiling.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  addSessionMember,
  removeSessionMember,
  setSessionMemberAccess,
} from "../config/sessions/session-sharing-store.native.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { authorizeAgentTurnSession } from "./agent-turn/agent-turn-source-admission.js";
import { readParticipantPublicationAuthority } from "./github-publication-participation.js";
import { bindInProcessSessionRun } from "./in-process-session-run.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { pairedOperator, recoveryFixture } from "./operator-run-recovery.test-support.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { authorizeGatewayMethod } from "./server-methods/method-authorization.js";
import { resolveInProcessGatewayDispatch } from "./server-plugin-in-process-authority.js";
import { revokeSessionParticipation } from "./session-participation-lifetime.js";
import { prepareSessionParticipationRun } from "./session-principal-run-authority.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

async function fixture(tools = ["read", "write"]) {
  const cfg = rolePolicyConfig();
  const role = cfg.gateway!.roles!.definitions.invited!;
  role.sessions.maxInvitedAccess = "send";
  role.sessions.invitedTools = tools;
  role.scopes = ["operator.sessions.read"];
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
  const child = { agentId: "main", sessionKey: "agent:main:subagent:participation-child" };
  await upsertSessionEntryCore(child, {
    sessionId: "child-id",
    updatedAt: 1,
    spawnedBy: source.sessionKey,
    parentSessionKey: source.sessionKey,
    inheritedToolPolicySource: "participant",
    participationCeiling: ceiling,
    createdActor: { type: "human", source: "profile", id: profileId },
  });
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const entry = await readSessionEntryReadOnlyInWorker(child);
  const prepare = () => prepareSessionParticipationRun({ context, agentId: "main", entry });
  return { cfg, role, client, profileId, source, child, ceiling, context, entry, prepare };
}

it("restores every child turn from its original invitation, narrows current policy, and accepts reinvitation", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const f = await fixture();
    const first = (await f.prepare())!;
    expect(first.authority.scopes).toEqual(["operator.sessions.read"]);
    expect(first.authority.participationCeiling).toEqual(f.ceiling);
    first.release();
    f.role.sessions.invitedTools = ["read"];
    f.role.sessions.invitedPermission = "read-only";
    setRuntimeConfigSnapshot(f.cfg);
    const second = (await f.prepare())!;
    expect(second.authority.participationCeiling).toMatchObject({
      tools: ["read"],
      permission: "read-only",
      source: f.ceiling.source,
    });
    setSessionMemberAccess(f.source, { identityId: f.profileId, access: "read" });
    revokeSessionParticipation({ ...f.source, profileId: f.profileId, sessionId: "root-id" });
    expect(second.authority.signal?.aborted).toBe(true);
    expect(() => second.authority.assertCurrent()).toThrow();
    await expect(f.prepare()).rejects.toThrow();
    second.release();
    removeSessionMember(f.source, f.profileId);
    addSessionMember(f.source, {
      identityId: f.profileId,
      addedBy: "original-creator",
      access: "send",
    });
    const reinvited = (await f.prepare())!;
    expect(reinvited.authority.participationCeiling?.tools).toEqual(["read"]);
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
      (await readSessionEntryReadOnlyInWorker(f.source))?.participationCeiling,
    ).toBeUndefined();
  });
});

it("refuses missing child envelopes and changed original agent, incarnation, creator, or root", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const f = await fixture();
    await expect(
      prepareSessionParticipationRun({
        context: f.context,
        agentId: "main",
        entry: { ...f.entry!, participationCeiling: undefined },
      }),
    ).rejects.toThrow("missing");
    for (const patch of [
      { agentId: "other" },
      { sessionId: "replacement" },
      { lifecycleRevision: "replacement" },
      { creatorProfileId: "replacement" },
      { root: "/outside" },
    ]) {
      await expect(
        prepareSessionParticipationRun({
          context: f.context,
          agentId: "main",
          entry: {
            ...f.entry!,
            participationCeiling: { ...f.ceiling, source: { ...f.ceiling.source!, ...patch } },
          },
        }),
      ).rejects.toThrow();
    }
  });
});

it("admits only an exact host-bound child launch, keeping generic agent unavailable", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const f = await fixture();
    f.role.sandbox = "required";
    setRuntimeConfigSnapshot(f.cfg);
    const request = bindInProcessSessionRun(
      { sessionKey: f.child.sessionKey, idempotencyKey: "child-run" },
      {
        sessionKey: f.child.sessionKey,
        sessionId: "child-id",
        lifecycleRevision: null,
        runId: "child-run",
        participationCeiling: f.ceiling,
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
    expect(run?.participationAuthority?.scopes).toEqual(["operator.sessions.read"]);
    run?.assertCurrent();
    run?.release();
    await expect(
      withPluginRuntimeGatewayRequestScope(
        { context: f.context, isWebchatConnect: () => false },
        () =>
          authorizeAgentTurnSession({
            cfg: f.cfg,
            principal: f.client,
            ...f.child,
            entry: f.entry,
            participationCeiling: f.ceiling,
          }),
      ),
    ).resolves.toBeUndefined();
  });
});

it.each(["captured", "unavailable"] as const)(
  "keeps the interrupted participant's %s operator source during restart",
  async (sourceKind) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async ({ stateDir }) => {
        const f = await fixture();
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
              ? { kind: "gateway", snapshot: recovery.snapshot }
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
      },
    );
  },
);

it("binds participant publication to the current native child without scope or owner-action grants", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const f = await fixture(["read", "github_publish"]);
    const source = (await f.prepare())!;
    using _ = { [Symbol.dispose]: source.release };
    const client = {
      ...f.client,
      internal: { syntheticClient: true as const, operatorRunAuthority: source.authority },
    };
    const registry = createGatewayMethodRegistry([]);
    const request = { ...f.child, idempotencyKey: "participant-publication" };
    expect(
      authorizeGatewayMethod("sessions.github.publish", client, request, registry, f.context).error,
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
        setSessionMemberAccess(f.source, { identityId: f.profileId, access: "read" });
        expect(() =>
          readParticipantPublicationAuthority("sessions.github.publish", request),
        ).toThrow();
      },
    );
  });
});
