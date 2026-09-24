import fs from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { initializeSessionReadContext } from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { sessionSharingHandlers } from "../../gateway/server-methods/sessions-sharing.js";
import {
  identifiedClient,
  sessionSharingTestContext as context,
  soloClient,
} from "../../gateway/server-methods/sessions-sharing.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../../gateway/server-methods/types.js";
import { createSessionMembershipProjection } from "../../gateway/session-membership-projection.js";
import { authorizePreparedSessionMutation } from "../../gateway/session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { rolePolicyConfig } from "../../gateway/session-sharing.test-utils.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import * as agentWorkers from "../../state/openclaw-agent-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  patchSessionEntryCore,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
} from "./session-accessor.sqlite-entry-cache.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.js";
import { updateSessionGroupCategoriesInWorker } from "./session-group-categories.js";
import {
  addSessionMember,
  listSessionMembersInWorker,
  removeSessionMember,
} from "./session-sharing-store.js";

it("reads complete current member rows without executing SQLite on the caller", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:worker-members" };
    const entry = { sessionId: "worker-members", updatedAt: 1 };
    await patchSessionEntryCore(scope, () => entry, {
      fallbackEntry: entry,
      skipMaintenance: true,
    });
    await addSessionMember(scope, {
      identityId: "zoe",
      addedBy: "actor-evidence:unknown",
      addedAt: 2,
    });
    await addSessionMember(scope, {
      identityId: "alice",
      addedBy: "actor-evidence:unattributed",
      addedAt: 3,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const databasePrototype: DatabaseSync = Object.getPrototypeOf(database.db);
    const methods = [
      vi.spyOn(prototype, "all"),
      vi.spyOn(prototype, "get"),
      vi.spyOn(prototype, "iterate"),
      vi.spyOn(prototype, "run"),
      vi.spyOn(databasePrototype, "exec"),
    ];
    try {
      expect(await listSessionMembersInWorker(scope)).toEqual([
        { identityId: "alice", addedBy: "actor-evidence:unattributed", addedAt: 3 },
        { identityId: "zoe", addedBy: "actor-evidence:unknown", addedAt: 2 },
      ]);
      for (const method of methods) {
        expect(method).not.toHaveBeenCalled();
      }
    } finally {
      for (const method of methods) {
        method.mockRestore();
      }
    }
    await addSessionMember(scope, { identityId: "bob", addedBy: "owner", addedAt: 4 });
    expect(await listSessionMembersInWorker(scope)).toEqual([
      { identityId: "alice", addedBy: "actor-evidence:unattributed", addedAt: 3 },
      { identityId: "bob", addedBy: "owner", addedAt: 4 },
      { identityId: "zoe", addedBy: "actor-evidence:unknown", addedAt: 2 },
    ]);
    const missing = { agentId: "missing", sessionKey: "agent:missing:main" };
    expect(await listSessionMembersInWorker(missing)).toEqual([]);
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "missing" }))).toBe(false);
  });
});

it("retains the physical owner and logical partition of a shared member store", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: state.statePath("shared-members.sqlite"),
    });
    const scope = { agentId: "other", sessionKey: "agent:other:members", storePath: database.path };
    await upsertSessionEntryCore(scope, { sessionId: "other-members", updatedAt: 1 });
    await addSessionMember(scope, {
      identityId: "other-guest",
      addedBy: "other-owner",
      addedAt: 2,
    });
    const sibling = { ...scope, agentId: "main", sessionKey: "agent:main:members" };
    await upsertSessionEntryCore(sibling, { sessionId: "main-members", updatedAt: 1 });
    await addSessionMember(sibling, {
      identityId: "main-guest",
      addedBy: "main-owner",
      addedAt: 3,
    });
    expect(await listSessionMembersInWorker(scope)).toEqual([
      { identityId: "other-guest", addedBy: "other-owner", addedAt: 2 },
    ]);
    expect(database.agentId).toBe("main");
  });
});

it("keeps process-local incognito membership with its native owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:dashboard:incognito-members" };
    expect(await listSessionMembersInWorker(scope)).toEqual([]);
    await upsertSessionEntryCore(scope, {
      sessionId: "incognito-members",
      updatedAt: 1,
      incognito: true,
    });
    await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
    expect(await listSessionMembersInWorker(scope)).toEqual([
      { identityId: "guest", addedBy: "owner", addedAt: 2 },
    ]);
  });
});

async function call(
  method: "session.members.list" | "session.members.listEvidence",
  params: Record<string, unknown>,
  requestContext: GatewayRequestContext,
  client: GatewayClient = soloClient(),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionSharingHandlers[method]?.({
    req: { type: "req", id: "members-worker-test", method },
    isWebchatConnect: () => false,
    params,
    client,
    context: requestContext,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  });
  return responses;
}

it.each(["session.members.list", "session.members.listEvidence"] as const)(
  "%s reads full member rows off the Gateway thread, including cached statements",
  async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:worker-members" };
      await upsertSessionEntryCore(scope, { sessionId: "worker-members", updatedAt: 1 });
      await addSessionMember(scope, { identityId: "zoe", addedBy: "owner", addedAt: 2 });
      await addSessionMember(scope, { identityId: "alice", addedBy: "owner", addedAt: 3 });
      const requestContext = context(vi.fn());
      await initializeSessionReadContext(requestContext);
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
      // Observe native execution, including statements prepared before the request.
      const all = vi.spyOn(prototype, "all");
      const iterate = vi.spyOn(prototype, "iterate");
      try {
        for (let round = 0; round < 2; round++) {
          const result = await call(method, { sessionKey: scope.sessionKey }, requestContext);
          expect(result[0]?.[1]).toMatchObject({
            members: [
              { identityId: "alice", addedBy: "owner", addedAt: 3 },
              { identityId: "zoe", addedBy: "owner", addedAt: 2 },
            ],
          });
        }
        expect(
          [...all.mock.contexts, ...iterate.mock.contexts]
            .map((statement) => (statement as StatementSync).sourceSQL)
            .filter((sql) => /from ["`]?session_members["`]?/i.test(sql)),
        ).toEqual([]);
      } finally {
        all.mockRestore();
        iterate.mockRestore();
      }
    });
  },
);

it("rechecks the current manager after the membership read yields", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:member-reader-authority" };
    await upsertSessionEntryCore(scope, {
      sessionId: "member-reader-authority",
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: "owner" },
    });
    await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
    const client = identifiedClient("owner");
    const requestContext = context(vi.fn());
    await initializeSessionReadContext(requestContext);
    const pending = call(
      "session.members.listEvidence",
      { sessionKey: scope.sessionKey },
      requestContext,
      client,
    );
    client.authenticatedUserProfile = identifiedClient("other").authenticatedUserProfile;
    await expect(pending).rejects.toThrow("session ownership changed before sharing read");
  });
});

it("commits worker membership and participant facts before publishing, and rejects stale authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:worker-writes" };
    const entry = {
      sessionId: "worker-writes",
      updatedAt: 1,
      createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
    };
    await upsertSessionEntryCore(scope, entry);
    const expectedEntry = {
      sessionId: entry.sessionId,
      createdActor: entry.createdActor,
      visibility: undefined,
      incognito: undefined,
    };
    const changes: SessionRowChange[] = [];
    const stop = sessionChanges.subscribeFacts((change) => changes.push(change));
    const participantLifecycle = vi.fn();
    const stopLifecycle = onSessionLifecycleEvent((event) => {
      if (event.sessionKey === scope.sessionKey && event.reason === "participants") {
        participantLifecycle(event);
      }
    });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const queries: string[] = [];
    const methods = (["all", "get", "run", "iterate"] as const).map((method) => {
      const original = prototype[method];
      return vi.spyOn(prototype, method).mockImplementation(
        new Proxy(original, {
          apply(target, receiver: StatementSync, args) {
            queries.push(receiver.sourceSQL);
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
    });
    try {
      expect(
        await addSessionMember(scope, {
          identityId: "guest",
          addedBy: "owner",
          addedAt: 2,
          expectedSessionId: entry.sessionId,
          expectedEntry,
        }),
      ).toEqual({ inserted: true, member: { identityId: "guest", addedBy: "owner", addedAt: 2 } });
      expect(changes.at(-1)).toMatchObject({
        sessionKey: scope.sessionKey,
        facts: { kind: "member", identityId: "guest", present: true },
      });
      expect(
        await recordSessionParticipant(scope, {
          identity: { type: "agent", id: "peer" },
          promptedAt: 3,
        }),
      ).toBe("inserted");
      expect(changes.at(-1)).toMatchObject({
        sessionKey: scope.sessionKey,
        facts: {
          kind: "participants",
          projection: {
            participants: [{ identity: { type: "agent", id: "peer" } }],
            participantCount: 1,
          },
        },
      });
      const publications = changes.length;
      expect(
        await recordSessionParticipant(scope, {
          identity: { type: "agent", id: "peer" },
          promptedAt: 4,
        }),
      ).toBe("updated");
      expect(changes).toHaveLength(publications);
      expect(participantLifecycle).toHaveBeenCalledTimes(2);
      await expect(
        addSessionMember(scope, {
          identityId: "stale",
          addedBy: "owner",
          expectedSessionId: entry.sessionId,
          expectedEntry: {
            ...expectedEntry,
            createdActor: { ...entry.createdActor, id: "former-owner" },
          },
        }),
      ).rejects.toThrow("session ownership changed before sharing mutation");
      await expect(
        removeSessionMember(scope, "guest", undefined, entry.sessionId, () => {
          throw new Error("revoked manager");
        }),
      ).rejects.toThrow("revoked manager");
      expect(await removeSessionMember(scope, "guest", undefined, entry.sessionId)).toEqual({
        identityId: "guest",
        addedBy: "owner",
        addedAt: 2,
      });
      expect(changes.at(-1)).toMatchObject({
        sessionKey: scope.sessionKey,
        facts: { kind: "member", identityId: "guest", present: false },
      });
      expect(
        queries.filter((sql) => /\b(session_members|session_participants)\b/.test(sql)),
      ).toEqual([]);
    } finally {
      stop();
      stopLifecycle();
      for (const method of methods) {
        method.mockRestore();
      }
    }
    expect(await listSessionMembersInWorker(scope)).toEqual([]);
  });
});

it.each([
  { mutation: "membership", generation: "replacement" },
  { mutation: "category", generation: "replacement" },
  { mutation: "category", generation: "same-session" },
] as const)(
  "keeps newer $generation facts when an earlier $mutation worker reply arrives",
  async ({ mutation, generation }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      const scope = { agentId: "main", sessionKey: "agent:main:delayed-collaboration-reply" };
      const entry = {
        sessionId: "original-session",
        lifecycleRevision: "original-generation",
        updatedAt: 1,
        category: "Work",
        createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
      };
      await upsertSessionEntryCore(scope, entry);
      const database = openOpenClawAgentDatabase(scope);
      const projection = createSessionMembershipProjection();
      projection.updateTargets([
        {
          agentId: scope.agentId,
          storePath: database.path,
          ...readOpenClawAgentDatabaseIdentity(database),
        },
      ]);
      const stop = sessionChanges.subscribeFacts(projection.invalidate);
      await projection.prepare();
      readSessionEntryCache(database, { cache: true });
      const committed = createDeferredCore();
      const releaseReply = createDeferredCore();
      const original = agentWorkers.openOpenClawAgentSqliteWorkerStore;
      const open = vi
        .spyOn(agentWorkers, "openOpenClawAgentSqliteWorkerStore")
        .mockImplementation(
          async <Operations extends SqliteWorkerOperations>(
            ...args: Parameters<typeof original>
          ) => {
            const worker = await original<Operations>(...args);
            return {
              ...worker,
              run<T>(
                consume: (operation: Pick<SqliteWorkerStore<Operations>, "execute">) => Promise<T>,
                assertCurrent: () => void,
              ) {
                return worker.run(
                  (operation) =>
                    consume({
                      async execute(command, options) {
                        const result = await operation.execute(command, options);
                        if (
                          command.type === (mutation === "membership" ? "add" : "category.apply")
                        ) {
                          committed.resolve();
                          await releaseReply.promise;
                        }
                        return result;
                      },
                    }),
                  assertCurrent,
                );
              },
            };
          },
        );
      const pending =
        mutation === "membership"
          ? addSessionMember(scope, {
              identityId: "guest",
              addedBy: "owner",
              expectedSessionId: entry.sessionId,
            })
          : updateSessionGroupCategoriesInWorker({ scope, from: "Work" });
      let replacement: Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined;
      try {
        await Promise.race([
          committed.promise,
          pending.then(() => {
            throw new Error("collaboration mutation completed before the held worker reply");
          }),
        ]);
        const newerEntry = {
          ...entry,
          ...(generation === "replacement"
            ? {
                sessionId: "replacement-session",
                lifecycleRevision: "replacement-generation",
              }
            : {}),
          updatedAt: 2,
          category: "Replacement",
        };
        replaceSessionEntrySync(scope, newerEntry);
        if (mutation === "membership") {
          replacement = await prepareSessionMutationFacts({ cfg, ...scope });
        }
        const assertNewerFacts = () => {
          if (mutation === "membership") {
            const facts = replacement!.readCurrent(cfg);
            expect(facts.target.entry.sessionId).toBe(newerEntry.sessionId);
            expect(
              authorizePreparedSessionMutation(
                { cfg, ...scope, client: identifiedClient("guest") },
                facts,
                { policy: cfg.gateway!.roles!.definitions.view, aliases: new Set(["guest"]) },
              ),
            ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
            expect([...facts.membership]).toEqual([]);
          } else {
            expect(
              readCommittedSessionEntryCache(database.db)?.get(scope.sessionKey)?.category,
            ).toBe("Replacement");
            expect(projection.groupTargets().get("Replacement")).toEqual([
              { sessionKey: scope.sessionKey, agentId: scope.agentId },
            ]);
          }
        };
        assertNewerFacts();
        releaseReply.resolve();
        if (mutation === "membership") {
          await expect(pending).resolves.toMatchObject({ inserted: true });
        } else {
          await expect(pending).resolves.toBe(1);
          await projection.prepare();
        }
        assertNewerFacts();
        expect(await listSessionMembersInWorker(scope)).toEqual([]);
      } finally {
        releaseReply.resolve();
        await pending.catch(() => undefined);
        replacement?.release();
        open.mockRestore();
        stop();
        projection.dispose();
      }
    });
  },
);

it.each(["membership", "category"] as const)(
  "fences cached %s facts when a committed mutation loses its worker reply",
  async (mutation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:lost-member-reply" };
      await upsertSessionEntryCore(scope, {
        sessionId: "lost-member-reply",
        updatedAt: 1,
        category: " Work ",
      });
      await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
      const database = openOpenClawAgentDatabase(scope);
      readSessionEntryCache(database, { cache: true });
      const projection = createSessionMembershipProjection();
      projection.updateTargets([
        {
          agentId: scope.agentId,
          storePath: database.path,
          ...readOpenClawAgentDatabaseIdentity(database),
        },
      ]);
      const changes: SessionRowChange[] = [];
      const cachesAtInvalidation: Array<ReturnType<typeof readCommittedSessionEntryCache>> = [];
      const stop = sessionChanges.subscribeFacts((change) => {
        changes.push(change);
        cachesAtInvalidation.push(readCommittedSessionEntryCache(database.db));
        projection.invalidate(change);
      });
      const failure = new SqliteWorkerError(
        "membership reply lost after commit",
        "outcome-unknown",
      );
      const original = agentWorkers.openOpenClawAgentSqliteWorkerStore;
      const open = vi
        .spyOn(agentWorkers, "openOpenClawAgentSqliteWorkerStore")
        .mockImplementation(
          async <Operations extends SqliteWorkerOperations>(
            ...args: Parameters<typeof original>
          ) => {
            const worker = await original<Operations>(...args);
            return {
              ...worker,
              run<T>(
                consume: (operation: Pick<SqliteWorkerStore<Operations>, "execute">) => Promise<T>,
                assertCurrent: () => void,
              ) {
                return worker.run(
                  (operation) =>
                    consume({
                      async execute(command, options) {
                        const result = await operation.execute(command, options);
                        if (
                          command.type === (mutation === "category" ? "category.apply" : "remove")
                        ) {
                          throw failure;
                        }
                        return result;
                      },
                    }),
                  assertCurrent,
                );
              },
            };
          },
        );
      const run = (assertCurrent?: () => void) =>
        mutation === "category"
          ? updateSessionGroupCategoriesInWorker({
              scope,
              from: "Work",
              assertTargetCurrent: assertCurrent,
            })
          : removeSessionMember(scope, "guest", undefined, "lost-member-reply", assertCurrent);
      try {
        await projection.prepare();
        expect(projection.membership(database.path, scope.sessionKey)).toEqual(["guest"]);
        await expect(
          run(() => {
            throw new Error("manager already revoked");
          }),
        ).rejects.toThrow("manager already revoked");
        expect(changes).toEqual([]);
        expect(projection.membership(database.path, scope.sessionKey)).toEqual(["guest"]);
        expect(readCommittedSessionEntryCache(database.db)?.get(scope.sessionKey)?.category).toBe(
          " Work ",
        );
        await expect(run()).rejects.toBe(failure);
        expect(changes).toEqual([
          expect.objectContaining(
            mutation === "category"
              ? {
                  all: true,
                  scope: { storePath: database.path },
                  factsInvalidated: true,
                }
              : {
                  sessionKey: scope.sessionKey,
                  storePath: database.path,
                  factsInvalidated: true,
                },
          ),
        ]);
        if (mutation === "category") {
          expect(cachesAtInvalidation).toEqual([undefined]);
        }
        expect(projection.membership(database.path, scope.sessionKey)).toEqual([]);
        expect(projection.needsPreparation).toBe(true);
        await projection.prepare();
        const members = mutation === "category" ? ["guest"] : [];
        expect(projection.membership(database.path, scope.sessionKey)).toEqual(members);
        expect(projection.needsPreparation).toBe(false);
        expect(
          (await listSessionMembersInWorker(scope)).map((member) => member.identityId),
        ).toEqual(members);
        expect(
          readSessionEntryCache(database, { cache: true }).entries.get(scope.sessionKey)?.category,
        ).toBe(mutation === "category" ? undefined : " Work ");
        expect(projection.groupTargets().has("Work")).toBe(mutation !== "category");
      } finally {
        open.mockRestore();
        stop();
        projection.dispose();
      }
    });
  },
);
