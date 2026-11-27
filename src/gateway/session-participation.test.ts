import { expect, it } from "vitest";
import { DEFAULT_PARTICIPATION_TOOLS } from "../agents/participation-ceiling.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
  setSessionMemberAccess,
} from "../config/sessions/session-sharing-store.native.js";
import { prepareSessionSourceAuthority } from "../config/sessions/session-source-authority.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { resolveSandboxedSessionCreation } from "./operator-session-run.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { authorizeGatewayMethod } from "./server-methods/method-authorization.js";
import { sessionMutationTargetFields } from "./session-method-policy.js";
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
    addSessionMember(scope, { identityId: profileId, addedBy: "creator", access: "read" });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const registry = createGatewayMethodRegistry([]);
    const methods = [
      "chat.send",
      "chat.abort",
      "session.typing",
      "sessions.patch",
      "sessions.github.publish",
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
        setSessionMemberAccess(scope, { identityId: profileId, access });
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
            if (allowed) {
              expect(
                result.authorization?.participationCeiling,
                `${scopes.join(",")}/${access}/${method}`,
              ).toEqual({
                kind: "send",
                profileId,
                sessionKey: scope.sessionKey,
                tools: DEFAULT_PARTICIPATION_TOOLS,
                permission: "workspace",
              });
            }
            result.authorization?.release?.();
          }
          expect(allowed, `${scopes.join(",")}/${access}/${method}`).toBe(
            scopes.length > 0 &&
              access === "send" &&
              methods.indexOf(method) < 5 &&
              // Publication is admitted only while github_publish is a default participant tool.
              (method !== "sessions.github.publish" ||
                DEFAULT_PARTICIPATION_TOOLS.includes("github_publish")),
          );
        }
      }
    }
    removeSessionMember(scope, profileId);
    client.connect.scopes = ["operator.sessions.read"];
    const absent = await resolveSessionMutationAuthorizationAsync({
      client,
      context,
      method: "chat.send",
      requestParams: scope,
      participationRequired: true,
    });
    expect(absent.error).not.toBeNull();
    absent.authorization?.release?.();
    addSessionMember(scope, { identityId: profileId, addedBy: "creator", access: "send" });
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
    for (const invitedTools of [[], ["read"], ["read", "message", "exec"]]) {
      guestRole.sessions.invitedTools = invitedTools;
      const result = await resolveSessionMutationAuthorizationAsync({
        client,
        context,
        method: "chat.send",
        requestParams: scope,
        participationRequired: true,
      });
      expect(result.error).toBeNull();
      expect(result.authorization?.participationCeiling?.tools).toEqual(invitedTools);
      // Configuration mutation after admission cannot change the captured input ceiling.
      invitedTools.push("sessions_list");
      expect(result.authorization?.participationCeiling?.tools).not.toContain("sessions_list");
      result.authorization?.release?.();
    }
    delete guestRole.sessions.invitedTools;
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

it("preserves invitation levels in prepared writer assertions without granting suggestion turns", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    const role = cfg.gateway!.roles!.definitions.invited!;
    role.scopes = ["operator.sessions.read"];
    setRuntimeConfigSnapshot(cfg);
    const client = roleClient("invited", "prepared-participant");
    client.connect.scopes = role.scopes;
    client.internal = { authenticatedOperator: true };
    const scope = { agentId: "main", sessionKey: "agent:main:prepared-participation" };
    await upsertSessionEntryCore(scope, {
      sessionId: "prepared-participation-id",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: "creator" },
    });
    const profileId = client.authenticatedUserProfile!.profileId;
    addSessionMember(scope, { identityId: profileId, addedBy: "creator", access: "send" });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const registry = createGatewayMethodRegistry([]);
    for (const ceiling of [undefined, "read", "suggest", "send"] as const) {
      role.sessions.maxInvitedAccess = ceiling;
      setRuntimeConfigSnapshot(cfg);
      for (const method of ["session.suggestions.add", "chat.send"] as const) {
        const dispatch = authorizeGatewayMethod(method, client, scope, registry, context);
        expect(dispatch).toEqual({ error: null, participationRequired: true });
        const result = await resolveSessionMutationAuthorizationAsync({
          client,
          context,
          method,
          requestParams: scope,
          participationRequired: dispatch.participationRequired,
        });
        const permitted =
          ceiling === "send" || (ceiling === "suggest" && method === "session.suggestions.add");
        expect(result.error === null, `${ceiling}/${method}`).toBe(permitted);
        try {
          if (!permitted) {
            continue;
          }
          expect(result.authorization).toBeDefined();
          expect(result.authorization?.participationCeiling?.kind).toBe(
            method === "chat.send" ? "send" : undefined,
          );
          const prepared = await prepareSessionSourceAuthority(result.authorization!.assertCurrent);
          try {
            expect(prepared.assertCurrent).not.toThrow();
          } finally {
            await prepared.release?.();
          }
        } finally {
          result.authorization?.release?.();
        }
      }
    }
  });
});

it("uses the owner's sandbox for opted-in participation but still requires it for own sessions", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    const role = cfg.gateway!.roles!.definitions.invited!;
    role.sessions.maxInvitedAccess = "send";
    role.sessions.invitedPermission = "full";
    role.sandbox = "required";
    role.scopes = ["operator.sessions.read", "operator.sessions.write"];
    setRuntimeConfigSnapshot(cfg);
    const client = roleClient("invited", "sandbox-participant");
    client.internal = { authenticatedOperator: true };
    client.connect.scopes = role.scopes;
    const profileId = client.authenticatedUserProfile!.profileId;
    expect(resolveSandboxedSessionCreation(client, cfg)?.sandbox).toBe("required");
    const scope = { agentId: "main", sessionKey: "agent:main:invited-unsandboxed" };
    const entry = {
      sessionId: "invited-unsandboxed",
      updatedAt: 1,
      permissionMode: "read-only" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: "creator" },
    };
    await upsertSessionEntryCore(scope, entry);
    addSessionMember(scope, { identityId: profileId, addedBy: "creator", access: "send" });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const authorize = () =>
      resolveSessionMutationAuthorizationAsync({
        client,
        context,
        method: "chat.send",
        requestParams: scope,
      });
    const admitted = await authorize();
    expect(admitted.error).toBeNull();
    expect(admitted.authorization?.participationCeiling).toMatchObject({
      profileId,
      permission: "read-only",
    });
    admitted.authorization?.release?.();
    delete role.sessions.maxInvitedAccess;
    const stock = await authorize();
    expect(stock.error?.message).toContain("requires a sandboxed session");
    stock.authorization?.release?.();
    // Without an invitation ceiling, a read-only caller cannot use the run error as a probe.
    client.connect.scopes = ["operator.sessions.read"];
    const probe = await resolveSessionMutationAuthorizationAsync({
      client,
      context,
      method: "chat.send",
      requestParams: scope,
      participationRequired: true,
    });
    expect(probe.error?.message).toBe(`Session "${scope.sessionKey}" was not found.`);
    client.connect.scopes = role.scopes;
    role.sessions.maxInvitedAccess = "send";
    scope.sessionKey = "agent:main:own-unsandboxed";
    await upsertSessionEntryCore(scope, {
      ...entry,
      sessionId: "own-unsandboxed",
      createdActor: { ...entry.createdActor, id: profileId },
    });
    const own = await authorize();
    expect(own.error?.message).toContain("requires a sandboxed session");
    own.authorization?.release?.();
  });
});
