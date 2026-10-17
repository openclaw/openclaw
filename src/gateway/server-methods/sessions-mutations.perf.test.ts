import { afterEach, expect, test, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
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
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const sqliteTransactionLabels = vi.hoisted(() => [] as string[]);

vi.mock("../../state/openclaw-agent-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-db.js")>();
  const runOpenClawAgentWriteTransaction: typeof actual.runOpenClawAgentWriteTransaction = (
    operation,
    options,
    transactionOptions,
  ) => {
    sqliteTransactionLabels.push(transactionOptions?.operationLabel ?? "agent.write");
    return actual.runOpenClawAgentWriteTransaction(operation, options, transactionOptions);
  };
  return { ...actual, runOpenClawAgentWriteTransaction };
});

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
  overrides: {
    cron?: Pick<
      GatewayRequestContext["cron"],
      "list" | "updateWithPrecondition" | "getDefaultAgentId"
    >;
  } = {},
): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    loadGatewayModelCatalogSnapshot: vi.fn(async () => ({ entries: [], routeVariants: [] })),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
    ...overrides,
  } as unknown as GatewayRequestContext;
}

const archivedBy = { type: "human", id: "perf-reviewer", label: "Performance Reviewer" };
const normalizeSql = (sql: string) => sql.toLowerCase().replaceAll(/\s+/g, " ").trim();

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
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: targetKey },
        { sessionId: "session-single-patch-target", updatedAt: 1, ...snapshots },
      );
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
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:single-patch-unrelated-${index}` },
          {
            sessionId: `session-single-patch-unrelated-${index}`,
            updatedAt: index + 2,
            ...(index === 0 ? { label: "Taken" } : {}),
          },
        );
      }

      await rotateDatabaseWorkers(historyLane);
      const historySequence = historyLane.nativeSequence;
      expect(historySequence).toBe(historyLane.retiredSequence);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const statements = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["whole-store-projection"] as const,
        (sql) =>
          isWholeSessionStoreProjection(normalizeSql(sql)) ? "whole-store-projection" : null,
      );
      const respond = vi.fn();
      const hostSql = observeHostDataSql();
      try {
        await sessionMutationHandlers["sessions.patch"]!({
          params: { key: targetKey, ...patch },
          respond,
          context: mutationContext(),
          client: humanClient(),
        } as never);
        expect(historyLane.nativeSequence).toBe(historySequence);
      } finally {
        hostSql.restore();
        statements.restore();
      }

      const labelConflict = patch.label?.trim() === "Taken";
      expect(respond.mock.calls[0]?.[0]).toBe(!labelConflict);
      expect(statements.counts["whole-store-projection"]).toBe(0);
      expect(hostSql.queries.filter((sql) => /\bacp_sessions\b/i.test(sql))).toEqual([]);
      const target = loadSessionEntry({ agentId: "main", sessionKey: targetKey });
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
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:single-patch-unrelated-0" }),
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
    for (const [index, target] of targets.entries()) {
      const sessionId = `session-archive-perf-${index}`;
      const scope = { agentId: "main", sessionId, sessionKey: target.key };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: target.key },
        { sessionId, updatedAt: index + 1 },
      );
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
    const statements = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["whole-store-projection", "transcript-full-hydration"] as const,
      (sql) => {
        const normalized = normalizeSql(sql);
        if (isWholeSessionStoreProjection(normalized)) {
          return "whole-store-projection";
        }
        const fromIndex = normalized.indexOf(" from ");
        const selectedColumns = fromIndex > 0 ? normalized.slice("select ".length, fromIndex) : "";
        const readsTranscriptPayload =
          normalized.startsWith("select ") &&
          /\b(?:from|join) "transcript_events"(?: |$)/.test(normalized) &&
          (selectedColumns.includes("event_json") ||
            /(?:^|, )(?:(?:"[^"]+"\.)?\*)/.test(selectedColumns));
        const boundedPayloadLookup =
          normalized.includes(" limit ") ||
          /(?:"[^"]+"\.)?"(?:event_id|seq)" = (?:\?|\$\d+)/.test(normalized);
        return readsTranscriptPayload && !boundedPayloadLookup ? "transcript-full-hydration" : null;
      },
    );
    // Calibrate the host SQL observer through the synchronous compatibility reader.
    loadTranscriptEventsSync({
      agentId: "main",
      sessionId: "session-archive-perf-0",
      sessionKey: targets[0]!.key,
    });
    expect(statements.counts["transcript-full-hydration"]).toBe(1);
    statements.counts["transcript-full-hydration"] = 0;
    sqliteTransactionLabels.length = 0;
    const originalExec = database.db.exec.bind(database.db);
    const transactionCounts = { begin: 0, commit: 0 };
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
      if (normalized === "BEGIN IMMEDIATE") {
        transactionCounts.begin += 1;
      } else if (normalized === "COMMIT") {
        transactionCounts.commit += 1;
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
      const cronUpdateResults: Array<{ enabled: boolean; id: string }> = [];
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
          const result = { enabled: current.enabled, id };
          cronUpdateResults.push(result);
          return current;
        },
      );
      const context = mutationContext({
        cron: {
          list: cronList,
          updateWithPrecondition: cronUpdate,
          getDefaultAgentId: () => "main",
        },
      });

      await sessionMutationHandlers["sessions.patchMany"]!({
        params: { targets, patch: { archived: true } },
        respond,
        context,
        client: humanClient(),
      } as never);
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          outcomes: targets.map((target) => ({ ok: true, key: target.key })),
        },
        undefined,
      );
      // Guard batch cost with operation counts, independent of shared-runner contention.
      expect(statements.counts).toEqual({
        "whole-store-projection": 0,
        "transcript-full-hydration": 0,
      });
      // One admitted worker transaction owns the batch; the caller never waits in SQLite.
      expect(transactionCounts).toEqual({ begin: 0, commit: 0 });
      expect(workerGrants).toEqual(["transaction", "commit"]);
      expect(
        sqliteTransactionLabels.filter((label) =>
          ["session.entry-replacements", "agent.write"].includes(label),
        ),
      ).toEqual([]);
      expect(cronList).toHaveBeenCalledOnce();
      const disabledIds = ["bound-first", "bound-shared", "bound-last"];
      const disabledJobs = disabledIds.map((id) => ({ id, enabled: false }));
      expect(cronUpdate.mock.calls.map(([id, patch]) => [id, patch])).toEqual(
        disabledIds.map((id) => [id, { enabled: false }]),
      );
      expect(cronUpdateResults).toEqual(disabledJobs);
      expect([...cronJobs.values()].map(({ enabled, id }) => ({ enabled, id }))).toEqual([
        { enabled: true, id: "unrelated" },
        ...disabledJobs,
        { enabled: false, id: "already-disabled" },
      ]);
    } finally {
      admissionSpy.mockRestore();
      execSpy.mockRestore();
      statements.restore();
    }
    for (const [index, target] of targets.entries()) {
      const scope = {
        agentId: "main",
        sessionId: `session-archive-perf-${index}`,
        sessionKey: target.key,
      };
      expect(loadSessionEntry({ agentId: "main", sessionKey: target.key })).toMatchObject({
        archivedAt: expect.any(Number),
        archivedBy,
      });
      expect(await loadTranscriptEvents(scope)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({ customType: "openclaw.system-note" }),
          }),
        ]),
      );
    }
  });
});
