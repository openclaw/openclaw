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
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { buildStatusText } from "../status/status-text.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator } from "../test-utils/state-database-contention.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
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
      const native = requireNodeSqlite();
      const counters = [
        vi.spyOn(native.DatabaseSync.prototype, "prepare"),
        vi.spyOn(native.DatabaseSync.prototype, "exec"),
        ...(["iterate", "get", "all", "run"] as const).map((method) =>
          vi.spyOn(native.StatementSync.prototype, method),
        ),
      ];
      const result = await handleTasksCommand(params, true);
      expect(result?.reply?.text).toContain("✅ persisted worker status");
      expect(result?.reply?.text).toContain("Current session: 0 active · 1 total");
      await closeOpenClawStateDatabaseAsync();
      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
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
