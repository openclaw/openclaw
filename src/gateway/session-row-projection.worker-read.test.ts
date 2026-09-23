import { performance } from "node:perf_hooks";
import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  assignSessionOwner,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import * as entryCache from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionRowDatabaseFacts } from "../config/sessions/session-transcript-worker.types.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail, setDisplayName } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import * as databaseFactsRead from "./session-row-projection-read.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as rowInputs from "./session-utils-row.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { workMs: 0, rowCount: 2 },
  { workMs: 20, rowCount: 2 },
  { workMs: 20, rowCount: 65 },
])(
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
          cfg: { agents: { list: [{ id: "main", default: true }] } },
          modelCatalog: [],
        });
        try {
          await projection.ensureMaterialized();
          expect(projection.dirtyRowCount).toBe(0);
          const before = projection.materializedCount;
          const dirtyVisits: number[] = [];
          const readFacts = databaseFactsRead.withSessionRowDatabaseFacts;
          const selection = vi
            .spyOn(databaseFactsRead, "withSessionRowDatabaseFacts")
            .mockImplementation(async (owner, consume) => {
              let visited = 0;
              const iterate = owner.dirty[Symbol.iterator].bind(owner.dirty);
              const iteration = vi
                .spyOn(owner.dirty, Symbol.iterator)
                .mockImplementation(function* () {
                  for (const id of iterate()) {
                    visited++;
                    yield id;
                  }
                  return undefined;
                });
              try {
                await readFacts(owner, consume);
              } finally {
                iteration.mockRestore();
                dirtyVisits.push(visited);
              }
            });
          const reads: Array<{ sessionKeys: string[]; rows: SessionRowDatabaseFacts[] }> = [];
          const readDatabases = history.withSessionHistoryWorkerDatabases;
          const databases = vi
            .spyOn(history, "withSessionHistoryWorkerDatabases")
            .mockImplementation((selected, consume) =>
              readDatabases(selected, (owners) =>
                consume(
                  owners.map((owner) => ({
                    ...owner,
                    async readRowFacts(input) {
                      const reply = await owner.readRowFacts(input);
                      reads.push({
                        sessionKeys: [...input.sessionKeys],
                        rows: structuredClone(reply.rows),
                      });
                      return reply;
                    },
                  })),
                ),
              ),
            );
          let elapsed = 0;
          const realNow = performance.now.bind(performance);
          const acceptance: Array<{ rows: number; elapsedMs: number }> = [];
          let accepting: { rows: number; started: number } | undefined;
          const acquireEntry = records.acquireSessionRowEntry;
          const acquisition = vi
            .spyOn(records, "acquireSessionRowEntry")
            .mockImplementation((params) => {
              accepting ??= { rows: 0, started: realNow() };
              accepting.rows++;
              return acquireEntry(params);
            });
          const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
          const materializedKeys: string[] = [];
          const readInputs = rowInputs.readSessionRowInputs;
          const inputs = vi
            .spyOn(rowInputs, "readSessionRowInputs")
            .mockImplementation((params) => {
              if (accepting) {
                acceptance.push({ rows: accepting.rows, elapsedMs: realNow() - accepting.started });
                accepting = undefined;
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
            expect(dirtyVisits.every((visited) => visited <= 64)).toBe(true);
            expect(acceptance.map((batch) => batch.rows)).toEqual(
              batches.map((batch) => batch.length),
            );
            // Actual acquisition time is separate from the synthetic rendering clock.
            console.info("row-facts acceptance", JSON.stringify({ workMs, rowCount, acceptance }));
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
            selection.mockRestore();
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
      cfg: { agents: { list: [{ id: "main", default: true }] } },
    });
    try {
      await projection.ensureMaterialized();
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementationOnce(
        (databases, consume) =>
          readDatabases(databases, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                async readRowFacts(input) {
                  const reply = await owner.readRowFacts(input);
                  entered.resolve();
                  await release.promise;
                  return reply;
                },
              })),
            ),
          ),
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

it.each([
  "profile display",
  "run publication",
  "capacity transition",
  "collector publication",
  "membership revocation",
  "runtime stored facts",
  "invalidated presentation facts",
] as const)("consumes current list facts across an awaited worker reply: %s", async (change) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const changesOwner =
      change === "runtime stored facts" || change === "invalidated presentation facts";
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
        const readDatabases = history.withSessionHistoryWorkerDatabases;
        let first = true;
        vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
          (databases, consume) =>
            readDatabases(databases, (owners) =>
              consume(
                owners.map((database) => ({
                  ...database,
                  async readRowFacts(input) {
                    const reply = await database.readRowFacts(input);
                    if (first) {
                      first = false;
                      captured.resolve();
                      await releaseFirst.promise;
                    } else {
                      repeated.resolve();
                      await releaseRepeated.promise;
                    }
                    return reply;
                  },
                })),
              ),
            ),
        );
        replaceSessionEntrySync(scope, { ...entry, updatedAt: 2, label: "Fresh stored label" });
        reading = listSessions({ client, context, request });
        await Promise.race([
          captured.promise,
          reading.then(() => {
            throw new Error("List bypassed pending dirty row facts");
          }),
        ]);
        if (change === "profile display") {
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
          persistSubagentRunsToDiskOrThrow(subagentRuns, [runId]);
        } else if (changesOwner) {
          const emit = sessionChanges.emit.bind(sessionChanges);
          let publicationObserved = false;
          vi.spyOn(sessionChanges, "emit").mockImplementation((publication, database) => {
            if (
              "sessionKey" in publication &&
              publication.sessionKey === scope.sessionKey &&
              publication.facts?.kind === "unchanged"
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
          persistSubagentRunsToDiskOrThrow(subagentRuns, [runId]);
        }
      }
    } finally {
      releaseForeground();
    }
  });
});

it("refreshes prepared ACP metadata on publication and fences replacement lifecycles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:acp:worker-row";
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
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
