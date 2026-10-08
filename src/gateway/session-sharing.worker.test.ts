import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareQualifiedSessionEntryTarget } from "../config/sessions/session-accessor.entry.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { removeSessionMember as removeSessionMemberSync } from "../config/sessions/session-sharing-store.native.js";
import { projectionLane } from "../config/sessions/session-transcript-worker-resources.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type {
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { prepareSessionSharingSource } from "./session-sharing-source.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";
import { withQualifiedGatewaySessionEntry } from "./session-utils-store.js";

it.each(["before", "after"] as const)(
  "refuses a sharing locator retargeted %s source preparation while the original store remains",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:sharing-locator";
      const original = state.statePath("original", "store.main.sqlite");
      const replacement = state.statePath("replacement", "store.main.sqlite");
      for (const storePath of [original, replacement]) {
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey },
          { sessionId: "identical", updatedAt: 1, visibility: "shared" },
        );
      }
      const database = openOpenClawAgentDatabase({ agentId: "main", path: original });
      const identity = readOpenClawAgentDatabaseIdentity(database);
      const alias = state.statePath("selected");
      fs.symlinkSync(state.statePath("original"), alias, "junction");
      const retarget = () => {
        fs.unlinkSync(alias);
        fs.symlinkSync(state.statePath("replacement"), alias, "junction");
      };
      const target = {
        agentId: "main",
        canonicalKey: sessionKey,
        storeKey: sessionKey,
        storePath: state.statePath("selected", "store.json"),
        readSource: {
          agentId: "main",
          path: database.path,
          databaseIdentity: identity.identity,
          databaseBirthtime: identity.birthtime,
        },
      };
      if (phase === "before") {
        retarget();
        // Join any unexpectedly accepted reader so the negative control cannot leak custody.
        await expect(
          prepareSessionSharingSource(target, () => {}).then((prepared) => prepared.release()),
        ).rejects.toThrow("Session sharing source changed");
      } else {
        const prepared = await prepareSessionSharingSource(target, () => {});
        try {
          expect(prepared.target?.entry.sessionId).toBe("identical");
          retarget();
          expect(() => prepared.assertCurrent()).toThrow("Session sharing source changed");
        } finally {
          await prepared.release();
        }
      }
    });
  },
);

it.each([
  { kind: "qualified", agentId: "main" },
  { kind: "alias", agentId: "main" },
  { kind: "global", agentId: "main" },
  { kind: "global", agentId: "work" },
])(
  "admits missing $agentId $kind session authority without caller-thread SQL",
  async ({ kind, agentId }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg = rolePolicyConfig();
      if (kind === "global") {
        cfg = {
          ...cfg,
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
          session: { ...cfg.session, scope: "global" },
        };
      }
      const client = roleClient("write", "new-session-owner");
      const scope = {
        agentId,
        sessionKey: kind === "qualified" ? "agent:main:new-worker-session" : "global",
      };
      const route = resolveGatewaySessionStoreTarget({
        cfg,
        key: kind === "alias" ? "agent:main:main" : scope.sessionKey,
        agentId: scope.agentId,
      });
      const qualified = prepareQualifiedSessionEntryTarget({
        ...route,
        requestedKey: kind === "alias" ? route.canonicalKey : scope.sessionKey,
        storeKey: route.canonicalKey,
      });
      const effect = vi.fn();
      const host = observeHostDataSql();
      try {
        const result = await resolveSessionMutationAuthorizationAsync({
          client,
          method: "chat.send",
          requestParams: scope,
          context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
        });
        expect(result.error).toBeNull();
        await withQualifiedGatewaySessionEntry({
          cfg,
          target: qualified.target,
          logicalStorePath: route.storePath,
          includeMembership: true,
          assertConfigCurrent: () => {},
          consume: (latest, membership, assertSourceCurrent) => {
            expect(latest.legacyKey ?? latest.canonicalKey).toBe(route.canonicalKey);
            return result.authorization!.withPreparedCurrent!(
              {
                agentId: latest.agentId,
                storePath: latest.storePath,
                sessionKey: latest.canonicalKey,
                entry: latest.entry,
                readSource: latest.capturedReadSource,
                members: membership.get(latest.legacyKey ?? latest.canonicalKey) ?? [],
              },
              () => {
                if (kind === "global") {
                  const wrongOwnerEffect = vi.fn();
                  expect(() =>
                    result.authorization!.withPreparedCurrent!(
                      {
                        agentId: latest.agentId,
                        storePath: latest.storePath,
                        sessionKey: "agent:other:global",
                        entry: latest.entry,
                        readSource: latest.capturedReadSource,
                        members: [],
                      },
                      wrongOwnerEffect,
                      assertSourceCurrent,
                    ),
                  ).toThrow("session changed");
                  expect(wrongOwnerEffect).not.toHaveBeenCalled();
                }
                cfg = { ...cfg, logging: { level: "debug" } };
                result.authorization!.assertCurrent();
                result.authorization!.assertTargetCurrent(scope);
                effect();
              },
              assertSourceCurrent,
            );
          },
        });
        await result.authorization!.admittedInputAuthority!.withCurrent((facts, assertCurrent) => {
          expect(facts.entry).toBeUndefined();
          expect(facts.members).toEqual([]);
          assertCurrent();
          result.authorization!.assertCurrent();
        });
        expect(effect).toHaveBeenCalledOnce();
        expect(host.queries).toEqual([]);
      } finally {
        host.restore();
        qualified.release();
      }
    });
  },
);

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
    const read = projectionLane.pool.run.bind(projectionLane.pool);
    let reloads = 0;
    const spy = vi.spyOn(projectionLane.pool, "run").mockImplementation(async (...args) => {
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

it("does not replay an authorization consumer after its own effect changes the row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = rolePolicyConfig();
    const client = roleClient("write", "consumer-owner");
    const scope = { agentId: "main", sessionKey: "agent:main:consumer-settlement" };
    const entry = {
      sessionId: "consumer-session",
      updatedAt: 1,
      createdActor: {
        type: "human" as const,
        source: "profile" as const,
        id: client.authenticatedUserProfile!.profileId,
      },
    };
    replaceSessionEntrySync(scope, entry);
    const result = await resolveSessionMutationAuthorizationAsync({
      client,
      method: "chat.send",
      requestParams: scope,
      context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
    });
    expect(result.error).toBeNull();
    const effect = vi.fn();
    await expect(
      result.authorization!.withCurrent!(() => {
        effect();
        replaceSessionEntrySync(scope, { ...entry, updatedAt: effect.mock.calls.length + 1 });
        result.authorization!.assertCurrent();
      }),
    ).rejects.toThrow(/changed during read/);
    expect(effect).toHaveBeenCalledOnce();
  });
});

it.each([
  "worker-before-read",
  "foreign-before-read",
  "native-before-consume",
  "owner-before-consume",
] as const)("rejects %s authority revocation before disclosure", async (boundary) => {
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
    const database = openOpenClawAgentDatabase(scope);
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
      await currentAuthorization.admittedInputAuthority!.withCurrent((facts, assertCurrent) => {
        expect(facts.entry?.sessionId).toBe("sharing-current");
        expect(facts.members.map((member) => member.identityId)).toEqual([
          client.authenticatedUserProfile!.profileId,
        ]);
        assertCurrent();
        currentAuthorization.assertCurrent();
      });
      expect(host.calls.flatMap((call) => call.mock.calls)).toEqual([]);
    } finally {
      host.restore();
    }
    if (!authorization) {
      throw new Error("expected session authorization");
    }
    const read = projectionLane.pool.run.bind(projectionLane.pool);
    let revoked = false;
    let closing: Promise<void> | undefined;
    const spy = vi.spyOn(projectionLane.pool, "run").mockImplementation(async (...args) => {
      const reply = await read(...args);
      if (
        boundary.endsWith("before-consume") &&
        !revoked &&
        reply.ok &&
        typeof reply.value === "object" &&
        reply.value !== null &&
        "kind" in reply.value &&
        reply.value.kind === "session-exact-entries"
      ) {
        revoked = true;
        if (boundary === "owner-before-consume") {
          closing = closeOpenClawAgentDatabasesAsync();
        } else {
          // Raw SDK DML has no sessionChanges publication and cannot join the held writer FIFO.
          database.db
            .prepare("DELETE FROM session_members WHERE session_key = ? AND identity_id = ?")
            .run(scope.sessionKey, client.authenticatedUserProfile!.profileId);
        }
      }
      return reply;
    });
    const effect = vi.fn();
    try {
      if (boundary === "worker-before-read") {
        await removeSessionMember(scope, client.authenticatedUserProfile!.profileId);
      } else if (boundary === "foreign-before-read") {
        const foreign = new DatabaseSync(database.path);
        try {
          foreign
            .prepare("DELETE FROM session_members WHERE session_key = ? AND identity_id = ?")
            .run(scope.sessionKey, client.authenticatedUserProfile!.profileId);
        } finally {
          foreign.close();
        }
      }
      await expect(authorization.admittedInputAuthority!.withCurrent(effect)).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
      if (boundary.endsWith("before-consume")) {
        expect(revoked).toBe(true);
      }
    } finally {
      spy.mockRestore();
      await closing;
    }
  });
});

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

it.each(["role", "agent", "sandbox", "unprepared-role"] as const)(
  "rechecks prepared %s policy at the next worker admission",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg = rolePolicyConfig();
      const client =
        change === "unprepared-role"
          ? sharingPolicyClient({
              user: ensureProfileForEmail("unprepared-member@example.test").id,
            })
          : roleClient("view", "policy-member");
      if (change === "unprepared-role") {
        setUserProfileRole(client.authenticatedUserProfile!.profileId, "view");
        expect(client.preparedSessionProfile).toBeUndefined();
      }
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
      const host = observeHostDataSql();
      let authorization: SessionMutationAuthorization;
      try {
        const result = await resolveSessionMutationAuthorizationAsync({
          client,
          method: "chat.send",
          requestParams: scope,
          context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
        });
        expect(result.error, "prepared role authorization").toBeNull();
        authorization = result.authorization!;
        await authorization.withCurrent!(() => authorization.assertCurrent());
        expect(host.queries).toEqual([]);
      } finally {
        host.restore();
      }
      if (change === "role" || change === "unprepared-role") {
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
      await expect(authorization.withCurrent!(effect)).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
      if (change === "unprepared-role") {
        expect(client.preparedSessionProfile).toBeUndefined();
      }
    });
  },
);
