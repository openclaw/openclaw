import { statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { handleTasksCommand } from "../auto-reply/reply/commands-tasks.js";
import {
  baseCommandTestConfig,
  buildCommandTestParams,
} from "../auto-reply/reply/commands.test-harness.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { buildStatusText } from "../status/status-text.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator } from "../test-utils/state-database-contention.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { getInspectableTaskStatusSummaryReadOnly } from "./task-registry.maintenance.js";
import {
  loadTaskRegistryStateFromSqliteReadOnly,
  upsertTaskWithDeliveryStateToSqlite,
} from "./task-registry.store.sqlite.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

const sessionKey = "agent:main:main";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
});

async function renderTaskStatus(surface: "tasks" | "status"): Promise<string | undefined> {
  if (surface === "tasks") {
    const result = await handleTasksCommand(
      buildCommandTestParams("/tasks", baseCommandTestConfig),
      true,
    );
    return result?.reply?.text;
  }
  return buildStatusText({
    cfg: baseCommandTestConfig,
    sessionKey,
    agentId: "main",
    statusChannel: "whatsapp",
    provider: "anthropic",
    model: "claude-opus-4-6",
    resolvedHarness: "openclaw",
    resolvedThinkLevel: "off",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    defaultGroupActivation: () => "mention",
    pluginHealthLineOverride: "",
    modelAuthOverride: "api-key",
    activeModelAuthOverride: "api-key",
    includeTranscriptUsage: false,
  });
}

it("does not create shared state for a read-only task snapshot", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-task-store-readonly-" },
    async () => {
      const statePath = resolveOpenClawStateSqlitePath();
      expect(() => statSync(statePath)).toThrow();

      const snapshot = loadTaskRegistryStateFromSqliteReadOnly();
      expect(snapshot.tasks.size).toBe(0);
      expect(snapshot.deliveryStates.size).toBe(0);
      expect(() => statSync(statePath)).toThrow();
    },
  );
});

it("reports an additive schema migration without querying newer task columns", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-task-store-old-schema-" },
    async () => {
      const database = openOpenClawStateDatabase();
      database.db.exec("ALTER TABLE task_runs DROP COLUMN tool_use_count");
      const schemaSql = "SELECT type, name, sql FROM sqlite_schema ORDER BY name";
      const originalSchema = database.db.prepare(schemaSql).all();
      closeOpenClawStateDatabase();

      expect(loadTaskRegistryStateFromSqliteReadOnly()).toEqual({
        tasks: new Map(),
        deliveryStates: new Map(),
      });
      expect(await getInspectableTaskStatusSummaryReadOnly()).toMatchObject({
        state: "migration-required",
        tasks: { total: 0 },
      });
      const { DatabaseSync } = requireNodeSqlite();
      const readOnly = new DatabaseSync(database.path, { readOnly: true });
      try {
        expect(readOnly.prepare(schemaSql).all()).toEqual(originalSchema);
      } finally {
        readOnly.close();
      }
    },
  );
});

it("renders a cold persisted task through /tasks without parent SQL through close", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async () => {
    try {
      upsertTaskWithDeliveryStateToSqlite({
        task: {
          taskId: "persisted-status-task",
          runtime: "cli",
          requesterSessionKey: sessionKey,
          ownerKey: sessionKey,
          scopeKind: "session",
          task: "persisted worker status",
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: Date.now() - 1_000,
          endedAt: Date.now(),
        },
      });
      closeOpenClawStateDatabase();
      const params = buildCommandTestParams("/tasks", baseCommandTestConfig);
      requireNodeSqlite();
      const sql = observeMainThreadSql();
      const result = await handleTasksCommand(params, true);
      expect(result?.reply?.text).toContain("✅ persisted worker status");
      expect(result?.reply?.text).toContain("Current session: 0 active · 1 total");
      await closeOpenClawStateDatabaseAsync();
      sql.expectIdle();
    } finally {
      vi.restoreAllMocks();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it.each(["tasks", "status"] as const)(
  "keeps /%s responsive while accepted task updates wait for the database",
  async (surface) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      try {
        const runId = `chat-read-${surface}`;
        const task = createTaskFixture("cli", {
          runId,
          requesterSessionKey: sessionKey,
          ownerKey: sessionKey,
          task: "Accepted task completion",
          status: "running",
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
        });
        expect(await renderTaskStatus(surface)).toContain("Accepted task completion");
        await prepareTaskRegistryRead();
        const context = captureOpenClawStateWorkerContext();
        const holder = holdStateDatabaseCoordinator(
          context.admission.databasePath,
          context.coordinatorRuntime,
          300,
        );
        let pending: Promise<string | undefined> | undefined;
        try {
          await holder.ready;
          const timer = sleep(10).then(() => Atomics.load(holder.released, 0));
          emitAgentEvent({
            runId,
            stream: "tool",
            data: { phase: "start", name: "accepted" },
          });
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: { phase: "end", endedAt: Date.now() },
          });
          pending = renderTaskStatus(surface);
          expect(await timer).toBe(0);
          const text = await pending;
          expect(text).toContain("Accepted task completion");
          expect(text).toContain(
            surface === "tasks" ? "Current session: 0 active · 1 total" : "recently finished",
          );
        } finally {
          holder.release();
          await holder.joined;
          await pending;
        }
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
          status: "succeeded",
          toolUseCount: 1,
          lastToolName: "accepted",
        });
      } finally {
        await closeOpenClawStateDatabaseAsync();
      }
    });
  },
);
