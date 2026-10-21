import { afterEach, expect, test, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  historyLane,
  rotateDatabaseWorkers,
} from "../../config/sessions/session-transcript-worker-resources.js";
import type { CronJob } from "../../cron/types.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});

function humanClient(): GatewayClient {
  const client = createSessionMutationTestClient("perf-reviewer");
  client.authenticatedUserProfile!.displayName = "Performance Reviewer";
  client.connect.scopes = ["operator.read", "operator.write", "operator.admin"];
  return client;
}

function mutationContext(
  cron?: Pick<
    GatewayRequestContext["cron"],
    "list" | "updateWithPrecondition" | "getDefaultAgentId"
  >,
): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    loadGatewayModelCatalogSnapshot: vi.fn(async () => ({ entries: [], routeVariants: [] })),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    dedupe: new Map(),
    ...(cron ? { cron } : {}),
  } as unknown as GatewayRequestContext;
}

const archivedBy = { type: "human", id: "perf-reviewer", label: "Performance Reviewer" };
const normalizeSql = (sql: string) => sql.toLowerCase().replaceAll(/\s+/g, " ").trim();
const sessionScope = (sessionKey: string) => ({ agentId: "main", sessionKey });
const seedSession = (key: string, sessionId: string, entry: Partial<SessionEntry>) =>
  upsertSessionEntryCore(sessionScope(key), { sessionId, ...entry });

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
        systemPromptReport: {
          source: "run" as const,
          generatedAt: 1,
          systemPrompt: { chars: 30_000, projectContextChars: 0, nonProjectContextChars: 30_000 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 30_000, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
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
      try {
        await sessionMutationHandlers["sessions.patch"]!({
          params: { key: targetKey, ...patch },
          respond,
          context: mutationContext(),
          client: humanClient(),
        } as never);
        expect(historyLane.pool.getSnapshot().workersCreated).toBe(historyWorkers.workersCreated);
      } finally {
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
    const writeSpy = vi.spyOn(agentDatabase, "runOpenClawAgentWriteTransaction");
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
      const job = (id: string, sessionTarget: string, partial: Partial<CronJob> = {}): CronJob =>
        ({ enabled: true, id, sessionTarget, ...partial }) as CronJob;
      const cronJobs = new Map(
        [
          job("unrelated", "session:agent:main:not-archived"),
          job("bound-first", `session:${targets[0]!.key}`),
          job("bound-shared", `session:${targets[1]!.key}`, { sessionKey: targets[2]!.key }),
          job("bound-last", `session:${targets.at(-1)!.key}`),
          job("already-disabled", `session:${targets[3]!.key}`, { enabled: false }),
        ].map((cronJob) => [cronJob.id, cronJob] as const),
      );
      const cronList = vi.fn(async () => [...cronJobs.values()]);
      type CronPrecondition = (job: CronJob, nowMs: number) => void | Promise<void>;
      const cronUpdate = vi.fn(
        async (id: string, patch: Partial<CronJob>, precondition: CronPrecondition) => {
          const current = cronJobs.get(id);
          if (!current) {
            throw new Error(`missing cron fixture: ${id}`);
          }
          await precondition(current, 0);
          if (patch.enabled !== undefined) {
            current.enabled = patch.enabled;
          }
          return current;
        },
      );
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: { targets, patch: { archived: true } },
        respond,
        context: mutationContext({
          list: cronList,
          updateWithPrecondition: cronUpdate,
          getDefaultAgentId: () => "main",
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
      expect(
        writeSpy.mock.calls.some((args) =>
          ["session.entry-replacements", "agent.write"].includes(
            args[2]?.operationLabel ?? "agent.write",
          ),
        ),
      ).toBe(false);
      expect(cronList).toHaveBeenCalledOnce();
      const disabledIds = ["bound-first", "bound-shared", "bound-last"];
      const disabledJobs = disabledIds.map((id) => ({ id, enabled: false }));
      expect(cronUpdate.mock.calls.map(([id, patch]) => [id, patch])).toEqual(
        disabledIds.map((id) => [id, { enabled: false }]),
      );
      expect([...cronJobs.values()].map(({ enabled, id }) => ({ enabled, id }))).toEqual([
        { enabled: true, id: "unrelated" },
        ...disabledJobs,
        { enabled: false, id: "already-disabled" },
      ]);
    } finally {
      admissionSpy.mockRestore();
      execSpy.mockRestore();
      writeSpy.mockRestore();
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
