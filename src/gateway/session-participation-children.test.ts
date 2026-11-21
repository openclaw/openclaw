import { expect, it } from "vitest";
import type { ParticipationCeiling } from "../agents/participation-ceiling.js";
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
import { bindInProcessSessionRun } from "./in-process-session-run.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { authorizeGatewayMethod } from "./server-methods/method-authorization.js";
import { revokeSessionParticipation } from "./session-participation-lifetime.js";
import { prepareSessionParticipationRun } from "./session-principal-run-authority.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

async function fixture() {
  const cfg = rolePolicyConfig();
  const role = cfg.gateway!.roles!.definitions.invited!;
  role.sessions.maxInvitedAccess = "send";
  role.sessions.invitedTools = ["read", "write"];
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
    tools: ["read", "write"],
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
