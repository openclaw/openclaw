import { performance } from "node:perf_hooks";
import { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import {
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { persistRegistryFixture } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  assignSessionOwner,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import * as entryCache from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { updateSessionGroupCategoriesInWorker } from "../config/sessions/session-group-categories.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionRowDatabaseFacts } from "../config/sessions/session-transcript-worker.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-contract.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentWorkers from "../state/openclaw-agent-worker-store.js";
import { setDisplayName } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { prepareGatewaySessionAccessAuthority } from "./session-access-authority.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { readSessionRowModelFacts } from "./session-row-model-facts.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import { listProjectedSessions } from "./session-utils-list.js";
import * as rowInputs from "./session-utils-row.js";

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function observeRowFacts(
  wrap: (
    owner: history.SessionHistoryWorkerDatabase,
  ) => history.SessionHistoryWorkerDatabase["readRowFacts"],
  once = false,
) {
  const readDatabases = history.withSessionHistoryWorkerDatabases;
  const observe: typeof readDatabases = (databases, consume, lane) =>
    readDatabases(
      databases,
      (owners) =>
        consume(
          owners.map((owner) => ({
            ...owner,
            readRowFacts: wrap(owner),
          })),
        ),
      lane,
    );
  const spy = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
  return once ? spy.mockImplementationOnce(observe) : spy.mockImplementation(observe);
}

it.each([{ workMs: 20, rowCount: 65 }])(
  "accepts $rowCount rows once with $workMs ms of materialization work",
  async ({ workMs, rowCount }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const keys = Array.from(
        { length: rowCount },
        (_, index) => `agent:main:row-facts-slice-${String(index).padStart(2, "0")}`,
      );
      const entries = keys.map((key, index) => ({
        scope: { agentId: "main", sessionKey: key },
        entry: { sessionId: `row-facts-slice-${index}`, updatedAt: 1, label: `initial-${index}` },
      }));
      for (const { scope, entry } of entries) {
        replaceSessionEntrySync(scope, entry);
      }
      const releaseForeground = retainSessionListForegroundWork();
      try {
        const projection = await createSessionRowProjection({
          cfg: { agents: { entries: { main: {} } } },
          modelCatalog: [],
        });
        try {
          await projection.ensureMaterialized();
          expect(projection.dirtyRowCount).toBe(0);
          const before = projection.materializedCount;
          const reads: Array<{ sessionKeys: string[]; rows: SessionRowDatabaseFacts[] }> = [];
          const databases = observeRowFacts((owner) => async (input) => {
            const reply = await owner.readRowFacts(input);
            reads.push({
              sessionKeys: [...input.sessionKeys],
              rows: structuredClone(reply.rows),
            });
            return reply;
          });
          let elapsed = 0;
          const acceptance: number[] = [];
          let accepting = 0;
          const acquireEntry = records.acquireSessionRowEntry;
          const acquisition = vi
            .spyOn(records, "acquireSessionRowEntry")
            .mockImplementation((params) => {
              accepting++;
              return acquireEntry(params);
            });
          const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
          const materializedKeys: string[] = [];
          const readInputs = rowInputs.readSessionRowInputs;
          const inputs = vi
            .spyOn(rowInputs, "readSessionRowInputs")
            .mockImplementation((params) => {
              if (accepting) {
                acceptance.push(accepting);
                accepting = 0;
              }
              const result = readInputs(params);
              materializedKeys.push(params.key);
              elapsed += workMs;
              return result;
            });
          let publications = 0;
          const stop = sessionChanges.subscribeProjection(() => publications++);
          try {
            for (const [index, { scope, entry }] of entries.entries()) {
              replaceSessionEntrySync(scope, { ...entry, updatedAt: 2, label: `latest-${index}` });
            }
            expect(projection.dirtyRowCount).toBe(rowCount);
            const published = publications;
            expect(published).toBe(rowCount);
            // Each commit accepts its prepared entry before the worker refreshes database facts.
            expect(accepting).toBe(rowCount);
            expect(acceptance).toEqual([]);
            expect(reads).toEqual([]);
            expect(materializedKeys).toEqual([]);
            accepting = 0;

            // Advance the clock only after real materialization; Worker replies remain real.
            // Avoid keyed reads until the drain settles so they cannot consume the suffix.
            const hostReads = observeSqliteReadSql(StatementSync.prototype);
            try {
              await projection.ensureMaterialized();
              expect(
                hostReads.queries.filter((sql) =>
                  /session_nodes|session_members|board_tabs|transcript_rewrite_watermarks/.test(
                    sql,
                  ),
                ),
              ).toEqual([]);
            } finally {
              hostReads.restore();
            }

            expect(publications).toBe(published);
            expect(materializedKeys).toEqual(keys);
            expect(projection.materializedCount - before).toBe(rowCount);
            expect(projection.dirtyRowCount).toBe(0);
            const batches = rowCount <= 64 ? [keys] : [keys.slice(0, 64), keys.slice(64)];
            expect(reads.map((read) => read.sessionKeys)).toEqual(batches);
            expect(reads.flatMap((read) => read.rows)).toHaveLength(rowCount);
            expect(acceptance).toEqual(batches.map((batch) => batch.length));
            for (const [index, { scope, entry }] of entries.entries()) {
              expect(
                projection.snapshot({ agentId: scope.agentId, key: scope.sessionKey }).row,
              ).toEqual(
                expect.objectContaining({ sessionId: entry.sessionId, label: `latest-${index}` }),
              );
            }
          } finally {
            stop();
            inputs.mockRestore();
            clock.mockRestore();
            acquisition.mockRestore();
            databases.mockRestore();
          }
        } finally {
          projection.dispose();
        }
      } finally {
        releaseForeground();
      }
    });
  },
);

it.each([
  { rowCount: 2, first: "bulk" },
  { rowCount: 2, first: "exact" },
] as const)(
  "shares $rowCount dirty row reads with $first preparation first",
  async ({ rowCount, first }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const rows = Array.from({ length: rowCount }, (_, index) => ({
        query: { agentId: "main", key: `agent:main:shared-row-read-${index}` },
        entry: { sessionId: `shared-row-read-${index}`, updatedAt: 1, label: "Previous" },
      }));
      for (const { query, entry } of rows) {
        replaceSessionEntrySync({ agentId: query.agentId, sessionKey: query.key }, entry);
      }
      const releaseForeground = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const pending: Promise<unknown>[] = [];
      try {
        await projection.ensureMaterialized();
        const reads: string[][] = [];
        observeRowFacts((owner) => async (input) => {
          reads.push([...input.sessionKeys]);
          const reply = await owner.readRowFacts(input);
          entered.resolve();
          await release.promise;
          return reply;
        });
        for (const { query, entry } of rows) {
          replaceSessionEntrySync(
            { agentId: query.agentId, sessionKey: query.key },
            { ...entry, updatedAt: 2, label: "Committed" },
          );
        }
        const selected = rows[0]!;
        const describe = () =>
          withReadySessionRows(
            projection,
            () => [selected.query],
            (read) => read.describe(selected.query)?.entry,
          );
        const firstRead = first === "bulk" ? projection.ensureMaterialized() : describe();
        pending.push(firstRead);
        await entered.promise;
        const secondRead = first === "bulk" ? describe() : projection.ensureMaterialized();
        pending.push(secondRead);
        release.resolve();
        const description = await (first === "bulk" ? secondRead : firstRead);
        expect(description).toMatchObject({
          sessionId: selected.entry.sessionId,
          label: "Committed",
        });
        await Promise.all(pending);
        expect(reads.flat().toSorted()).toEqual(rows.map(({ query }) => query.key));
        for (const { query, entry } of rows) {
          expect(projection.snapshot(query).row).toMatchObject({
            sessionId: entry.sessionId,
            label: "Committed",
          });
        }
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
        projection.dispose();
        releaseForeground();
      }
    });
  },
);

it("preserves a keyed replacement while an older worker reply is pending", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const query = { agentId: "main", key: "agent:main:worker-replacement" };
    const entry = { sessionId: "original", updatedAt: 1 };
    replaceSessionEntrySync({ agentId: query.agentId, sessionKey: query.key }, entry);
    const releaseForeground = retainSessionListForegroundWork();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let reading: Promise<void> | undefined;
    const projection = await createSessionRowProjection({
      cfg: { agents: { entries: { main: {} } } },
    });
    try {
      await projection.ensureMaterialized();
      observeRowFacts(
        (owner) => async (input) => {
          const reply = await owner.readRowFacts(input);
          entered.resolve();
          await release.promise;
          return reply;
        },
        true,
      );
      sessionChanges.emit({ agentId: query.agentId, sessionKey: query.key });
      reading = projection.ensureMaterialized();
      await entered.promise;
      // A direct reader can discover a new lifecycle independently of bulk publication.
      vi.spyOn(entryCache, "readCommittedSessionEntryCache").mockReturnValueOnce(
        new Map([[query.key, { ...entry, sessionId: "replacement" }]]),
      );
      const replacement = projection.describe(query);
      expect(replacement?.entry.sessionId).toBe("replacement");
      release.resolve();
      await reading;
      expect(projection.isCurrent(replacement!)).toBe(true);
      expect(projection.snapshot(query).row?.sessionId).toBe("replacement");
    } finally {
      release.resolve();
      await reading;
      projection.dispose();
      releaseForeground();
    }
  });
});

it.each([false, true])(
  "keeps an unrelated exact read while a lost category reply reconciles its changed row (structural pending: %s)",
  async (structuralPending) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } } satisfies OpenClawConfig;
      const owner = ensureProfileForEmail("category-owner@example.test");
      const a = { agentId: "main", key: "agent:main:category-unrelated" };
      const b = { agentId: "main", key: "agent:main:category-changed" };
      const c = { agentId: "main", key: "agent:main:category-structural" };
      for (const query of structuralPending ? [a, b, c] : [a, b]) {
        replaceSessionEntrySync(
          { agentId: query.agentId, sessionKey: query.key },
          {
            sessionId: query.key,
            updatedAt: 1,
            label: query === a ? "Unrelated row" : "Changed row",
            ...(query === b ? { category: "Work" } : {}),
            createdActor: { type: "human", source: "profile", id: owner.id },
          },
        );
      }
      const releaseForeground = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] }).catch(
        (error: unknown) => {
          releaseForeground();
          throw error;
        },
      );
      const capturedA = createDeferredCore();
      const repeatedA = createDeferredCore();
      const releaseA = createDeferredCore();
      const capturedB = createDeferredCore();
      const releaseB = createDeferredCore();
      const pending: Promise<unknown>[] = [];
      let sql: ReturnType<typeof observeHostDataSql> | undefined;
      let authority: Awaited<ReturnType<typeof prepareGatewaySessionAccessAuthority>> | undefined;
      let resource: ReturnType<NonNullable<typeof authority>["retainSession"]> | undefined;
      try {
        await projection.ensureMaterialized();
        const context = bindSessionRowProjection(requestContext(cfg), () => projection);
        authority = await prepareGatewaySessionAccessAuthority({
          policy: { mode: "write" },
          requestParams: { agentId: b.agentId, sessionKey: b.key },
          client: identifiedClient(owner.id),
          context,
          ownSessionOnly: true,
        });
        resource = authority.retainSession();
        const generation = projection.capture(b)?.generation;
        expect(generation).toBeDefined();
        if (structuralPending) {
          // This unknown structural publication predates category.prepare, so the
          // producer's later publication fence cannot know it invalidated lineage.
          sessionChanges.emit({ sessionKey: c.key, factsInvalidated: true });
          expect(projection.capture(c)?.unresolvedDatabaseFacts).toBe(true);
        }
        const reads: string[][] = [];
        observeRowFacts((database) => async (input) => {
          reads.push([...input.sessionKeys]);
          const reply = await database.readRowFacts(input);
          if (input.sessionKeys.includes(a.key)) {
            if (reads.filter((keys) => keys.includes(a.key)).length === 1) {
              capturedA.resolve();
              await releaseA.promise;
            } else {
              repeatedA.resolve();
            }
          }
          if (structuralPending && input.sessionKeys.includes(c.key)) {
            await releaseB.promise;
          }
          if (input.sessionKeys.includes(b.key)) {
            capturedB.resolve();
            await releaseB.promise;
          }
          return reply;
        });
        const describe = (query: typeof a) =>
          withReadySessionRows(
            projection,
            () =>
              query === a && !structuralPending
                ? projection.selectEntries({ sessionIdOrKey: a.key }).map((row) => ({
                    agentId: row.agentId,
                    key: row.key,
                    storePath: row.storeTarget.storePath,
                  }))
                : [query],
            (read) => read.describe(query)?.entry,
          );
        // Capture A's real database reply before B's independent committed mutation.
        sessionChanges.emit({ agentId: a.agentId, sessionKey: a.key });
        const readingA = describe(a);
        pending.push(readingA);
        await Promise.race([
          capturedA.promise,
          readingA.then(() => {
            throw new Error("Exact read bypassed its held database facts");
          }),
        ]);

        const failure = new SqliteWorkerError(
          "category reply lost after commit",
          "outcome-unknown",
        );
        const original = agentWorkers.openOpenClawAgentSqliteWorkerStore;
        let applies = 0;
        vi.spyOn(agentWorkers, "openOpenClawAgentSqliteWorkerStore").mockImplementation(
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
                        if (command.type === "category.apply") {
                          applies++;
                          // The real write has settled; expose the existing uncertainty path.
                          sql = observeHostDataSql();
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
        const changing = updateSessionGroupCategoriesInWorker({
          scope: { agentId: b.agentId, sessionKey: b.key },
          from: "Work",
        });
        pending.push(changing);
        await expect(changing).rejects.toBe(failure);
        const readingB = describe(b);
        pending.push(readingB);
        await Promise.race([
          capturedB.promise,
          readingB.then(() => {
            throw new Error("Changed row bypassed its held reconciliation");
          }),
        ]);
        if (!structuralPending) {
          expect.soft(projection.sharingTargetState(b)).toEqual({ status: "pending" });
          expect.soft(() => resource!.assertCurrent()).toThrow("refreshing");
        }
        expect(resource.signal.aborted).toBe(false);

        releaseA.resolve();
        const boundary = await Promise.race([
          readingA.then(() => "response"),
          repeatedA.promise.then(() => "unrelated row read again"),
        ]);
        expect.soft(boundary).toBe(structuralPending ? "unrelated row read again" : "response");
        releaseB.resolve();
        expect(await readingA).toMatchObject({ sessionId: a.key, label: "Unrelated row" });
        const changed = await readingB;
        expect(changed).toMatchObject({ sessionId: b.key, label: "Changed row" });
        expect(changed?.category).toBeUndefined();
        await projection.prepareMembership();
        expect(projection.sharingTargetState(b)).toMatchObject({ status: "ready" });
        expect(projection.capture(b)?.generation).toBe(generation);
        expect(() => resource!.assertCurrent()).not.toThrow();
        expect(resource.signal.aborted).toBe(false);
        expect(applies).toBe(1);
        expect
          .soft(reads.filter((keys) => keys.includes(a.key)))
          .toEqual(structuralPending ? [[a.key], [a.key]] : [[a.key]]);
        expect(sql).toBeDefined();
        expect(sql!.queries).toEqual([]);
      } finally {
        releaseA.resolve();
        releaseB.resolve();
        await Promise.allSettled(pending);
        resource?.release();
        authority?.release();
        await projection.ensureMaterialized().catch(() => undefined);
        sql?.restore();
        projection.dispose();
        releaseForeground();
      }
    });
  },
);

it.each([
  "profile display",
  "run publication",
  "capacity transition",
  "collector publication",
  "membership revocation",
  "runtime stored facts",
  "invalidated presentation facts",
  "unrelated stored row",
  "captured sibling row",
] as const)("consumes current list facts across an awaited worker reply: %s", async (change) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const changesOwner =
      change === "runtime stored facts" || change === "invalidated presentation facts";
    const changesSibling = change === "unrelated stored row" || change === "captured sibling row";
    const requiresFreshRead = change === "membership revocation" || changesOwner;
    const scope = { agentId: "main", sessionKey: "agent:main:worker-fact-freshness" };
    const owner = ensureProfileForEmail("projection-owner@example.test");
    const viewer = ensureProfileForEmail("projection-viewer@example.test");
    setDisplayName(owner.id, "Initial owner");
    const entry = {
      sessionId: "worker-fact-freshness",
      updatedAt: 1,
      label: "Previous stored label",
      visibility: "read-only" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
    };
    replaceSessionEntrySync(scope, entry);
    const unrelated = { agentId: "main", sessionKey: "agent:main:worker-fact-unrelated" };
    if (changesSibling) {
      replaceSessionEntrySync(unrelated, { sessionId: "unrelated", updatedAt: 0 });
    }
    addSessionMember(scope, { identityId: viewer.id, addedBy: owner.id, addedAt: 1 });
    const releaseForeground = retainSessionListForegroundWork();
    try {
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const client = identifiedClient(viewer.id);
      const request = { agentId: "main", limit: 1 };
      const runId = "worker-fact-freshness-run";
      const captured = createDeferredCore();
      const releaseFirst = createDeferredCore();
      const repeated = createDeferredCore();
      const releaseRepeated = createDeferredCore();
      let reading: ReturnType<typeof listSessions> | undefined;
      let releaseCapacity: (() => void) | undefined;
      let collector: SubagentRunRecord | undefined;
      try {
        await projection.ensureMaterialized();
        expect((await listSessions({ client, context, request })).sessions).toEqual([
          expect.objectContaining({
            key: scope.sessionKey,
            label: entry.label,
            sharingRole: "member",
            createdActor: expect.objectContaining({ label: "Initial owner" }),
            owner: expect.objectContaining({ actor: expect.objectContaining({ id: owner.id }) }),
          }),
        ]);
        let first = true;
        observeRowFacts((database) => async (input) => {
          const reply = await database.readRowFacts(input);
          if (first) {
            if (change === "captured sibling row") {
              expect(input.sessionKeys).toContain(unrelated.sessionKey);
            }
            first = false;
            captured.resolve();
            await releaseFirst.promise;
          } else if (input.sessionKeys.includes(scope.sessionKey)) {
            repeated.resolve();
            await releaseRepeated.promise;
          }
          return reply;
        });
        replaceSessionEntrySync(scope, { ...entry, updatedAt: 2, label: "Fresh stored label" });
        if (change === "captured sibling row") {
          replaceSessionEntrySync(unrelated, {
            sessionId: "unrelated",
            updatedAt: 0,
            label: "Previous sibling",
          });
        }
        reading = listSessions({ client, context, request });
        await Promise.race([
          captured.promise,
          reading.then(() => {
            throw new Error("List bypassed pending dirty row facts");
          }),
        ]);
        if (changesSibling) {
          replaceSessionEntrySync(unrelated, {
            sessionId: "unrelated",
            updatedAt: 0,
            label: "Current sibling",
          });
        } else if (change === "profile display") {
          setDisplayName(owner.id, "Current owner");
        } else if (change === "run publication" || change === "capacity transition") {
          registerAgentRunContext(runId, {
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
            sessionId: entry.sessionId,
            projectSessionActive: true,
          });
          if (change === "capacity transition") {
            releaseCapacity = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
            expect(releaseCapacity).toBeDefined();
          }
        } else if (change === "collector publication") {
          collector = {
            runId,
            childSessionKey: "agent:main:subagent:worker-fact-child",
            requesterSessionKey: scope.sessionKey,
            requesterDisplayKey: scope.sessionKey,
            requesterAgentId: scope.agentId,
            swarmRequesterSessionKey: scope.sessionKey,
            groupId: "worker-fact-group",
            collect: true,
            task: "Synthetic projection proof",
            cleanup: "keep",
            createdAt: 1,
            execution: { status: "running", startedAt: 1 },
            completion: { required: false },
            delivery: { status: "not_required" },
          };
          subagentRuns.set(runId, collector);
          subagentRuns.commitOwnership(collector);
          persistRegistryFixture(subagentRuns, [runId]);
        } else if (changesOwner) {
          const emit = sessionChanges.emit.bind(sessionChanges);
          let publicationObserved = false;
          vi.spyOn(sessionChanges, "emit").mockImplementation((publication, database) => {
            if (
              "sessionKey" in publication &&
              publication.sessionKey === scope.sessionKey &&
              publication.facts?.kind === "owner"
            ) {
              publicationObserved = true;
              if (change === "runtime stored facts") {
                publication.scope = "runtime";
              } else {
                emit({ all: true, scope: "profiles", factsInvalidated: true }, database);
                return;
              }
            }
            emit(publication, database);
          });
          expect(
            assignSessionOwner(scope, {
              owner: { type: "agent", id: "main" },
              assignedBy: { type: "system", id: "test" },
              assignedAt: 3,
            }),
          ).not.toBeNull();
          expect(publicationObserved).toBe(true);
        } else {
          expect(removeSessionMember(scope, viewer.id)).not.toBeNull();
        }
        if (requiresFreshRead) {
          releaseRepeated.resolve();
        }
        releaseFirst.resolve();
        if (!requiresFreshRead) {
          const boundary = await Promise.race([
            reading.then(() => "response"),
            repeated.promise.then(() => "unchanged database facts read again"),
          ]);
          expect(boundary).toBe("response");
        }
        const result = await reading;
        if (changesSibling) {
          expect(
            projection.snapshot({ agentId: unrelated.agentId, key: unrelated.sessionKey }).row
              ?.label,
          ).toBe("Current sibling");
        }
        expect(result.sessions).toEqual([
          expect.objectContaining({
            key: scope.sessionKey,
            sessionId: entry.sessionId,
            label: "Fresh stored label",
            sharingRole: change === "membership revocation" ? "viewer" : "member",
            createdActor: expect.objectContaining({
              label: change === "profile display" ? "Current owner" : "Initial owner",
            }),
            ...(changesOwner
              ? {
                  owner: expect.objectContaining({
                    actor: expect.objectContaining({ type: "agent", id: "main" }),
                    assignedAt: 3,
                  }),
                }
              : {}),
            ...(change === "run publication" ? { hasActiveRun: true, status: "running" } : {}),
            ...(change === "capacity transition" ? { hasActiveRun: true, status: "queued" } : {}),
            ...(change === "collector publication"
              ? {
                  swarm: expect.objectContaining({
                    groups: [expect.objectContaining({ groupId: "worker-fact-group", running: 1 })],
                  }),
                }
              : {}),
          }),
        ]);
      } finally {
        releaseFirst.resolve();
        releaseRepeated.resolve();
        await Promise.allSettled(reading ? [reading] : []);
        projection.dispose();
        releaseCapacity?.();
        clearAgentRunContext(runId);
        if (collector && subagentRuns.get(runId) === collector) {
          subagentRuns.delete(runId);
          persistRegistryFixture(subagentRuns, [runId]);
        }
      }
    } finally {
      releaseForeground();
    }
  });
});

it("keeps the stored main address and ACP runtime after mainKey changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfgBefore = {
      agents: { ownership: "explicit", entries: { main: {} } },
      session: { mainKey: "main" },
    } satisfies OpenClawConfig;
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    const entry = {
      sessionId: "stored-main",
      lifecycleRevision: "stored-main-first",
      updatedAt: 1,
    };
    await state.writeConfig(cfgBefore);
    state.applyEnv();
    replaceSessionEntrySync(target, entry);
    const meta = {
      backend: "fixture-backend",
      agent: "fixture-harness",
      runtimeSessionName: "stored-main-runtime",
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 2,
    };
    expect(
      await upsertAcpSessionMeta({
        ...target,
        cfg: cfgBefore,
        env: state.env,
        now: () => 2,
        mutate: () => meta,
      }),
    ).toMatchObject({ sessionId: entry.sessionId, acp: meta });
    const stored = loadSessionEntry(target);
    if (!stored) {
      throw new Error("Expected the ACP writer to retain its session entry");
    }
    expect(stored.acp).toBeUndefined();
    expect(
      await readAcpSessionMetaForEntries({
        cfg: cfgBefore,
        env: state.env,
        entries: [{ ...target, entry: stored }],
      }),
    ).toEqual([meta]);

    const cfgAfter = { ...cfgBefore, session: { mainKey: "work" } };
    await state.writeConfig(cfgAfter);
    state.applyEnv();
    expect(loadSessionEntry(target)).toEqual(stored);
    expect(
      await readAcpSessionMetaForEntries({
        cfg: cfgAfter,
        env: state.env,
        entries: [{ ...target, entry: stored }],
      }),
    ).toEqual([meta]);
    expect(resolveSessionStoreKey({ cfg: cfgAfter, ...target })).toBe("agent:main:work");

    const releaseForeground = retainSessionListForegroundWork();
    let projection: SessionRowProjection | undefined;
    try {
      projection = await createSessionRowProjection({ cfg: cfgAfter, modelCatalog: [] });
      const facts = readSessionRowModelFacts({
        cfg: cfgAfter,
        key: target.sessionKey,
        agentId: target.agentId,
        entry: stored,
        source: { entry: stored, readSourceEntry: () => undefined },
        rowContext: projection.state.rowContext,
        modelCatalog: [],
      });
      expect(facts.thinkingProjection.acpMeta).toEqual(meta);
      const result = await listProjectedSessions({ projection, opts: { agentId: "main" } });
      expect(result.sessions).toEqual([
        expect.objectContaining({
          key: target.sessionKey,
          sessionId: entry.sessionId,
          runtimeSelectionLocked: true,
        }),
      ]);
    } finally {
      projection?.dispose();
      releaseForeground();
    }
  });
});

it("refreshes prepared ACP metadata on publication and fences replacement lifecycles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:acp:worker-row";
    const cfg = { agents: { entries: { main: {} } } };
    const target = { agentId: "main", sessionKey: key };
    replaceSessionEntrySync(target, {
      sessionId: "worker-row",
      lifecycleRevision: "first",
      updatedAt: 1,
    });
    const releaseForeground = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row?.runtimeSelectionLocked).toBe(false);
      for (const backend of ["acpx", "replacement-acp-backend"]) {
        // Released free-runtime aliases are case-insensitive and read-only compatible.
        writeAcpSessionMetaForMigration({
          sessionKey: key.toUpperCase(),
          lifecycleRevision: "first",
          meta: {
            backend,
            agent: "main",
            runtimeSessionName: "worker-row",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 1,
          },
        });
        const reads = observeSqliteReadSql(StatementSync.prototype);
        try {
          await projection.ensureMaterialized();
          expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
            runtimeSelectionLocked: true,
            agentRuntime: { id: backend, source: "session-key" },
          });
          expect(reads.queries.filter((sql) => sql.includes("acp_sessions"))).toEqual([]);
        } finally {
          reads.restore();
        }
      }
      replaceSessionEntrySync(target, {
        sessionId: "worker-row",
        lifecycleRevision: "replacement",
        updatedAt: 2,
      });
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row?.runtimeSelectionLocked).toBe(false);
    } finally {
      projection.dispose();
      releaseForeground();
    }
  });
});
