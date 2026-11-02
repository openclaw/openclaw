import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
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
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import {
  SqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerOperations,
} from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import * as agentWorkers from "../../state/openclaw-agent-worker-store.js";
import { emitUserProfilesChanged } from "../../state/user-profile-events.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { retainPreparedSessionSharingFacts } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { readCommittedSessionEntryCache } from "./session-accessor.sqlite-entry-cache.test-support.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { captureDurableSessionActor } from "./session-actor-durable.js";
import { readSessionActorEntryFacts } from "./session-actor-replica.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import { updateSessionGroupCategoriesInWorker } from "./session-group-categories.js";
import { assignSessionOwnerInWorker } from "./session-metadata-write.async.js";
import { recordSessionParticipantInWorker as recordSessionParticipant } from "./session-sharing-store.async.js";
import {
  addSessionMember,
  readSessionMembersInWorker,
  removeSessionMember,
} from "./session-sharing-store.js";
import { bindSqliteWorkerBackend } from "./session-sharing-store.worker.js";
import { historyLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

function memberRow(identityId: string, addedAt: number, addedBy = "owner") {
  return { identityId, addedBy, addedAt };
}

const withState = (run: (state: OpenClawTestState) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, run);
const mainScope = (name: string, storePath?: string) => ({
  agentId: "main",
  sessionKey: `agent:main:${name}`,
  ...(storePath ? { storePath } : {}),
});
const readMembers = async (scope: Parameters<typeof readSessionMembersInWorker>[0]) =>
  (await readSessionMembersInWorker(scope)).members;
async function readContext() {
  const ctx = context(vi.fn());
  await initializeSessionReadContext(ctx);
  return ctx;
}

it.each(["session.members.list", "session.members.listEvidence"] as const)(
  "%s reads current cached membership while transcript reads wait",
  async (method) => {
    await withState(async () => {
      await captureRuntimeConfigAsyncReader()();
      const scope = mainScope("worker-members");
      const entry = { sessionId: "worker-members", updatedAt: 1 };
      await patchSessionEntryCore(scope, () => entry, {
        fallbackEntry: entry,
        skipMaintenance: true,
      });
      const evidenceAware = method === "session.members.listEvidence";
      const zoe = memberRow("zoe", 2, evidenceAware ? "actor-evidence:unknown" : "owner");
      const alice = memberRow("alice", 3, evidenceAware ? "actor-evidence:unattributed" : "owner");
      await addSessionMember(scope, zoe);
      await addSessionMember(scope, alice);
      const expected = evidenceAware
        ? [
            { identityId: "alice", addedAt: 3 },
            { identityId: "zoe", addedByState: "unknown", addedAt: 2 },
          ]
        : [alice, zoe];
      const requestContext = await readContext();
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
      const sql = observeHostDataSql();
      let membersRead: ReturnType<typeof call> | undefined;
      try {
        await Promise.race([historyEntered.promise, historyRead]);
        expect(historyRequests).toBe(1);
        for (let round = 0; round < 2; round++) {
          membersRead = call(method, { sessionKey: scope.sessionKey }, requestContext);
          expect(
            await Promise.race([
              membersRead.then((responses) => responses[0]?.[1]),
              historyContended.promise.then(() => ({ blockedByTranscript: true })),
            ]),
          ).toMatchObject({ members: expected });
          if (evidenceAware && round === 0) {
            expect(sql.queries).toEqual([]);
          }
          expect(
            sql.queries.filter((query) => /from ["`]?session_members["`]?/i.test(query)),
          ).toEqual([]);
          sql.queries.length = 0;
        }
      } finally {
        sql.restore();
        releaseHistory.resolve();
        await Promise.allSettled([historyRead, membersRead]);
        historyRun.mockRestore();
      }
      expect(await historyRead).toBe(true);
      await addSessionMember(scope, memberRow("bob", 4));
      expect(await readMembers(scope)).toEqual([alice, memberRow("bob", 4), zoe]);
      const missing = { agentId: "missing", sessionKey: "agent:missing:main" };
      expect(await readMembers(missing)).toEqual([]);
      expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "missing" }))).toBe(false);
    });
  },
);

it("retains the physical owner and logical partition of a shared member store", async () => {
  await withState(async (state) => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: state.statePath("shared-members.sqlite"),
    });
    const scope = { agentId: "other", sessionKey: "agent:other:members", storePath: database.path };
    await upsertSessionEntryCore(scope, { sessionId: "other-members", updatedAt: 1 });
    await addSessionMember(scope, memberRow("other-guest", 2, "other-owner"));
    const sibling = { ...scope, agentId: "main", sessionKey: "agent:main:members" };
    await upsertSessionEntryCore(sibling, { sessionId: "main-members", updatedAt: 1 });
    await addSessionMember(sibling, memberRow("main-guest", 3, "main-owner"));
    expect(await readMembers(scope)).toEqual([memberRow("other-guest", 2, "other-owner")]);
    expect(database.agentId).toBe("main");
  });
});

it("keeps process-local incognito membership with its native owner", async () => {
  await withState(async () => {
    const scope = mainScope("dashboard:incognito-members");
    expect(await readMembers(scope)).toEqual([]);
    await upsertSessionEntryCore(scope, {
      sessionId: "incognito-members",
      updatedAt: 1,
      incognito: true,
    });
    await addSessionMember(scope, memberRow("guest", 2));
    expect(await readMembers(scope)).toEqual([memberRow("guest", 2)]);
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

it("rechecks the current manager after the membership read yields", async () => {
  await withState(async () => {
    await captureRuntimeConfigAsyncReader()();
    const scope = mainScope("member-reader-authority");
    await upsertSessionEntryCore(scope, {
      sessionId: "member-reader-authority",
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: "owner" },
    });
    await addSessionMember(scope, memberRow("guest", 2));
    const client = identifiedClient("owner");
    const requestContext = await readContext();
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
  await withState(async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const alias = state.path("member-alias");
    fs.symlinkSync(path.dirname(database.path), alias, "junction");
    const scope = mainScope("worker-writes", path.join(alias, path.basename(database.path)));
    const entry = {
      sessionId: "worker-writes",
      updatedAt: 1,
      createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
    };
    replaceSessionEntrySync(scope, entry);
    const identity = readOpenClawAgentDatabaseIdentity(database);
    if (typeof identity.identity !== "string") {
      throw new Error("Participant publication proof requires a physical database");
    }
    const actorTarget = {
      sessionKey: scope.sessionKey,
      database: {
        kind: "file" as const,
        physicalIdentity: identity.identity,
        birthtime: identity.birthtime,
        nativeLocation: database.path,
      },
    };
    const authority = { assertCurrent() {}, assertReadable() {}, authorize() {} };
    let actor: ReturnType<typeof captureDurableSessionActor> | undefined;
    const expectedEntry = {
      sessionId: entry.sessionId,
      createdActor: entry.createdActor,
      visibility: undefined,
      incognito: undefined,
    };
    const changes: SessionRowChange[] = [];
    const expectFact = (facts: object) =>
      expect(changes.at(-1)).toMatchObject({ sessionKey: scope.sessionKey, facts });
    const peer = { type: "agent" as const, id: "peer" };
    const recordPeer = (promptedAt: number) =>
      recordSessionParticipant(scope, { identity: peer, promptedAt });
    const stop = sessionChanges.subscribeFacts((change) => changes.push(change));
    const participantLifecycle = vi.fn();
    const stopLifecycle = onSessionLifecycleEvent((event) => {
      if (event.sessionKey === scope.sessionKey && event.reason === "participants") {
        participantLifecycle(event);
      }
    });
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    const sql = observeHostDataSql();
    try {
      expect(
        await addSessionMember(scope, {
          ...memberRow("guest", 2),
          expectedSessionId: entry.sessionId,
          expectedEntry,
        }),
      ).toEqual({ inserted: true, member: memberRow("guest", 2) });
      expectFact({ kind: "member", identityId: "guest", present: true });
      expect(await recordPeer(3)).toBe("inserted");
      expectFact({
        kind: "participants",
        projection: { participants: [{ identity: peer }], participantCount: 1 },
      });
      actor = captureDurableSessionActor({
        database: { agentId: "main", path: database.path },
        target: actorTarget,
        lifetime: authority,
      });
      const before = await actor.read(authority);
      const publications = changes.length;
      expect(await recordPeer(4)).toBe("updated");
      expect(changes).toHaveLength(publications + 1);
      expectFact({
        kind: "participants",
        projectionChanged: false,
        records: [{ identity: peer, contributionCount: 2, firstPromptedAt: 3, lastPromptedAt: 4 }],
      });
      expect(changes.at(-1)).not.toHaveProperty("facts.projection");
      const after = actor.snapshot(authority);
      expect(after?.participants).toMatchObject([{ contributionCount: 2, lastPromptedAt: 4 }]);
      expect(after?.version).toEqual({ ...before.version, sequence: before.version.sequence + 1 });
      expect(readSessionActorEntryFacts(actorTarget)?.participants).toEqual(after?.participants);
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
      expect(await removeSessionMember(scope, "guest", undefined, entry.sessionId)).toEqual(
        memberRow("guest", 2),
      );
      expectFact({ kind: "member", identityId: "guest", present: false });
      expect(actor.snapshot(authority)).toBeUndefined();
      expect((await actor.read(authority)).participants).toEqual(after?.participants);
      expect(sql.queries).toEqual([]);
      expect(getOpenClawAgentDatabaseIfOpen({ agentId: "main" })).toBeUndefined();
    } finally {
      await actor?.release();
      stop();
      stopLifecycle();
      sql.restore();
    }
    expect(await readMembers(scope)).toEqual([]);
  });
});

it("prepares admitted category keys in one statement and observes committed replacements", async () => {
  await withState(async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    setCanonicalSqliteSessionMainKey(database, "main");
    const scope = mainScope("category-preparation", database.path);
    const entry = { sessionId: "category-preparation", updatedAt: 1, category: "Work" };
    replaceSessionEntrySync(scope, entry);
    const backend = bindSqliteWorkerBackend(undefined, {
      database: database.db,
      databasePath: database.path,
      admit: () => {},
    });
    const statements = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["all"],
      () => "all",
    );
    const transactions = vi.spyOn(database.db, "exec");
    try {
      const command = { type: "category.prepare" as const, input: { scope, from: "Work" } };
      expect(backend.execute(command)).toEqual([scope.sessionKey]);
      expect(statements.counts.all).toBe(1);
      expect(transactions.mock.calls).toEqual([]);
      replaceSessionEntrySync(scope, { ...entry, updatedAt: 2, category: "Personal" });
      statements.counts.all = 0;
      transactions.mockClear();
      expect(backend.execute(command)).toEqual([]);
      expect(statements.counts.all).toBe(1);
      expect(transactions.mock.calls).toEqual([]);
    } finally {
      transactions.mockRestore();
      statements.restore();
    }
  });
});

it("preserves entry changes and skips reassigned categories after preparation", async () => {
  await withState(async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const alias = state.path("category-alias");
    fs.symlinkSync(path.dirname(database.path), alias, "junction");
    const scope = mainScope("category-current", path.join(alias, path.basename(database.path)));
    const reassigned = { ...scope, sessionKey: "agent:main:category-reassigned" };
    const replaceCategory = (
      target: typeof scope,
      updatedAt = 1,
      category = "Work",
      label = "Before",
    ) =>
      replaceSessionEntrySync(target, { sessionId: target.sessionKey, updatedAt, category, label });
    [scope, reassigned].forEach((target) => replaceCategory(target));
    let changed = false;
    await expect(
      updateSessionGroupCategoriesInWorker({
        scope,
        from: "Work",
        assertTargetCurrent() {
          if (!changed) {
            changed = true;
            replaceCategory(scope, 2, "Work", "After");
            replaceCategory(reassigned, 3, "Replacement", "Reassigned");
          }
        },
      }),
    ).resolves.toBe(1);
    const entry = loadSessionEntry(scope);
    expect(entry).toMatchObject({ sessionId: scope.sessionKey, updatedAt: 2, label: "After" });
    expect(entry?.category).toBeUndefined();
    expect(loadSessionEntry(reassigned)).toMatchObject({
      sessionId: reassigned.sessionKey,
      updatedAt: 3,
      category: "Replacement",
      label: "Reassigned",
    });
  });
});

it.each([
  { mutation: "membership", receipt: "valid", closeBeforeFailure: false },
  { mutation: "category", receipt: "valid", closeBeforeFailure: false },
  { mutation: "membership", receipt: "conflicting", closeBeforeFailure: false },
  { mutation: "membership", receipt: "missing", closeBeforeFailure: false },
  { mutation: "membership", receipt: "missing", closeBeforeFailure: true },
] as const)(
  "settles committed $mutation with $receipt receipt when the ordinary worker reply is lost (host closed: $closeBeforeFailure)",
  async ({ mutation, receipt, closeBeforeFailure }) => {
    await withState(async (state) => {
      await captureRuntimeConfigAsyncReader()();
      const scope = mainScope(
        "lost-member-reply",
        mutation === "category" ? state.statePath("shared-category.sqlite") : undefined,
      );
      await upsertSessionEntryCore(scope, {
        sessionId: "lost-member-reply",
        updatedAt: 1,
        category: " Work ",
      });
      await addSessionMember(scope, memberRow("guest", 2));
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
      const committedCache = () =>
        readCommittedSessionEntryCache(requireNativeSqliteDatabase(database.db));
      const stop = sessionChanges.subscribeFacts((change) => {
        changes.push(change);
        cachesAtPublication.push(committedCache());
        projection.invalidate(change);
      });
      const cfg = { agents: { entries: { main: {} } }, session: { store: database.path } };
      const sharing = await prepareSessionMutationFacts({ cfg, ...scope });
      const unavailable = "Session access facts are unavailable";
      const expectUnavailable = () =>
        expect(prepareSessionMutationFacts({ cfg, ...scope })).rejects.toThrow(unavailable);
      const publishedMemberships: boolean[] = [];
      const stopPublic = sessionChanges.subscribe((change) => {
        if (
          receipt === "valid" &&
          "sessionKey" in change &&
          change.sessionKey === scope.sessionKey
        ) {
          publishedMemberships.push(sharing.readCurrent(cfg).membership.has("guest"));
        }
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
            const [databaseOptions, native, configuration] = args;
            const worker = await original<Operations>(databaseOptions, native, {
              ...configuration,
              onAdmitted(request) {
                configuration.onAdmitted?.(request);
                if (request.stage === "commit") {
                  expect(() => sharing.readCurrent(cfg)).toThrow(unavailable);
                }
              },
            });
            const intercept = async <T>(
              type: keyof Operations,
              run: () => Promise<T>,
            ): Promise<T> => {
              if (type !== (mutation === "category" ? "category.apply" : "remove")) {
                return run();
              }
              mutations++;
              await run();
              if (closeBeforeFailure) {
                expect(closeOpenClawAgentDatabaseByPath(database.path, database.agentId)).toBe(
                  true,
                );
                expect(database.db.isOpen).toBe(false);
              }
              throw failure;
            };
            const interrupted: typeof worker = {
              ...worker,
              execute(command, assertCurrent, options) {
                return intercept(command.type, () =>
                  worker.execute(command, assertCurrent, options),
                );
              },
              run(consume, assertCurrent) {
                return worker.run(
                  (operation) =>
                    consume({
                      execute(command, options) {
                        return intercept(command.type, () => operation.execute(command, options));
                      },
                    }),
                  assertCurrent,
                );
              },
            };
            return interrupted;
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
        expect(committedCache()?.get(scope.sessionKey)?.category).toBe(" Work ");
        if (receipt !== "valid") {
          const outcome = await run().then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(hasSqliteWorkerOutcomeUnknown(outcome)).toBe(true);
          expect(mutations).toBe(1);
          expect(projection.membership(database.path, scope.sessionKey)).toEqual([]);
          expect(projection.needsPreparation).toBe(true);
          if (closeBeforeFailure) {
            await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
          }
          expect(await readMembers(scope)).toEqual([]);
          expect(() => sharing.readCurrent(cfg)).toThrow(unavailable);
          await expectUnavailable();
          open.mockRestore();
          corruptReceipt.mockRestore();
          await addSessionMember(scope, memberRow("guest", 3));
          await expectUnavailable();
          return;
        }
        await expect(run()).resolves.toEqual(mutation === "category" ? 2 : memberRow("guest", 2));
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
        expect([...sharing.readCurrent(cfg).membership]).toEqual(members);
        expect(publishedMemberships).toEqual([mutation === "category"]);
        expect(projection.membership(database.path, scope.sessionKey)).toEqual(members);
        expect(projection.needsPreparation).toBe(false);
        expect((await readMembers(scope)).map((member) => member.identityId)).toEqual(members);
        expect(
          readSessionEntryCache(database, { cache: true }).entries.get(scope.sessionKey)?.category,
        ).toBe(mutation === "category" ? undefined : " Work ");
        expect(projection.groupTargets().has("Work")).toBe(mutation !== "category");
      } finally {
        stopPublic();
        sharing.release();
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
    await withState(async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = mainScope("scoped-owner-receipt", database.path);
      const entry = {
        sessionId: "scoped-owner-receipt",
        lifecycleRevision: "current-generation",
        updatedAt: 1,
      };
      replaceSessionEntrySync(scope, entry);
      const assignedBy = { type: "human" as const, id: "assigner" };
      const ownerRecord = (id: string, assignedAt: number) => ({
        actor: { type: "human" as const, id },
        assignedBy,
        assignedAt,
      });
      const previousOwner = ownerRecord("previous-owner", 1);
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
      const nextOwner = ownerRecord("committed-owner", 2);
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
