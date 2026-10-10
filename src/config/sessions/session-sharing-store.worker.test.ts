import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import { getSessionRowProjection } from "../../gateway/session-row-projection-access.js";
import { authorizePreparedSessionMutation } from "../../gateway/session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { rolePolicyConfig } from "../../gateway/session-sharing.test-utils.js";
import {
  SqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import * as agentWorkers from "../../state/openclaw-agent-worker-store.js";
import { emitUserProfilesChanged } from "../../state/user-profile-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { retainPreparedSessionSharingFacts } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
} from "./session-accessor.sqlite-entry-cache.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { updateSessionGroupCategoriesInWorker } from "./session-group-categories.js";
import { assignSessionOwnerInWorker } from "./session-metadata-write.async.js";
import { recordSessionParticipantInWorker as recordSessionParticipant } from "./session-sharing-store.async.js";
import {
  addSessionMember,
  readSessionMembersInWorker,
  removeSessionMember,
} from "./session-sharing-store.js";
import { historyLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

it("lists current membership evidence while transcript reads wait", async () => {
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
    const requestContext = context(vi.fn());
    await initializeSessionReadContext(requestContext);
    await getSessionRowProjection(requestContext)!.ensureMaterialized();
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const historyEntered = createDeferredCore();
    const historyContended = createDeferredCore();
    const releaseHistory = createDeferredCore();
    const runHistory = historyLane.pool.run.bind(historyLane.pool);
    let historyRequests = 0;
    const historyRun = vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
      if (++historyRequests === 1) {
        historyEntered.resolve();
      } else {
        historyContended.resolve();
      }
      await releaseHistory.promise;
      return await runHistory(...args);
    });
    const historyRead = withSessionHistoryWorkerDatabase({ agentId: "main" }, (owner) =>
      owner.readEntryPresence({ ...scope, databaseAgentId: "main", storePath: database.path }),
    );
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const databasePrototype: DatabaseSync = Object.getPrototypeOf(database.db);
    const methods = [
      vi.spyOn(prototype, "all"),
      vi.spyOn(prototype, "get"),
      vi.spyOn(prototype, "iterate"),
      vi.spyOn(prototype, "run"),
      vi.spyOn(databasePrototype, "exec"),
    ];
    let membersRead: ReturnType<typeof call> | undefined;
    try {
      await Promise.race([historyEntered.promise, historyRead]);
      expect(historyRequests).toBe(1);
      membersRead = call(
        "session.members.listEvidence",
        { sessionKey: scope.sessionKey },
        requestContext,
      );
      // A queued dependency signals contention directly; no timing threshold decides success.
      expect(
        await Promise.race([
          membersRead.then((responses) => responses[0]?.[1]),
          historyContended.promise.then(() => ({ blockedByTranscript: true })),
        ]),
      ).toMatchObject({
        members: [
          { identityId: "alice", addedAt: 3 },
          { identityId: "zoe", addedByState: "unknown", addedAt: 2 },
        ],
      });
      for (const method of methods) {
        expect(method).not.toHaveBeenCalled();
      }
    } finally {
      for (const method of methods) {
        method.mockRestore();
      }
      releaseHistory.resolve();
      await Promise.allSettled([historyRead, membersRead]);
      historyRun.mockRestore();
    }
    expect(await historyRead).toBe(true);
    await addSessionMember(scope, { identityId: "bob", addedBy: "owner", addedAt: 4 });
    expect((await readSessionMembersInWorker(scope)).members).toEqual([
      { identityId: "alice", addedBy: "actor-evidence:unattributed", addedAt: 3 },
      { identityId: "bob", addedBy: "owner", addedAt: 4 },
      { identityId: "zoe", addedBy: "actor-evidence:unknown", addedAt: 2 },
    ]);
    const missing = { agentId: "missing", sessionKey: "agent:missing:main" };
    expect((await readSessionMembersInWorker(missing)).members).toEqual([]);
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
    expect((await readSessionMembersInWorker(scope)).members).toEqual([
      { identityId: "other-guest", addedBy: "other-owner", addedAt: 2 },
    ]);
    expect(database.agentId).toBe("main");
  });
});

it("keeps process-local incognito membership with its native owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:dashboard:incognito-members" };
    expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
    await upsertSessionEntryCore(scope, {
      sessionId: "incognito-members",
      updatedAt: 1,
      incognito: true,
    });
    await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
    expect((await readSessionMembersInWorker(scope)).members).toEqual([
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

it("commits aliased worker membership and participant facts before publishing, and rejects stale authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const alias = state.path("member-alias");
    fs.symlinkSync(path.dirname(database.path), alias, "junction");
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:worker-writes",
      storePath: path.join(alias, path.basename(database.path)),
    };
    const entry = {
      sessionId: "worker-writes",
      updatedAt: 1,
      createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
    };
    replaceSessionEntrySync(scope, entry);
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
    expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
  });
});

it("rejects the complete aliased category update when a later member changes after preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const alias = state.path("category-alias");
    fs.symlinkSync(path.dirname(database.path), alias, "junction");
    const scopeAt = (index: number) => ({
      agentId: "main",
      storePath: path.join(alias, path.basename(database.path)),
      sessionKey: `agent:main:category-revalidation:${String(index).padStart(2, "0")}`,
    });
    const firstScope = scopeAt(0);
    const replacedScope = scopeAt(11);
    const scopes = [
      firstScope,
      ...Array.from({ length: 10 }, (_, index) => scopeAt(index + 1)),
      replacedScope,
    ];
    for (const [index, scope] of scopes.entries()) {
      replaceSessionEntrySync(scope, {
        sessionId: `original-${index}`,
        updatedAt: 1,
        category: "Work",
      });
    }
    let changed = false;
    await expect(
      updateSessionGroupCategoriesInWorker({
        scope: firstScope,
        from: "Work",
        assertTargetCurrent() {
          if (!changed) {
            changed = true;
            replaceSessionEntrySync(replacedScope, {
              sessionId: "replacement",
              updatedAt: 2,
              category: "Replacement",
            });
          }
        },
      }),
    ).rejects.toThrow(
      `SQLite session entry changed before replacement for ${replacedScope.sessionKey}`,
    );
    expect(loadSessionEntry(firstScope)).toMatchObject({
      sessionId: "original-0",
      updatedAt: 1,
      category: "Work",
    });
    expect(loadSessionEntry(replacedScope)).toMatchObject({
      sessionId: "replacement",
      updatedAt: 2,
      category: "Replacement",
    });
    await expect(
      updateSessionGroupCategoriesInWorker({ scope: firstScope, from: "Work" }),
    ).resolves.toBe(11);
    for (const [index, scope] of scopes.slice(0, -1).entries()) {
      const entry = loadSessionEntry(scope);
      expect(entry).toMatchObject({ sessionId: `original-${index}`, updatedAt: 1 });
      expect(entry?.category).toBeUndefined();
    }
    expect(loadSessionEntry(replacedScope)?.category).toBe("Replacement");
  });
});

it.each([
  { mutation: "membership", generation: "replacement", lostReply: false },
  { mutation: "removal", generation: "same-session", lostReply: true },
  { mutation: "category", generation: "replacement", lostReply: false },
  { mutation: "category", generation: "same-session", lostReply: false },
  { mutation: "category", generation: "replacement", lostReply: true },
  { mutation: "category", generation: "same-session", lostReply: true },
] as const)(
  "keeps newer $generation facts when an earlier $mutation receipt and reply settle (lost: $lostReply)",
  async ({ mutation, generation, lostReply }) => {
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
      if (mutation === "removal") {
        await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
      }
      const database = openOpenClawAgentDatabase(scope);
      const sharing =
        mutation === "removal"
          ? retainPreparedSessionSharingFacts({
              databaseIdentity: `file:${String(readOpenClawAgentDatabaseIdentity(database).identity)}`,
              sessionKey: scope.sessionKey,
              entry,
              membership: new Set(["guest"]),
            })
          : undefined;
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
      const failure = new SqliteWorkerError("superseded category reply lost", "outcome-unknown");
      const changes: SessionRowChange[] = [];
      const stopChanges = sessionChanges.subscribeFacts((change) => changes.push(change));
      let deliverReceipt: (() => void) | undefined;
      const observeCommitted = workerAdmission.observeSqliteWorkerCommittedFacts;
      const delayReceipt = vi
        .spyOn(workerAdmission, "observeSqliteWorkerCommittedFacts")
        .mockImplementation((admission, observer) =>
          observeCommitted(admission, (receipt) => {
            deliverReceipt = () => observer(receipt);
          }),
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
                          command.type ===
                          (mutation === "membership"
                            ? "add"
                            : mutation === "removal"
                              ? "remove"
                              : "category.apply")
                        ) {
                          committed.resolve();
                          await releaseReply.promise;
                          if (lostReply) {
                            throw failure;
                          }
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
          : mutation === "removal"
            ? removeSessionMember(scope, "guest", undefined, entry.sessionId)
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
          ...(mutation === "removal"
            ? { label: "newer native label" }
            : { category: "Replacement" }),
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
          } else if (mutation === "removal") {
            expect(sharing?.readCurrent()).toBeUndefined();
            expect(readCommittedSessionEntryCache(database.db)?.get(scope.sessionKey)?.label).toBe(
              "newer native label",
            );
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
        changes.length = 0;
        expect(deliverReceipt).toBeTypeOf("function");
        deliverReceipt?.();
        releaseReply.resolve();
        if (mutation === "membership") {
          await expect(pending).resolves.toMatchObject({ inserted: true });
        } else if (mutation === "removal") {
          await expect(pending).resolves.toMatchObject({ identityId: "guest" });
        } else {
          await expect(pending).resolves.toBe(1);
        }
        expect(changes).toEqual(
          mutation === "removal"
            ? [expect.objectContaining({ sessionKey: scope.sessionKey, factsInvalidated: true })]
            : [],
        );
        assertNewerFacts();
        expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
      } finally {
        releaseReply.resolve();
        await pending.catch(() => undefined);
        replacement?.release();
        sharing?.release();
        open.mockRestore();
        delayReceipt.mockRestore();
        stopChanges();
        stop();
        projection.dispose();
      }
    });
  },
);

it.each([
  { mutation: "membership", receipt: "valid" },
  { mutation: "category", receipt: "valid" },
  { mutation: "membership", receipt: "conflicting" },
  { mutation: "membership", receipt: "missing" },
] as const)(
  "settles committed $mutation with $receipt receipt when the ordinary worker reply is lost",
  async ({ mutation, receipt }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:lost-member-reply",
        ...(mutation === "category"
          ? { storePath: state.statePath("shared-category.sqlite") }
          : {}),
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "lost-member-reply",
        updatedAt: 1,
        category: " Work ",
      });
      await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
      const aliasedScope = {
        agentId: "other",
        storePath: database.path,
        sessionKey: "agent:other:lost-category-reply",
      };
      if (mutation === "category") {
        await upsertSessionEntryCore(aliasedScope, {
          sessionId: "aliased-category",
          updatedAt: 1,
          category: "Work",
        });
      }
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
      const cachesAtPublication: Array<ReturnType<typeof readCommittedSessionEntryCache>> = [];
      const stop = sessionChanges.subscribeFacts((change) => {
        changes.push(change);
        cachesAtPublication.push(readCommittedSessionEntryCache(database.db));
        projection.invalidate(change);
      });
      const failure = new SqliteWorkerError(
        "membership reply lost after commit",
        "outcome-unknown",
      );
      const observeCommitted = workerAdmission.observeSqliteWorkerCommittedFacts;
      const corruptReceipt = vi
        .spyOn(workerAdmission, "observeSqliteWorkerCommittedFacts")
        .mockImplementation((admission, observer) =>
          observeCommitted(admission, (committed) => {
            if (receipt === "missing") {
              return;
            }
            const facts: unknown = structuredClone(committed.facts);
            if (receipt === "conflicting") {
              if (!isRecord(facts) || !isRecord(facts.result) || !isRecord(facts.result.facts)) {
                throw new Error("Expected native membership commit receipt");
              }
              facts.result.facts.present = true;
            }
            observer({ facts });
          }),
        );
      let mutations = 0;
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
                        if (
                          command.type === (mutation === "category" ? "category.apply" : "remove")
                        ) {
                          mutations++;
                        }
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
        if (receipt !== "valid") {
          const outcome = await run().then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(hasSqliteWorkerOutcomeUnknown(outcome)).toBe(true);
          expect(mutations).toBe(1);
          expect(projection.membership(database.path, scope.sessionKey)).toEqual([]);
          expect(projection.needsPreparation).toBe(true);
          expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
          return;
        }
        await expect(run()).resolves.toEqual(
          mutation === "category" ? 2 : { identityId: "guest", addedBy: "owner", addedAt: 2 },
        );
        expect(changes).toEqual(
          mutation === "category"
            ? [scope.sessionKey, aliasedScope.sessionKey].map((sessionKey) =>
                expect.objectContaining({
                  sessionKey,
                  storePath: database.path,
                  facts: expect.objectContaining({ kind: "category", category: null }),
                }),
              )
            : [
                expect.objectContaining({
                  sessionKey: scope.sessionKey,
                  storePath: database.path,
                  facts: {
                    kind: "member",
                    sessionId: "lost-member-reply",
                    identityId: "guest",
                    present: false,
                  },
                }),
              ],
        );
        if (mutation === "category") {
          expect(cachesAtPublication).toHaveLength(2);
          for (const cache of cachesAtPublication) {
            expect(cache?.get(scope.sessionKey)?.category).toBeUndefined();
            expect(cache?.get(aliasedScope.sessionKey)?.category).toBeUndefined();
          }
          expect(loadSessionEntry(aliasedScope)?.category).toBeUndefined();
        }
        const members = mutation === "category" ? ["guest"] : [];
        expect(projection.membership(database.path, scope.sessionKey)).toEqual(members);
        expect(projection.needsPreparation).toBe(false);
        expect(
          (await readSessionMembersInWorker(scope)).members.map((member) => member.identityId),
        ).toEqual(members);
        expect(
          readSessionEntryCache(database, { cache: true }).entries.get(scope.sessionKey)?.category,
        ).toBe(mutation === "category" ? undefined : " Work ");
        expect(projection.groupTargets().has("Work")).toBe(mutation !== "category");
      } finally {
        open.mockRestore();
        corruptReceipt.mockRestore();
        stop();
        projection.dispose();
      }
    });
  },
);

it.each(["agent", "profile"] as const)(
  "publishes a committed owner assignment through an unrelated %s invalidation",
  async (notice) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:scoped-owner-receipt",
      };
      const entry = {
        sessionId: "scoped-owner-receipt",
        lifecycleRevision: "current-generation",
        updatedAt: 1,
      };
      replaceSessionEntrySync(scope, entry);
      const assignedBy = { type: "human" as const, id: "assigner" };
      const previousOwner = {
        actor: { type: "human" as const, id: "previous-owner" },
        assignedBy,
        assignedAt: 1,
      };
      assignSessionOwner(scope, { owner: previousOwner.actor, assignedBy, assignedAt: 1 });
      const source = readOpenClawAgentDatabaseIdentity(database);
      if (typeof source.identity !== "string") {
        throw new Error("Expected durable owner fixture");
      }
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${source.identity}`,
        sessionKey: scope.sessionKey,
        entry: { ...entry, owner: previousOwner },
        membership: new Set(),
      });
      expect(sharing.readCurrent()?.entry?.owner).toEqual(previousOwner);
      const nextOwner = {
        actor: { type: "human" as const, id: "committed-owner" },
        assignedBy,
        assignedAt: 2,
      };
      const publications: unknown[] = [];
      const stop = sessionChanges.subscribeProjection((change) => {
        if (
          "sessionKey" in change &&
          change.sessionKey === scope.sessionKey &&
          change.facts?.kind === "owner"
        ) {
          publications.push({
            owner: change.facts.owner,
            retained: sharing.readCurrent()?.entry?.owner,
          });
        }
      });
      let committedReceipts = 0;
      const observeCommitted = workerAdmission.observeSqliteWorkerCommittedFacts;
      const unrelated = vi
        .spyOn(workerAdmission, "observeSqliteWorkerCommittedFacts")
        .mockImplementation((admission, observer) =>
          observeCommitted(admission, (receipt) => {
            if (
              isRecord(receipt.facts) &&
              receipt.facts.kind === "session-collaboration-committed"
            ) {
              committedReceipts++;
              if (notice === "profile") {
                emitUserProfilesChanged();
              } else {
                sessionChanges.emit({
                  all: true,
                  scope: { agentId: "other" },
                  factsInvalidated: true,
                });
              }
            }
            observer(receipt);
          }),
        );
      try {
        await expect(
          assignSessionOwnerInWorker(scope, {
            owner: nextOwner.actor,
            assignedBy,
            assignedAt: 2,
            expectedSessionId: entry.sessionId,
          }),
        ).resolves.toEqual(nextOwner);
        expect(committedReceipts).toBe(1);
        expect(loadSessionEntry(scope)?.owner).toEqual(nextOwner);
        expect(sharing.readCurrent()?.entry?.owner).toEqual(nextOwner);
        expect(publications).toEqual([{ owner: nextOwner, retained: nextOwner }]);
      } finally {
        unrelated.mockRestore();
        stop();
        sharing.release();
      }
    });
  },
);
