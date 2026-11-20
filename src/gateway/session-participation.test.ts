import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  setSessionMemberAccess,
} from "../config/sessions/session-sharing-store.native.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { authorizeGatewayMethod } from "./server-methods/method-authorization.js";
import { sessionMutationTargetFields } from "./session-method-policy.js";
import { revokeSessionParticipation } from "./session-participation-lifetime.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

it("admits only bounded methods for a send invitation with read scope", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    const guestRole = cfg.gateway!.roles!.definitions.invited!;
    guestRole.sessions.maxInvitedAccess = "send";
    guestRole.scopes = ["operator.sessions.read", "operator.read", "operator.sessions.write"];
    setRuntimeConfigSnapshot(cfg);
    const client = roleClient("invited", "participation");
    client.internal = { authenticatedOperator: true };
    const profileId = client.authenticatedUserProfile!.profileId;
    const scope = { agentId: "main", sessionKey: "agent:main:participation" };
    await upsertSessionEntryCore(scope, {
      sessionId: "participation-id",
      updatedAt: 1,
      visibility: "read-only",
      permissionMode: "workspace",
      createdActor: { type: "human", source: "profile", id: "creator" },
    });
    await addSessionMember(scope, { identityId: profileId, addedBy: "creator", access: "read" });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const registry = createGatewayMethodRegistry([]);
    const methods = [
      "chat.send",
      "chat.abort",
      "session.typing",
      "sessions.patch",
      "agent",
      "send",
      "chat.steerNow",
      "sessions.send",
      "sessions.steer",
      "sessions.abort",
      "sessions.create",
      "sessions.fork",
      "sessions.patchMany",
      "sessions.reset",
      "sessions.delete",
      "session.members.add",
      "session.members.remove",
      "session.members.setAccess",
      "tools.invoke",
      "node.invoke",
      "exec.approval.resolve",
      "question.resolve",
      "plugins.action",
      "unknown.method",
    ];
    for (const scopes of [
      [],
      ["operator.sessions.read"],
      ["operator.read"],
      ["operator.sessions.write"],
      ["operator.sessions.read", "operator.sessions.write"],
    ]) {
      client.connect.scopes = scopes;
      for (const access of ["read", "suggest", "send"] as const) {
        await setSessionMemberAccess(scope, { identityId: profileId, access });
        for (const method of methods) {
          const params =
            method === "sessions.patch"
              ? { key: scope.sessionKey, permissionMode: "guarded" }
              : method === "sessions.patchMany"
                ? { targets: [{ key: scope.sessionKey }], patch: { label: "blocked" } }
                : { [sessionMutationTargetFields(method)[0] ?? "sessionKey"]: scope.sessionKey };
          const dispatch = authorizeGatewayMethod(method, client, params, registry, context);
          let allowed = !dispatch.error;
          if (allowed) {
            const result = await resolveSessionMutationAuthorizationAsync({
              client,
              context,
              method,
              requestParams: params,
              participationRequired: dispatch.participationRequired,
              sessionScope: dispatch.sessionScope,
            });
            // Other own-session methods retain their handler-owned checks; they do not
            // receive an invitation grant merely by passing the method scope router.
            allowed =
              result.error === null && result.authorization?.participationCeiling !== undefined;
            if (allowed)
              expect(
                result.authorization?.participationCeiling,
                `${scopes}/${access}/${method}`,
              ).toEqual({
                kind: "send",
                profileId,
                sessionKey: scope.sessionKey,
              });
            result.authorization?.release?.();
          }
          expect(allowed, `${scopes}/${access}/${method}`).toBe(
            scopes.length > 0 && access === "send" && methods.indexOf(method) < 4,
          );
        }
      }
    }
    client.connect.scopes = ["operator.sessions.read"];
    for (const patch of [
      { permissionMode: null },
      { permissionMode: "full" },
      { permissionMode: "guarded", label: "smuggled" },
      { permissionMode: "guarded", archived: false },
    ]) {
      expect(
        authorizeGatewayMethod(
          "sessions.patch",
          client,
          { key: scope.sessionKey, ...patch },
          registry,
          context,
        ).error,
      ).not.toBeNull();
    }
    for (const sessionKey of ["agent:main:missing", "agent:main:incognito:missing"]) {
      const result = await resolveSessionMutationAuthorizationAsync({
        client,
        context,
        method: "chat.send",
        requestParams: { sessionKey },
        participationRequired: true,
      });
      expect(result.error).not.toBeNull();
      result.authorization?.release?.();
    }
    const original = await resolveSessionMutationAuthorizationAsync({
      client,
      context,
      method: "chat.send",
      requestParams: scope,
      participationRequired: true,
    });
    const lifetime = original.authorization?.retainForRun?.();
    original.authorization?.release?.();
    expect(lifetime).toBeDefined();
    const target = {
      profileId,
      agentId: "main",
      sessionKey: scope.sessionKey,
      sessionId: "participation-id",
    };
    for (const sibling of [
      { ...target, sessionId: "old" },
      { ...target, profileId: "other" },
      { ...target, agentId: "other" },
      { ...target, sessionKey: "agent:main:sibling" },
    ]) {
      revokeSessionParticipation(sibling);
      expect(lifetime?.signal?.aborted).toBe(false);
    }
    // The next effect is refused permanently even if fresh membership again permits a new input.
    revokeSessionParticipation(target);
    expect(lifetime?.signal?.aborted).toBe(true);
    expect(() => lifetime?.assertCurrent()).toThrow();
    const successor = await resolveSessionMutationAuthorizationAsync({
      client,
      context,
      method: "chat.send",
      requestParams: scope,
      participationRequired: true,
    });
    expect(successor.error).toBeNull();
    expect(successor.authorization?.participationSignal?.aborted).toBe(false);
    expect(() => lifetime?.assertCurrent()).toThrow();
    lifetime?.release();
    successor.authorization?.release?.();
    delete guestRole.sessions.maxInvitedAccess;
    const ordinary = await resolveSessionMutationAuthorizationAsync({
      client,
      context,
      method: "chat.send",
      requestParams: scope,
      participationRequired: true,
    });
    expect(ordinary.error).not.toBeNull();
    ordinary.authorization?.release?.();
  });
});
