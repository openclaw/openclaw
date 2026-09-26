import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { removeSessionMember as removeSessionMemberSync } from "../config/sessions/session-sharing-store.native.js";
import { historyLane } from "../config/sessions/session-transcript-worker-resources.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type {
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";

it("admits prepared facts for an authorized session that does not exist yet", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    let cfg = rolePolicyConfig();
    const client = roleClient("write", "new-session-owner");
    const scope = { agentId: "main", sessionKey: "agent:main:new-worker-session" };
    const result = await resolveSessionMutationAuthorizationAsync({
      client,
      method: "chat.send",
      requestParams: scope,
      context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
    });
    expect(result.error).toBeNull();
    const route = resolveGatewaySessionStoreTarget({
      cfg,
      key: scope.sessionKey,
      agentId: scope.agentId,
    });
    const effect = vi.fn();
    expect(() =>
      result.authorization!.withPreparedCurrent!(
        {
          agentId: route.agentId,
          storePath: route.storePath,
          sessionKey: route.canonicalKey,
          entry: undefined,
          members: [],
        },
        () => {
          cfg = { ...cfg, logging: { level: "debug" } };
          result.authorization!.assertCurrent();
          effect();
        },
        () => {},
      ),
    ).not.toThrow();
    expect(effect).toHaveBeenCalledOnce();
  });
});

it("allows unrelated config reloads while worker authorization reads are pending", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    let cfg = rolePolicyConfig();
    const client = roleClient("write", "reload-owner");
    const scope = { agentId: "main", sessionKey: "agent:main:reload-sharing" };
    replaceSessionEntrySync(scope, {
      sessionId: "reload-current",
      updatedAt: 1,
      createdActor: {
        type: "human",
        source: "profile",
        id: client.authenticatedUserProfile!.profileId,
      },
    });
    const read = historyLane.pool.run.bind(historyLane.pool);
    let reloads = 0;
    const spy = vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
      const reply = await read(...args);
      if (
        reply.ok &&
        typeof reply.value === "object" &&
        reply.value !== null &&
        "kind" in reply.value &&
        reply.value.kind === "session-exact-entries"
      ) {
        reloads += 1;
        cfg = { ...cfg, logging: { level: reloads % 2 ? "debug" : "info" } };
      }
      return reply;
    });
    try {
      const result = await resolveSessionMutationAuthorizationAsync({
        client,
        method: "chat.send",
        requestParams: scope,
        context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
      });
      expect(result.error).toBeNull();
      expect(reloads).toBeGreaterThan(0);
      const initialReloads = reloads;
      const effect = vi.fn(() => result.authorization!.assertCurrent());
      await result.authorization!.withCurrent!(effect);
      expect(reloads).toBeGreaterThan(initialReloads);
      expect(effect).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

it.each(["before-read", "before-consume"] as const)(
  "rejects membership revoked %s without retaining an allow decision",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const client = roleClient("view", "worker-member");
      const scope = { agentId: "main", sessionKey: "agent:main:worker-sharing" };
      replaceSessionEntrySync(scope, {
        sessionId: "sharing-current",
        updatedAt: 1,
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "another-profile" },
      });
      await addSessionMember(scope, {
        identityId: client.authenticatedUserProfile!.profileId,
        addedBy: "another-profile",
      });
      const host = observeHostDataSql();
      let authorization: SessionMutationAuthorization | undefined;
      try {
        const result = await resolveSessionMutationAuthorizationAsync({
          client,
          method: "chat.send",
          requestParams: scope,
          context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
        });
        expect(result.error).toBeNull();
        const currentAuthorization = result.authorization;
        if (!currentAuthorization) {
          throw new Error("expected session authorization");
        }
        authorization = currentAuthorization;
        await currentAuthorization.withCurrent!(() => currentAuthorization.assertCurrent());
        expect(host.calls.flatMap((call) => call.mock.calls)).toEqual([]);
      } finally {
        host.restore();
      }
      if (!authorization) {
        throw new Error("expected session authorization");
      }
      const revoke = () => removeSessionMember(scope, client.authenticatedUserProfile!.profileId);
      const read = historyLane.pool.run.bind(historyLane.pool);
      let revoked = false;
      const spy = vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
        const reply = await read(...args);
        if (
          boundary === "before-consume" &&
          !revoked &&
          reply.ok &&
          typeof reply.value === "object" &&
          reply.value !== null &&
          "kind" in reply.value &&
          reply.value.kind === "session-exact-entries"
        ) {
          revoked = true;
          await revoke();
        }
        return reply;
      });
      const effect = vi.fn();
      try {
        if (boundary === "before-read") {
          await revoke();
        }
        await expect(authorization.withCurrent!(effect)).rejects.toThrow();
        expect(effect).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  },
);

it.each(["membership", "owner", "routing", "policy", "unrelated-config"] as const)(
  "rechecks %s changes within the consuming frame",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg = rolePolicyConfig();
      const client = roleClient("view", "scoped-member");
      const scope = { agentId: "main", sessionKey: "agent:main:scoped-sharing" };
      replaceSessionEntrySync(scope, {
        sessionId: "scoped-current",
        updatedAt: 1,
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "another-profile" },
      });
      await addSessionMember(scope, {
        identityId: client.authenticatedUserProfile!.profileId,
        addedBy: "another-profile",
      });
      const result = await resolveSessionMutationAuthorizationAsync({
        client,
        method: "chat.send",
        requestParams: scope,
        context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
      });
      expect(result.error).toBeNull();
      const authorization = result.authorization!;
      let closing: Promise<void> | undefined;
      let checked = false;
      const outcome = authorization.withCurrent!(() => {
        authorization.assertCurrent();
        if (change === "membership") {
          removeSessionMemberSync(scope, client.authenticatedUserProfile!.profileId);
        } else if (change === "owner") {
          closing = closeOpenClawAgentDatabasesAsync();
        } else if (change === "policy") {
          const roles = cfg.gateway!.roles!;
          cfg = {
            ...cfg,
            gateway: {
              ...cfg.gateway,
              roles: {
                ...roles,
                definitions: {
                  ...roles.definitions,
                  view: { ...roles.definitions.view!, agents: [] },
                },
              },
            },
          };
        } else if (change === "unrelated-config") {
          cfg = { ...cfg, logging: { level: "debug" } };
        } else {
          cfg = { ...cfg, session: { store: "replacement/sessions.json" } };
        }
        if (change === "unrelated-config") {
          expect(() => authorization.assertCurrent()).not.toThrow();
        } else {
          expect(() => authorization.assertCurrent()).toThrow();
        }
        checked = true;
      });
      if (change === "owner") {
        await expect(outcome).rejects.toThrow();
      } else {
        await outcome;
      }
      await closing;
      expect(checked).toBe(true);
    });
  },
);

it.each(["role", "agent", "sandbox"] as const)(
  "rechecks prepared %s policy at the next worker admission",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg = rolePolicyConfig();
      const client = roleClient("view", "policy-member");
      const scope = { agentId: "main", sessionKey: "agent:main:policy-sharing" };
      replaceSessionEntrySync(scope, {
        sessionId: "policy-current",
        updatedAt: 1,
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "another-profile" },
      });
      await addSessionMember(scope, {
        identityId: client.authenticatedUserProfile!.profileId,
        addedBy: "another-profile",
      });
      const result = await resolveSessionMutationAuthorizationAsync({
        client,
        method: "chat.send",
        requestParams: scope,
        context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
      });
      expect(result.error).toBeNull();
      if (change === "role") {
        setUserProfileRole(client.authenticatedUserProfile!.profileId, "none");
      } else {
        const roles = cfg.gateway!.roles!;
        cfg = {
          ...cfg,
          gateway: {
            ...cfg.gateway,
            roles: {
              ...roles,
              definitions: {
                ...roles.definitions,
                view: {
                  ...roles.definitions.view!,
                  ...(change === "agent" ? { agents: [] } : { sandbox: "required" as const }),
                },
              },
            },
          },
        };
      }
      const effect = vi.fn();
      await expect(result.authorization!.withCurrent!(effect)).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
    });
  },
);
