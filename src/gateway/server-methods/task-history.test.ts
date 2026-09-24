import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { TasksHistoryResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { markTaskTerminalById, recordTaskProgressByRunId } from "../../tasks/runtime-internal.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "../../tasks/task-executor-create.async.js";
import { getTaskRegistryStore } from "../../tasks/task-registry.store.js";
import {
  createTaskFixture,
  resetTaskRegistryForTests,
} from "../../tasks/task-registry.test-support.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { identifiedClient, runTaskHandler } from "./tasks.test-helpers.js";

type ReadTaskHistory = NonNullable<AgentHarness["taskHistory"]>["read"];
const requesterSessionKey = "agent:main:dashboard:task-parent";
const readerConfig = {
  gateway: {
    roles: {
      default: "reader",
      definitions: {
        reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
      },
    },
  },
} satisfies OpenClawConfig;

function registerHistoryReader(read: ReadTaskHistory) {
  registerAgentHarness({
    id: "synthetic-history",
    label: "Synthetic history",
    supports: () => ({ supported: false }),
    runAttempt: async () => {
      throw new Error("History reads must not start an agent");
    },
    taskHistory: { taskKinds: ["synthetic-child"], read },
  });
}

function createNativeTask(runId = "synthetic-child-1") {
  return createTaskFixture("subagent", {
    taskKind: "synthetic-child",
    runId,
    agentId: "main",
    requesterAgentId: "main",
    requesterSessionKey,
    ownerKey: requesterSessionKey,
    task: "Inspect synthetic files",
  });
}

async function withHistoryState(run: () => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const registry = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetTaskRegistryForTests();
    try {
      await run();
    } finally {
      try {
        await disposeSessionReadContexts();
      } finally {
        try {
          resetTaskRegistryForTests();
        } finally {
          restoreActivePluginRegistrySnapshot(registry);
        }
      }
    }
  });
}

async function createRequester(actorId: string, incognito = false) {
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: requesterSessionKey },
    {
      sessionId: "task-parent",
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: actorId },
      visibility: "shared",
      ...(incognito ? { incognito: true } : {}),
    },
  );
}

describe("tasks.history", () => {
  it.each(["progress", "history identity"] as const)(
    "checks current history while a committed %s result is held",
    async (change) => {
      await withHistoryState(async () => {
        const entered = createDeferred();
        const history = createDeferred();
        const committed = createDeferred();
        const release = createDeferred();
        registerHistoryReader(async ({ assertCurrent }) => {
          entered.resolve();
          await history.promise;
          assertCurrent();
          return { messages: [{ role: "assistant", content: "Held task output" }] };
        });
        const task = createNativeTask(`history-held-${change}`);
        const pending = runTaskHandler("tasks.history", { taskId: task.taskId });
        const store = getTaskRegistryStore();
        // Detached results precede cleanup; the enclosing scope includes root release.
        const scopeRuns = vi.spyOn(AsyncWorkScope.prototype, "run");
        let mutation: Promise<unknown> | undefined;
        try {
          await entered.promise;
          if (change === "progress") {
            const mutate = store.runAgentEventMutationAsync.bind(store);
            vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
              const result = await mutate(...args);
              committed.resolve();
              await release.promise;
              return result;
            });
            emitAgentEvent({
              runId: task.runId!,
              stream: "tool",
              data: { phase: "start", name: "progress" },
            });
          } else {
            const read = store.loadMutationSnapshotAsync.bind(store);
            let held = false;
            vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
              const result = await read(...args);
              if (!held && args[1] && "taskId" in args[1] && args[1].runId === task.runId) {
                held = true;
                committed.resolve();
                await release.promise;
              }
              return result;
            });
            mutation = createRunningTaskRunCoreWithReceiptAsync({
              runtime: task.runtime,
              runId: task.runId!,
              task: task.task,
              taskKind: task.taskKind,
              ownerKey: task.ownerKey,
              scopeKind: task.scopeKind,
              requesterSessionKey: task.requesterSessionKey,
              requesterAgentId: task.requesterAgentId,
              agentId: task.agentId,
              deliveryStatus: task.deliveryStatus,
              notifyPolicy: "silent",
              detail: { historyGeneration: "replacement" },
            });
          }
          await withTestTimeout(
            committed.promise,
            5_000,
            "Task mutation did not reach its held result",
          );
          history.resolve();
          const result = await withTestTimeout(pending, 5_000, "History joined a later mutation");
          if (change === "progress") {
            expect(result.calls[0]?.[0]).toBe(true);
            expect(result.payload?.messages).toEqual([
              { role: "assistant", content: "Held task output" },
            ]);
          } else {
            expect(result.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
            expect(result.payload?.messages).toBeUndefined();
          }
        } finally {
          history.resolve();
          release.resolve();
          try {
            await pending;
            await mutation;
            for (const result of scopeRuns.mock.results) {
              expect(result.type).toBe("return");
              await result.value;
            }
            expect(getActiveGatewayRootWorkCount()).toBe(0);
            resetTaskFlowRegistryForTests({ persist: false });
          } finally {
            scopeRuns.mockRestore();
          }
        }
      });
    },
  );

  it("keeps live history authority across ordinary task progress", async () => {
    await withHistoryState(async () => {
      const entered = createDeferred();
      const release = createDeferred();
      registerHistoryReader(async ({ assertCurrent }) => {
        entered.resolve();
        await release.promise;
        assertCurrent();
        return { messages: [{ role: "assistant", content: "Current task output" }] };
      });
      const task = createNativeTask("history-progress");
      const request = runTaskHandler("tasks.history", { taskId: task.taskId });
      try {
        await entered.promise;
        recordTaskProgressByRunId({ runId: task.runId!, progressSummary: "Ordinary progress" });
      } finally {
        release.resolve();
      }
      const result = await request;
      expect(result.calls[0]?.[0]).toBe(true);
      expect(result.payload?.messages).toEqual([
        { role: "assistant", content: "Current task output" },
      ]);
    });
  });

  it("reads and pages a registered harness transcript without a child session", async () => {
    await withHistoryState(async () => {
      const older = { role: "user", content: "Inspect the files" };
      const latest = {
        role: "toolResult",
        messageId: "latest",
        content: "The files are consistent",
      };
      const activity = [{ messageId: "latest", items: [] }];
      const read = vi.fn<ReadTaskHistory>(async ({ cursor }) =>
        cursor === undefined
          ? { messages: [latest], activity, nextCursor: "older-page" }
          : { messages: [older] },
      );
      registerHistoryReader(read);
      const task = createNativeTask();
      expect(task.childSessionKey).toBeUndefined();
      const summary = await runTaskHandler("tasks.get", { taskId: task.taskId });
      expect(summary.payload?.task).toMatchObject({ hasTranscript: true });
      const first = await runTaskHandler("tasks.history", { taskId: task.taskId, limit: 1 });
      expect(first.calls[0]?.[0]).toBe(true);
      expect(first.payload?.messages).toEqual([latest]);
      expect(first.payload?.activity).toEqual(activity);
      const cursor = expectDefined(first.payload?.nextCursor, "older task history cursor");
      const second = await runTaskHandler("tasks.history", {
        taskId: task.taskId,
        limit: 1,
        cursor,
      });
      expect(second.payload?.messages).toEqual([older]);
      expect(second.payload?.nextCursor).toBeUndefined();
      expect(
        read.mock.calls.map(([params]) => [params.task.runId, params.limit, params.cursor]),
      ).toEqual([
        [task.runId, 1, undefined],
        [task.runId, 1, "older-page"],
      ]);
      const other = createNativeTask("synthetic-child-2");
      const crossed = await runTaskHandler("tasks.history", { taskId: other.taskId, cursor });
      expect(crossed.calls[0]).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
      expect(read).toHaveBeenCalledTimes(2);
    });
  });

  it("reads the OpenClaw child transcript through chat history and preserves pagination", async () => {
    await withHistoryState(async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:subagent:child",
        sessionId: "child",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      for (const content of [
        "First child message",
        "Second child message",
        "Latest child message",
      ]) {
        await appendTranscriptMessage(scope, {
          message:
            content === "Latest child message"
              ? {
                  role: "toolResult",
                  toolCallId: "poll",
                  toolName: "process",
                  isError: false,
                  content,
                  details: {
                    status: "completed",
                    sessionId: "job",
                    aggregated: "done",
                    exitCode: 0,
                  },
                }
              : { role: "assistant", content },
        });
      }
      const task = createTaskFixture("subagent", {
        requesterSessionKey,
        ownerKey: requesterSessionKey,
        childSessionKey: scope.sessionKey,
        runId: "openclaw-child",
        task: "Inspect synthetic files",
      });
      const context = await createHistoryReadContext();
      const first = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId, limit: 2 },
        {},
        null,
        context,
      );
      expect(first.calls[0]?.[0]).toBe(true);
      expect(first.payload?.messages).toMatchObject([
        { content: "Second child message" },
        { content: "Latest child message" },
      ]);
      expect(first.payload?.activity).toEqual([{ messageId: expect.any(String), items: [] }]);
      const cursor = expectDefined(first.payload?.nextCursor, "older child transcript cursor");
      const second = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId, limit: 2, cursor },
        {},
        null,
        context,
      );
      expect(second.payload?.messages).toMatchObject([{ content: "First child message" }]);
      expect(second.payload?.nextCursor).toBeUndefined();
    });
  });

  it("reads and pages the recorded cron generation after its continuation alias is removed", async () => {
    await withHistoryState(async () => {
      const baseKey = "agent:main:cron:history-job";
      const oldScope = { agentId: "main", sessionKey: baseKey, sessionId: "old-cron" };
      await upsertSessionEntryCore(oldScope, { sessionId: oldScope.sessionId, updatedAt: 1 });
      for (const content of ["Old first", "Old second", "Old last"]) {
        await appendTranscriptMessage(oldScope, { message: { role: "assistant", content } });
      }
      const alias = `${baseKey}:run:${oldScope.sessionId}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: alias },
        {
          sessionId: oldScope.sessionId,
          updatedAt: 1,
        },
      );
      const removed = await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        target: { canonicalKey: alias, storeKeys: [alias] },
        archiveTranscript: false,
        expectedSessionId: oldScope.sessionId,
      });
      expect(removed.deleted).toBe(true);
      const latest = { ...oldScope, sessionId: "new-cron" };
      await upsertSessionEntryCore(latest, { sessionId: latest.sessionId, updatedAt: 2 });
      await appendTranscriptMessage(latest, {
        message: { role: "assistant", content: "Latest run only" },
      });
      const task = createTaskFixture("cron", {
        taskKind: "automation_run",
        sourceId: "history-job",
        runId: "internal-old-run",
        requesterSessionKey: "",
        ownerKey: "",
        scopeKind: "system",
        childSessionKey: alias,
        agentId: "main",
        task: "History job",
        detail: { kind: "cron-run", sessionId: oldScope.sessionId },
      });
      const context = await createHistoryReadContext();
      const first = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId, limit: 2 },
        {},
        null,
        context,
      );
      expect(first.calls[0]?.[0]).toBe(true);
      expect(first.payload?.messages).toMatchObject([
        { content: "Old second" },
        { content: "Old last" },
      ]);
      const cursor = expectDefined(first.payload?.nextCursor, "older cron history cursor");
      const second = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId, limit: 2, cursor },
        {},
        null,
        context,
      );
      expect(second.payload?.messages).toMatchObject([{ content: "Old first" }]);
      expect(second.payload?.nextCursor).toBeUndefined();
      const rotationContext = await createHistoryReadContext({
        readChatStartupProjection: async () => {
          await upsertSessionEntryCore(oldScope, { sessionId: "concurrent-new-run", updatedAt: 3 });
          return undefined;
        },
      });
      const duringRotation = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId, limit: 2 },
        {},
        null,
        rotationContext,
      );
      expect(duringRotation.calls[0]?.[0]).toBe(true);
      expect(duringRotation.payload?.messages).toMatchObject([
        { content: "Old second" },
        { content: "Old last" },
      ]);
      const baseScope = { agentId: "main", sessionKey: baseKey };
      await upsertSessionEntryCore(baseScope, {
        sessionId: "shared-new-run",
        updatedAt: 4,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "another-owner" },
      });
      const revokedContext = await createHistoryReadContext({
        readChatStartupProjection: async () => {
          await upsertSessionEntryCore(baseScope, {
            sessionId: "private-new-run",
            updatedAt: 5,
          });
          await patchSessionEntryCore(baseScope, () => ({ visibility: "draft" }));
          return undefined;
        },
      });
      const revoked = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId },
        {},
        identifiedClient(["operator.read"], "retained-viewer"),
        revokedContext,
      );
      expect(loadGatewaySessionEntryReadOnly(baseKey, { agentId: "main" }).entry).toMatchObject({
        sessionId: "private-new-run",
        visibility: "draft",
      });
      expect(revoked.calls[0]).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
      expect(revoked.payload?.messages).toBeUndefined();
      const changedContext = await createHistoryReadContext({
        readChatStartupProjection: async () => {
          markTaskTerminalById({
            taskId: task.taskId,
            status: "succeeded",
            endedAt: 3,
            detail: { kind: "cron-run", sessionId: latest.sessionId },
          });
          return undefined;
        },
      });
      const stale = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId },
        {},
        null,
        changedContext,
      );
      expect(stale.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
      expect(stale.payload?.messages).toBeUndefined();
      const changed = await runTaskHandler(
        "tasks.history",
        { taskId: task.taskId, cursor },
        {},
        null,
        context,
      );
      expect(changed.calls[0]).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
    });
  });

  it.each(["unrelated", "missing", "unrecorded"] as const)(
    "does not substitute current history for a %s cron generation",
    async (generation) => {
      await withHistoryState(async () => {
        const baseKey = "agent:main:cron:history-job";
        for (const [sessionKey, sessionId] of [
          [baseKey, "latest"],
          ["agent:main:cron:another-job", "unrelated"],
        ] as const) {
          const scope = { agentId: "main", sessionKey, sessionId };
          await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
          await appendTranscriptMessage(scope, {
            message: { role: "assistant", content: "Not this run" },
          });
        }
        const task = createTaskFixture("cron", {
          taskKind: "automation_run",
          sourceId: "history-job",
          runId: "old-run",
          requesterSessionKey: "",
          ownerKey: "",
          scopeKind: "system",
          childSessionKey: baseKey,
          agentId: "main",
          task: "History job",
          detail: {
            kind: "cron-run",
            ...(generation === "unrecorded" ? {} : { sessionId: generation }),
          },
        });
        const result = await runTaskHandler(
          "tasks.history",
          { taskId: task.taskId },
          {},
          null,
          await createHistoryReadContext(),
        );
        expect(result.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
        expect(result.payload?.messages).toBeUndefined();
      });
    },
  );

  it.each(["own", "foreign", "incognito"] as const)(
    "checks %s requester access before invoking the harness",
    async (access) => {
      await withHistoryState(async () => {
        const viewer = ensureProfileForEmail("viewer@example.test");
        await createRequester(
          access === "own" ? viewer.id : "someone-else",
          access === "incognito",
        );
        const task = createNativeTask();
        const read = vi.fn<ReadTaskHistory>(async () => ({
          messages: [{ role: "assistant", content: "Child output" }],
        }));
        registerHistoryReader(read);
        const result = await runTaskHandler(
          "tasks.history",
          { taskId: task.taskId },
          readerConfig,
          identifiedClient(["operator.read"], viewer.id),
        );
        if (access === "own") {
          expect(result.payload?.messages).toEqual([
            { role: "assistant", content: "Child output" },
          ]);
          expect(read).toHaveBeenCalledTimes(1);
        } else {
          expect(result.calls[0]).toMatchObject([false, undefined, { message: "Task not found." }]);
          expect(read).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each(["task identity", "history owner", "requester access", "harness registration"] as const)(
    "revalidates %s after an asynchronous history read",
    async (change) => {
      await withHistoryState(async () => {
        const viewer = ensureProfileForEmail("viewer@example.test");
        await createRequester(change === "requester access" ? "someone-else" : viewer.id);
        let config: OpenClawConfig = structuredClone(readerConfig);
        if (change === "requester access") {
          config.gateway!.roles!.definitions.reader!.sessions = { others: "view" };
        }
        const context = await createHistoryReadContext({ getRuntimeConfig: () => config });
        const task = createNativeTask();
        const entered = createDeferred();
        const history = createDeferred<TasksHistoryResult>();
        registerHistoryReader(async () => {
          entered.resolve();
          return await history.promise;
        });
        const pending = runTaskHandler(
          "tasks.history",
          { taskId: task.taskId },
          config,
          identifiedClient(["operator.read"], viewer.id),
          context,
        );
        await entered.promise;
        if (change === "task identity") {
          markTaskTerminalById({
            taskId: task.taskId,
            status: "succeeded",
            endedAt: Date.now(),
            childSessionKey: "agent:main:subagent:new-child",
          });
        } else if (change === "history owner") {
          markTaskTerminalById({
            taskId: task.taskId,
            status: "succeeded",
            endedAt: Date.now(),
            detail: { nativeHistory: { parentThreadId: "different-owner" } },
          });
        } else if (change === "requester access") {
          config = readerConfig;
        } else {
          registerHistoryReader(async () => ({ messages: [] }));
        }
        history.resolve({
          messages: [{ role: "assistant", content: "Output from stale authority" }],
        });
        const result = await pending;
        expect(result.calls).toHaveLength(1);
        expect(result.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
        expect(result.payload?.messages).toBeUndefined();
      });
    },
  );
});
