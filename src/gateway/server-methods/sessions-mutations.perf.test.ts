import { afterEach, expect, test, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import * as thinking from "../../auto-reply/thinking.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import * as sessionWrite from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  historyLane,
  rotateDatabaseWorkers,
} from "../../config/sessions/session-transcript-worker-resources.js";
import { promptReport } from "../../config/sessions/system-prompt-report.test-support.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as patchProjection from "../sessions-patch.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { createSessionMutationContext } from "./sessions-mutations.native-consent.test-support.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
import type { GatewayClient } from "./types.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

function humanClient(): GatewayClient {
  const client = createSessionMutationTestClient("perf-reviewer");
  client.authenticatedUserProfile!.displayName = "Performance Reviewer";
  client.connect.scopes = ["operator.read", "operator.write", "operator.admin"];
  return client;
}

const archivedBy = { type: "human", id: "perf-reviewer", label: "Performance Reviewer" };
const normalizeSql = (sql: string) => sql.toLowerCase().replaceAll(/\s+/g, " ").trim();
const sessionScope = (sessionKey: string) => ({ agentId: "main", sessionKey });
const seedSession = (key: string, sessionId: string, entry: Partial<SessionEntry>) =>
  upsertSessionEntryCore(sessionScope(key), { sessionId, ...entry });

test.for([
  { patch: { unread: false }, count: 1, stale: false, noop: false },
  { patch: { unread: true }, count: 1, stale: false, noop: false },
  { patch: { fastMode: true }, count: 1, stale: false, noop: false },
  { patch: { fastMode: null }, count: 1, stale: false, noop: false },
  { patch: { unread: false }, count: 2, stale: false, noop: false },
  { patch: { unread: false }, count: 2, stale: true, noop: false },
  { patch: { unread: false, expectedMarkedUnreadAt: 0 }, count: 1, stale: false, noop: true },
])(
  "prepares archived metadata %j from committed state while a writer is pending",
  async ({ patch, count, stale, noop }, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await captureRuntimeConfigAsyncReader()();
      const keys = Array.from({ length: count }, (_, index) => `agent:main:contended-${index}`);
      const skillsSnapshot = {
        prompt: "synthetic cold snapshot ".repeat(patch.fastMode === null ? 400_000 : 1_000),
        skills: [],
      };
      const baseline = (sessionId: string, fingerprint: string) => ({
        version: 1 as const,
        sessionId,
        root: "/synthetic",
        files: [{ path: "file.txt", fingerprint }],
      });
      for (const key of keys) {
        await seedSession(key, key, {
          lifecycleRevision: "before",
          archivedAt: 1,
          updatedAt: 1,
          markedUnreadAt: 1,
          fastMode: patch.fastMode !== true,
          agentStatus: { note: "Synthetic status", expiresAt: Date.now() + 60_000 },
          skillsSnapshot,
          sessionDiffBaseline: baseline(key, "before"),
        });
      }
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const projected = createDeferredCore();
      const reserved = createDeferredCore();
      let snapshotHasSkills = false;
      const project = patchProjection.prepareSessionsPatchEntry;
      let projectedCount = 0;
      using projection = vi
        .spyOn(patchProjection, "prepareSessionsPatchEntry")
        .mockImplementation((input) => {
          snapshotHasSkills = Object.hasOwn(input.existingEntry ?? {}, "skillsSnapshot");
          if (++projectedCount === count) {
            projected.resolve();
          }
          return project(input);
        });
      const reserve = sessionWrite.runExclusiveSqliteSessionWrite;
      using reservation = vi
        .spyOn(sessionWrite, "runExclusiveSqliteSessionWrite")
        .mockImplementation((...args) => {
          if (args[2] === "session.entry-replacements") {
            reserved.resolve();
          }
          return reserve(...args);
        });
      const writer = runOpenClawAgentWriteAdmission(database, async () => {
        entered.resolve();
        await release.promise;
        runOpenClawAgentWriteTransaction(
          (current) => {
            for (const [index, key] of keys.entries()) {
              writeSessionEntry(current, key, {
                ...loadSessionEntry(sessionScope(key))!,
                inputTokens: 123,
                updatedAt: 100,
                agentStatus: undefined,
                lastReadAt: 77,
                sessionDiffBaseline: baseline(key, "after"),
                lifecycleRevision: stale && index === 1 ? "after" : "before",
              });
            }
          },
          { agentId: "main", env: state.env, path: database.path },
        );
      });
      await entered.promise;
      const respond = vi.fn();
      if (noop) {
        respond.mockImplementation(() => projected.resolve());
      }
      const request = sessionMutationHandlers[
        count === 1 ? "sessions.patch" : "sessions.patchMany"
      ]!({
        params:
          count === 1
            ? { key: keys[0], ...patch }
            : {
                targets: keys.map((key) => ({
                  key,
                  expectedSessionId: key,
                  expectedLifecycleRevision: "before",
                })),
                patch,
              },
        respond,
        context: createSessionMutationContext(),
        client: humanClient(),
      } as never);
      let first: string;
      try {
        first = await withinTest(
          Promise.race([
            projected.promise.then(() => "snapshot"),
            reserved.promise.then(() => "writer"),
          ]),
          signal,
        );
      } finally {
        release.resolve();
        await Promise.allSettled([writer, request]);
      }
      await Promise.all([writer, request]);
      expect(first).toBe("snapshot");
      expect(projection).toHaveBeenCalledTimes(noop ? 0 : count);
      expect(
        reservation.mock.calls.filter((args) => args[2] === "session.entry-replacements"),
      ).toHaveLength(0);
      expect(snapshotHasSkills).toBe(false);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      if (count > 1) {
        expect(respond.mock.calls[0]?.[1].outcomes).toEqual(
          keys.map((key) => expect.objectContaining({ key, ok: !stale })),
        );
      }
      for (const [index, key] of keys.entries()) {
        const committed = loadSessionEntry(sessionScope(key));
        expect(committed).toMatchObject({
          archivedAt: 1,
          inputTokens: 123,
          skillsSnapshot,
          ...(patch.unread === false && !stale && !noop
            ? { updatedAt: 100, lastReadAt: expect.any(Number) }
            : { lastReadAt: 77 }),
        });
        expect(committed?.agentStatus).toBeUndefined();
        expect(committed?.fastMode).toBe(patch.fastMode === null ? undefined : true);
        expect(committed?.lifecycleRevision).toBe(stale && index === 1 ? "after" : "before");
        if (stale || noop) {
          expect(committed?.markedUnreadAt).toBe(1);
        } else if (patch.unread === false) {
          expect(committed?.lastReadAt).toBeGreaterThan(77);
          expect(committed?.markedUnreadAt).toBeUndefined();
        } else if (patch.unread === true) {
          expect(committed?.markedUnreadAt).toBeGreaterThan(1);
        }
      }
      if (count === 1) {
        expect(respond.mock.calls[0]?.[1].entry).toMatchObject({
          ...(noop ? {} : { inputTokens: 123 }),
          sessionDiffBaseline: baseline(keys[0]!, noop ? "before" : "after"),
        });
        expect(respond.mock.calls[0]?.[1].entry).not.toHaveProperty("skillsSnapshot");
        expect(respond.mock.calls[0]?.[1].entry).not.toHaveProperty("systemPromptReport");
      }
    });
  },
);

function trackReads(database: ReturnType<typeof openOpenClawAgentDatabase>) {
  return trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["whole-store-projection", "transcript-full-hydration"] as const,
    (sql) => {
      const normalized = normalizeSql(sql);
      if (isWholeSessionStoreProjection(normalized)) {
        return "whole-store-projection";
      }
      const fromIndex = normalized.indexOf(" from ");
      const columns = fromIndex > 0 ? normalized.slice("select ".length, fromIndex) : "";
      return normalized.startsWith("select ") &&
        /\b(?:from|join) "transcript_events"(?: |$)/.test(normalized) &&
        (columns.includes("event_json") || /(?:^|, )(?:(?:"[^"]+"\.)?\*)/.test(columns)) &&
        !normalized.includes(" limit ") &&
        !/(?:"[^"]+"\.)?"(?:event_id|seq)" = (?:\?|\$\d+)/.test(normalized)
        ? "transcript-full-hydration"
        : null;
    },
  );
}

function isWholeSessionStoreProjection(normalizedSql: string): boolean {
  const source = ' from "session_nodes" order by "session_key"';
  if (!normalizedSql.startsWith("select ") || !normalizedSql.endsWith(source)) {
    return false;
  }
  const selection = normalizedSql.slice("select ".length, -source.length);
  return (
    selection === "*" ||
    ['"current_session_id"', '"entry_json"', '"session_key"', '"updated_at"'].every((column) =>
      selection.includes(column),
    )
  );
}

test.each([{ pinned: true }, { label: "Renamed" }, { label: " Taken " }])(
  "sessions.patch %j avoids transcript-worker startup, unrelated hydration, and host ACP reads",
  async (patch) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await captureRuntimeConfigAsyncReader()();
      const targetKey = "agent:main:single-patch-target";
      const snapshots = {
        skillsSnapshot: { prompt: "synthetic skill instructions ".repeat(1_000), skills: [] },
        systemPromptReport: promptReport(1, 30_000, 30_000),
      };
      await seedSession(targetKey, "session-single-patch-target", { updatedAt: 1, ...snapshots });
      await upsertAcpSessionMeta({
        cfg: {},
        agentId: "main",
        sessionKey: targetKey,
        mutate: () => ({
          backend: "acpx",
          agent: "main",
          runtimeSessionName: "single-patch-target",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        }),
      });
      for (let index = 0; index < 20; index += 1) {
        const id = `single-patch-unrelated-${index}`;
        await seedSession(`agent:main:${id}`, `session-${id}`, {
          updatedAt: index + 2,
          ...(index === 0 ? { label: "Taken" } : {}),
        });
      }

      await rotateDatabaseWorkers(historyLane);
      const historyWorkers = historyLane.pool.getSnapshot();
      expect(historyWorkers.workers).toBe(0);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const statements = trackReads(database);
      const respond = vi.fn();
      const hostSql = observeHostDataSql();
      const thinkingReads = vi.spyOn(thinking, "resolveThinkingProfile");
      try {
        await sessionMutationHandlers["sessions.patch"]!({
          params: { key: targetKey, ...patch },
          respond,
          context: createSessionMutationContext(),
          client: humanClient(),
        } as never);
        expect(historyLane.pool.getSnapshot().workersCreated).toBe(historyWorkers.workersCreated);
        expect(thinkingReads.mock.calls.length).toBe(0);
      } finally {
        thinkingReads.mockRestore();
        hostSql.restore();
        statements.restore();
      }

      const labelConflict = patch.label?.trim() === "Taken";
      expect(respond.mock.calls[0]?.[0]).toBe(!labelConflict);
      expect(statements.counts["whole-store-projection"]).toBe(0);
      expect(hostSql.queries.filter((sql) => /\bacp_sessions\b/i.test(sql))).toEqual([]);
      const target = loadSessionEntry(sessionScope(targetKey));
      expect(target).toMatchObject(snapshots);
      if (labelConflict) {
        expect(respond.mock.calls[0]?.[2]).toHaveProperty("message", "label already in use: Taken");
        expect(target?.label).toBeUndefined();
      } else {
        const receipt = respond.mock.calls[0]?.[1];
        expect(receipt.entry).not.toHaveProperty("skillsSnapshot");
        expect(receipt.entry).not.toHaveProperty("systemPromptReport");
        expect(respond.mock.calls[0]?.[1]).toMatchObject({
          resolved: { runtimeSelectionLocked: true, agentRuntime: { id: "acpx" } },
        });
        expect(target).toHaveProperty("label" in patch ? "label" : "pinnedAt");
      }
      expect(
        loadSessionEntry(sessionScope("agent:main:single-patch-unrelated-0")),
      ).not.toHaveProperty("pinnedAt");
    });
  },
);

test("sessions.patchMany archives 30 human sessions without transcript hydration", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const targets = Array.from({ length: 30 }, (_, index) => ({
      key: `agent:main:archive-perf-${index}`,
      expectedSessionId: `session-archive-perf-${index}`,
    }));
    const scopeFor = (target: (typeof targets)[number]) => ({
      agentId: "main",
      sessionId: target.expectedSessionId,
      sessionKey: target.key,
    });
    for (const [index, target] of targets.entries()) {
      const scope = scopeFor(target);
      await seedSession(target.key, target.expectedSessionId, { updatedAt: index + 1 });
      const root = await appendTranscriptMessage(scope, {
        message: { role: "user", content: `history root ${index}`, timestamp: 1 },
        now: 1,
      });
      await appendTranscriptMessage(scope, {
        message: { role: "assistant", content: `history tail ${index}`, timestamp: 2 },
        now: 2,
        parentId: root.messageId,
      });
    }

    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const statements = trackReads(database);
    // Calibrate the host SQL observer through the synchronous compatibility reader.
    loadTranscriptEventsSync(scopeFor(targets[0]!));
    expect(statements.counts["transcript-full-hydration"]).toBe(1);
    statements.counts["transcript-full-hydration"] = 0;
    const originalExec = database.db.exec.bind(database.db);
    const hostTransactions: string[] = [];
    const workerGrants: string[] = [];
    const admissionSpy = probe.admission(admission, (request, grant, callback) => {
      callback(request, () => {
        const granted = grant();
        if (granted && (request.stage === "transaction" || request.stage === "commit")) {
          workerGrants.push(request.stage);
        }
        return granted;
      });
    });
    const execSpy = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
      const normalized = sql.trim().toUpperCase();
      if (["BEGIN IMMEDIATE", "COMMIT"].includes(normalized)) {
        hostTransactions.push(normalized);
      }
      return originalExec(sql);
    });
    try {
      const respond = vi.fn();
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: { targets, patch: { archived: true } },
        respond,
        context: createSessionMutationContext({}, undefined, {
          list: async () => [],
          getDefaultAgentId: () => "main",
          updateWithPrecondition: async () => {
            throw new Error("No cron jobs should be updated");
          },
        }),
        client: humanClient(),
      } as never);
      const outcomes = targets.map(({ key }) => ({ ok: true, key }));
      expect(respond).toHaveBeenCalledWith(true, { outcomes }, undefined);
      expect(statements.counts).toEqual({
        "whole-store-projection": 0,
        "transcript-full-hydration": 0,
      });
      // One admitted worker transaction owns the batch; the caller never waits in SQLite.
      expect(hostTransactions).toEqual([]);
      expect(workerGrants).toEqual(["transaction", "commit"]);
    } finally {
      admissionSpy.mockRestore();
      execSpy.mockRestore();
      statements.restore();
    }
    for (const target of targets) {
      const scope = scopeFor(target);
      expect(loadSessionEntry(sessionScope(target.key))).toMatchObject({
        archivedAt: expect.any(Number),
        archivedBy,
      });
      expect(await loadTranscriptEvents(scope)).not.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ customType: "openclaw.system-note" }),
        }),
      );
    }
  });
});
