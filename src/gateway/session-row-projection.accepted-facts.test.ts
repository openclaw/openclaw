import { renameSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import {
  deleteSessionEntryLifecycle,
  persistSessionTranscriptTurn,
  readSessionTranscriptWatermark,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import * as entryCache from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import * as canonical from "../config/sessions/session-canonical-key.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionRowDatabaseFacts } from "../config/sessions/session-transcript-worker.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import * as agentDatabases from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import * as databaseFactsRead from "./session-row-projection-read.js";
import { ready, type Row } from "./session-row-projection-record.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import * as rowInputs from "./session-utils-row.js";

afterEach(() => vi.restoreAllMocks());

/** Pause after the real read boundary has released Worker, continuation, and native custody. */
async function withAcceptedSuffix(
  run: (fixture: {
    projection: SessionRowProjection;
    suffix: Row;
    scope: { agentId: string; sessionKey: string };
    query: { agentId: string; key: string };
    entry: InternalSessionEntry;
    reads: SessionRowDatabaseFacts[][];
    replacementPath: string;
    viewerId?: string;
    resume: () => Promise<void>;
    failNextRender: () => void;
  }) => Promise<void>,
  options: { archived?: boolean; membership?: boolean; replacement?: boolean } = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const keys = ["agent:main:accepted-a", "agent:main:accepted-b"];
    const identities = options.membership
      ? {
          owner: ensureProfileForEmail("accepted-owner@example.test"),
          viewer: ensureProfileForEmail("accepted-viewer@example.test"),
        }
      : undefined;
    const entries = keys.map<InternalSessionEntry>((_, index) => ({
      sessionId: `accepted-${index}`,
      updatedAt: 1,
      label: `initial-${index}`,
      ...(options.archived && index === 1 ? { archivedAt: 1 } : {}),
      ...(identities && index === 1
        ? {
            visibility: "read-only",
            createdActor: { type: "human", source: "profile", id: identities.owner.id },
          }
        : {}),
    }));
    for (const [index, sessionKey] of keys.entries()) {
      replaceSessionEntrySync({ agentId: "main", sessionKey }, entries[index]!);
    }
    if (identities) {
      addSessionMember(
        { agentId: "main", sessionKey: keys[1]! },
        {
          identityId: identities.viewer.id,
          addedBy: identities.owner.id,
          addedAt: 1,
        },
      );
    }
    const replacementPath = state.statePath("imports", "accepted-replacement.sqlite");
    if (options.replacement) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: keys[1]!, storePath: replacementPath },
        { ...entries[1]!, updatedAt: 2, label: "replacement store" },
      );
      await closeOpenClawAgentDatabaseByPathAsync(replacementPath, "main");
    }
    const releaseForeground = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg: {
        agents: {
          list: [{ id: "main", default: true }],
          defaults: { utilityModel: "unit-test/small" },
        },
      },
      modelCatalog: [],
    });
    const paused = createDeferredCore();
    const release = createDeferredCore();
    let reading: Promise<void> | undefined;
    try {
      await projection.ensureMaterialized();
      const query = { agentId: "main", key: keys[1]! };
      const previous = projection.describe(query)!;
      const count = projection.materializedCount;
      const releases: string[] = [];
      const continuations: SharedArrayBuffer[] = [];
      let trackingCustody = false;
      const capture = canonical.captureCanonicalSessionReaderContinuation;
      vi.spyOn(canonical, "captureCanonicalSessionReaderContinuation").mockImplementation((db) => {
        const owner = capture(db);
        if (!owner || !trackingCustody) {
          return owner;
        }
        continuations.push(owner.receipt.live);
        return {
          ...owner,
          release() {
            owner.release();
            releases.push("continuation");
          },
        };
      });
      const retain = agentDatabases.retainOpenClawAgentDatabaseReadCandidates;
      vi.spyOn(agentDatabases, "retainOpenClawAgentDatabaseReadCandidates").mockImplementation(
        (...args) => {
          const owner = retain(...args);
          if (!trackingCustody) {
            return owner;
          }
          expect(owner.databases).toHaveLength(1);
          return {
            ...owner,
            release() {
              owner.release();
              releases.push("native");
            },
          };
        },
      );
      const reads: SessionRowDatabaseFacts[][] = [];
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
        async (selected, consume) => {
          const tracked = trackingCustody;
          const result = await readDatabases(selected, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                async readRowFacts(input) {
                  const reply = await owner.readRowFacts(input);
                  reads.push(structuredClone(reply.rows));
                  return reply;
                },
              })),
            ),
          );
          if (tracked) {
            releases.push("worker");
          }
          return result;
        },
      );
      let elapsed = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const readInputs = rowInputs.readSessionRowInputs;
      const inputs = vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementation((params) => {
        const result = readInputs(params);
        elapsed += 20;
        return result;
      });
      const readFacts = databaseFactsRead.withSessionRowDatabaseFacts;
      vi.spyOn(databaseFactsRead, "withSessionRowDatabaseFacts").mockImplementationOnce(
        async (...args) => {
          trackingCustody = true;
          try {
            await readFacts(...args);
          } finally {
            trackingCustody = false;
          }
          paused.resolve();
          await release.promise;
        },
      );
      for (const [index, sessionKey] of keys.entries()) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { ...entries[index]!, updatedAt: 2, label: `accepted-${index}` },
        );
      }
      reading = projection.ensureMaterialized();
      await Promise.race([
        paused.promise,
        reading.then(() => {
          throw new Error("Drain bypassed the released-custody boundary");
        }),
      ]);
      expect(releases).toEqual(["worker", "continuation", "native"]);
      expect(continuations).toHaveLength(1);
      expect(Atomics.load(new Int32Array(continuations[0]!), 0)).toBe(0);
      const suffix = projection.findBySessionId({
        agentId: "main",
        sessionId: entries[1]!.sessionId,
      })[0]!;
      expect(suffix.pendingDatabaseFacts?.entry.label).toBe("accepted-1");
      expect(suffix.materialized).toBe(previous.materialized);
      expect(suffix.materializedSequence).toBe(previous.materializedSequence);
      expect(ready(suffix)).toBe(false);
      expect(projection.materializedCount).toBe(count + 1);
      expect(reads).toHaveLength(1);
      expect(reads[0]?.map((row) => row.sessionKey)).toEqual(keys);
      await run({
        projection,
        suffix,
        query,
        reads,
        replacementPath,
        viewerId: identities?.viewer.id,
        scope: { agentId: "main", sessionKey: query.key },
        entry: { ...entries[1]!, updatedAt: 2, label: "accepted-1" },
        resume: async () => {
          release.resolve();
          await reading;
        },
        failNextRender: () => {
          inputs.mockImplementationOnce(() => {
            throw new Error("presentation unavailable");
          });
        },
      });
    } finally {
      release.resolve();
      await Promise.allSettled(reading ? [reading] : []);
      vi.restoreAllMocks();
      projection.dispose();
      releaseForeground();
    }
  });
}

it("lets same-generation keyed acquisition supersede accepted facts after custody release", async () => {
  await withAcceptedSuffix(async ({ projection, suffix, query, entry, reads, resume }) => {
    // Model a direct reader discovering a newer same-timestamp committed value.
    vi.spyOn(entryCache, "readCommittedSessionEntryCache").mockReturnValueOnce(
      new Map([[query.key, { ...entry, label: "keyed value" }]]),
    );
    const current = projection.describe(query)!;
    expect(current.generation).toBe(suffix.generation);
    expect(current.pendingDatabaseFacts).toBeUndefined();
    expect(current.materialized.source.entry).toBe(current.entry);
    await resume();
    expect(reads).toHaveLength(1);
    expect(projection.snapshot(query).row?.label).toBe("keyed value");
    expect(projection.dirtyRowCount).toBe(0);
  });
});

it("replaces the whole accepted entry, board, and watermark snapshot after a commit", async () => {
  await withAcceptedSuffix(async ({ projection, suffix, scope, query, entry, reads, resume }) => {
    expect(suffix.pendingDatabaseFacts?.hasBoard).toBe(false);
    const board = new SqliteBoardStore({
      resolveSession: ({ sessionKey }) => ({ agentId: "main", sessionKey }),
    });
    await board.putWidget({
      sessionKey: query.key,
      name: "status",
      content: { kind: "html", html: "<p>current</p>" },
    });
    await persistSessionTranscriptTurn(
      { ...scope, sessionId: entry.sessionId },
      {
        config: projection.state.cfg,
        messages: [{ message: { role: "user", content: "Current transcript" } }],
        touchSessionEntry: false,
        updateMode: "none",
      },
    );
    const watermark = readSessionTranscriptWatermark({ ...scope, sessionId: entry.sessionId });
    replaceSessionEntrySync(scope, {
      ...entry,
      label: "committed value",
      activitySummary: {
        version: 1,
        formatRevision: 2,
        text: "Current summary",
        updatedAt: 3,
        sessionId: entry.sessionId,
        generation: watermark.generation,
        maxSeq: watermark.maxSeq,
        leafEntryId: null,
        coveredMessages: 1,
        totalMessages: 1,
        omittedContent: false,
      },
    });
    expect(suffix.pendingDatabaseFacts).toBeUndefined();
    expect(ready(suffix)).toBe(false);
    await resume();
    expect(reads).toHaveLength(2);
    expect(reads[1]).toEqual([
      expect.objectContaining({
        sessionKey: query.key,
        entry: expect.objectContaining({ label: "committed value" }),
        hasBoard: true,
        activitySummaryWatermark: watermark,
      }),
    ]);
    expect(projection.describe(query)?.hasBoard).toBe(true);
    expect(projection.snapshot(query).row).toMatchObject({
      label: "committed value",
      activitySummary: { text: "Current summary", state: "current" },
    });
    expect(projection.dirtyRowCount).toBe(0);
  });
});

it.each(["runtime facts", "invalidated presentation facts"] as const)(
  "discards accepted facts for %s after custody release",
  async (change) => {
    await withAcceptedSuffix(async ({ projection, suffix, scope, query, entry, reads, resume }) => {
      const emit = sessionChanges.emit.bind(sessionChanges);
      vi.spyOn(sessionChanges, "emit").mockImplementation((publication, database) => {
        if ("sessionKey" in publication && publication.sessionKey === query.key) {
          if (change === "runtime facts") {
            publication.scope = "runtime";
          } else {
            emit({ all: true, scope: "profiles", factsInvalidated: true }, database);
            return;
          }
        }
        emit(publication, database);
      });
      replaceSessionEntrySync(scope, { ...entry, label: "current value" });
      expect(suffix.pendingDatabaseFacts).toBeUndefined();
      expect(ready(suffix)).toBe(false);
      await resume();
      expect(reads.length).toBeGreaterThan(1);
      expect(projection.snapshot(query).row?.label).toBe("current value");
      expect(projection.dirtyRowCount).toBe(0);
    });
  },
);

it("keeps accepted resident facts after their native reader is retired", async () => {
  await withAcceptedSuffix(async ({ projection, suffix, query, reads, resume }) => {
    await closeOpenClawAgentDatabaseByPathAsync(suffix.storeTarget.storePath, "main");
    await resume();
    expect(reads).toHaveLength(1);
    expect(projection.snapshot(query).row?.label).toBe("accepted-1");
    expect(projection.dirtyRowCount).toBe(0);
  });
});

it("presents current runtime activity without reacquiring accepted database facts", async () => {
  await withAcceptedSuffix(
    async ({ projection, suffix, query, entry, reads, viewerId, resume }) => {
      const pending = suffix.pendingDatabaseFacts;
      const runId = "accepted-suffix-current-run";
      registerAgentRunContext(runId, {
        agentId: query.agentId,
        sessionKey: query.key,
        sessionId: entry.sessionId,
        projectSessionActive: true,
      });
      try {
        expect(suffix.pendingDatabaseFacts).toBe(pending);
        await resume();
        const context = bindSessionRowProjection(
          requestContext(projection.state.cfg),
          () => projection,
        );
        const result = await listSessions({
          client: identifiedClient(viewerId!),
          context,
          request: { agentId: "main", limit: 10 },
        });
        expect(reads).toHaveLength(1);
        expect(result.sessions.find((row) => row.key === query.key)).toMatchObject({
          label: "accepted-1",
          hasActiveRun: true,
          status: "running",
        });
      } finally {
        clearAgentRunContext(runId);
      }
    },
    { membership: true },
  );
});

it("retains accepted facts and dirty work when presentation fails", async () => {
  await withAcceptedSuffix(async ({ projection, suffix, query, reads, resume, failNextRender }) => {
    const pending = suffix.pendingDatabaseFacts;
    const sequence = suffix.materializedSequence;
    failNextRender();
    await expect(resume()).rejects.toThrow("presentation unavailable");
    expect(suffix.pendingDatabaseFacts).toBe(pending);
    expect(suffix.materializedSequence).toBe(sequence);
    expect(ready(suffix)).toBe(false);
    expect(projection.dirtyRowCount).toBe(1);
    await projection.ensureMaterialized();
    expect(reads).toHaveLength(1);
    expect(projection.snapshot(query).row?.label).toBe("accepted-1");
    expect(projection.dirtyRowCount).toBe(0);
  });
});

it.each(["reset", "delete", "dispose"] as const)(
  "does not render the accepted suffix after %s",
  async (change) => {
    await withAcceptedSuffix(async ({ projection, suffix, scope, query, entry, resume }) => {
      if (change === "reset") {
        replaceSessionEntrySync(scope, {
          ...entry,
          lifecycleRevision: "reset",
          label: "reset value",
        });
      } else if (change === "delete") {
        await deleteSessionEntryLifecycle({
          ...scope,
          storePath: suffix.storeTarget.storePath,
          archiveTranscript: false,
          target: { canonicalKey: query.key, storeKeys: [query.key] },
        });
      } else {
        projection.dispose();
      }
      await resume();
      expect(projection.isCurrent(suffix)).toBe(false);
      expect(projection.snapshot(query).row?.label ?? null).toBe(
        change === "reset" ? "reset value" : null,
      );
      expect(projection.dirtyRowCount).toBe(0);
    });
  },
);

it("prepares a warm archived suffix without treating stale presentation as cold", async () => {
  await withAcceptedSuffix(
    async ({ projection, suffix, scope, query, entry, resume }) => {
      expect(isColdArchivedSessionRow(suffix)).toBe(false);
      replaceSessionEntrySync(scope, { ...entry, label: "current archive" });
      expect(suffix.pendingDatabaseFacts).toBeUndefined();
      expect(ready(suffix)).toBe(false);
      const current = projection.describe(query)!;
      expect(isColdArchivedSessionRow(current)).toBe(false);
      expect(current.materialized.source.entry).toBe(current.entry);
      expect(current.materialized.row.label).toBe("current archive");
      await resume();
      expect(projection.dirtyRowCount).toBe(0);
    },
    { archived: true },
  );
});

it("applies committed membership revocation after the suffix has been accepted", async () => {
  await withAcceptedSuffix(
    async ({ projection, suffix, scope, query, viewerId, resume }) => {
      expect(viewerId).toBeDefined();
      expect(projection.hasMembership(suffix.storeTarget.storePath, query.key, viewerId!)).toBe(
        true,
      );
      expect(removeSessionMember(scope, viewerId!)).not.toBeNull();
      expect(projection.hasMembership(suffix.storeTarget.storePath, query.key, viewerId!)).toBe(
        false,
      );
      expect(suffix.pendingDatabaseFacts).toBeUndefined();
      await resume();
      const context = bindSessionRowProjection(
        requestContext(projection.state.cfg),
        () => projection,
      );
      const result = await listSessions({
        client: identifiedClient(viewerId!),
        context,
        request: { agentId: "main", limit: 10 },
      });
      expect(result.sessions.find((row) => row.key === query.key)?.sharingRole).toBe("viewer");
      expect(projection.describe(query)?.membership.has(viewerId!)).toBe(false);
    },
    { membership: true },
  );
});

it("demotes an accepted suffix without rendering it during the bulk drain", async () => {
  await withAcceptedSuffix(async ({ projection, scope, query, entry, resume }) => {
    const count = projection.materializedCount;
    replaceSessionEntrySync(scope, { ...entry, archivedAt: 3, label: "archived suffix" });
    await resume();
    expect(projection.materializedCount).toBe(count);
    const cold = projection.findBySessionId({ agentId: "main", sessionId: entry.sessionId })[0]!;
    expect(isColdArchivedSessionRow(cold)).toBe(true);
    expect(cold.pendingDatabaseFacts).toBeUndefined();
    expect(projection.dirtyRowCount).toBe(0);
    expect(projection.snapshot(query).row?.label).toBe("archived suffix");
  });
});

it("replaces accepted facts when the physical store changes between slices", async () => {
  await withAcceptedSuffix(
    async ({ projection, suffix, query, replacementPath, resume }) => {
      const pending = suffix.pendingDatabaseFacts;
      const storePath = suffix.storeTarget.storePath;
      await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
      expect(suffix.pendingDatabaseFacts).toBe(pending);
      renameSync(replacementPath, storePath);
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
      await resume();
      expect(projection.isCurrent(suffix)).toBe(false);
      expect(projection.snapshot(query).row?.label).toBe("replacement store");
      expect(projection.dirtyRowCount).toBe(0);
    },
    { replacement: true },
  );
});

it("releases the accepted snapshot graph when its projection is disposed", async () => {
  let pending: WeakRef<object> | undefined;
  let control: WeakRef<object> | undefined;
  await withAcceptedSuffix(async ({ projection, suffix, resume }) => {
    pending = new WeakRef(suffix.pendingDatabaseFacts!);
    control = new WeakRef({});
    projection.dispose();
    await resume();
  });
  await nextTurn();
  queryObjects(WeakRef);
  expect(control?.deref()).toBeUndefined();
  expect(pending?.deref()).toBeUndefined();
});
