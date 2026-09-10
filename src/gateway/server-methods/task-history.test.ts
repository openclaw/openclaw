import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { TasksHistoryResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { markTaskTerminalById } from "../../tasks/runtime-internal.js";
import {
  createTaskFixture,
  resetTaskRegistryForTests,
} from "../../tasks/task-registry.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
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
      resetTaskRegistryForTests();
      restoreActivePluginRegistrySnapshot(registry);
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
  it("reads and pages a registered harness transcript without a child session", async () => {
    await withHistoryState(async () => {
      const older = { role: "user", content: "Inspect the files" };
      const latest = { role: "assistant", content: "The files are consistent" };
      const read = vi.fn<ReadTaskHistory>(async ({ cursor }) =>
        cursor === undefined
          ? { messages: [latest], nextCursor: "older-page" }
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
        await appendTranscriptMessage(scope, { message: { role: "assistant", content } });
      }
      const task = createTaskFixture("subagent", {
        requesterSessionKey,
        ownerKey: requesterSessionKey,
        childSessionKey: scope.sessionKey,
        runId: "openclaw-child",
        task: "Inspect synthetic files",
      });
      const context = createDirectChatContext();
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

  it.each(["task identity", "requester access", "harness registration"] as const)(
    "revalidates %s after an asynchronous history read",
    async (change) => {
      await withHistoryState(async () => {
        const viewer = ensureProfileForEmail("viewer@example.test");
        await createRequester(change === "requester access" ? "someone-else" : viewer.id);
        let config: OpenClawConfig = structuredClone(readerConfig);
        if (change === "requester access") {
          config.gateway!.roles!.definitions.reader!.sessions = { others: "view" };
        }
        const context = createDirectChatContext({ getRuntimeConfig: () => config });
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
