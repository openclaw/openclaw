/**
 * Tests for task gateway methods and persisted task lifecycle responses.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { TASKS_LIST_CURSOR_MAX_LENGTH } from "../../../packages/gateway-protocol/src/index.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import * as taskRuntime from "../../tasks/runtime-internal.js";
import {
  finalizeTaskRecordByRunId,
  getTaskById,
  markTaskTerminalById,
  recordTaskProgressByRunId,
} from "../../tasks/runtime-internal.js";
import { createAcpTaskBackingDetailForTest } from "../../tasks/task-backing-authority.test-support.js";
import { updateTaskStateByRunId } from "../../tasks/task-registry-record-api.js";
import { reloadTaskRegistryFromStoreAsync } from "../../tasks/task-registry-state.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import { createTaskFixture } from "../../tasks/task-registry.test-support.js";
import { seedTaskRegistryRowsForTests } from "../../test-utils/task-registry-sqlite.js";
import { createInMemoryTaskRegistryStore } from "../../test-utils/task-registry-store.js";
import {
  getTaskPayload,
  mainSessionTaskScope,
  useTaskGatewayFixture,
} from "./tasks.fixture.test-support.js";
import {
  createContext,
  createSnapshotTask,
  identifiedClient,
  runTaskHandler,
} from "./tasks.test-helpers.js";

const { cancelSessionMock } = useTaskGatewayFixture();

describe("tasks gateway handlers", () => {
  it.each([
    { change: "mutation", continuation: false },
    { change: "mutation", continuation: true },
    { change: "replacement", continuation: false },
    { change: "replacement", continuation: true },
  ])(
    "revalidates a selected page after $change before responding (cursor: $continuation)",
    async ({ change, continuation }) => {
      const task = createTaskFixture("cli", {
        ...mainSessionTaskScope,
        task: "Selected before the response turn",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        lastEventAt: 200,
      });
      createTaskFixture("cli", {
        ...mainSessionTaskScope,
        task: "Second page",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        lastEventAt: 100,
      });
      const context = createContext();
      const first = await runTaskHandler("tasks.list", { limit: 1 }, {}, null, context);
      const select = taskRuntime.listTaskRecordPage;
      const replacement = { ...task, taskId: "replacement", task: "Current registry" };
      let reload: Promise<void> | undefined;
      let changed = false;
      const spy = vi.spyOn(taskRuntime, "listTaskRecordPage").mockImplementation(async (params) => {
        const page = await select(params);
        if (!changed && page.ok) {
          changed = true;
          queueMicrotask(() => {
            if (change === "mutation") {
              markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 300 });
            } else {
              configureTaskRegistryRuntime({
                store: createInMemoryTaskRegistryStore({
                  tasks: new Map([[replacement.taskId, replacement]]),
                  deliveryStates: new Map(),
                }),
              });
              reload = reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
            }
          });
        }
        return page;
      });
      try {
        const result = await runTaskHandler(
          "tasks.list",
          { limit: 1, ...(continuation ? { cursor: first.payload?.nextCursor } : {}) },
          {},
          null,
          context,
        );
        expect(changed).toBe(true);
        if (continuation) {
          expect(result.calls[0]).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
        } else {
          expect(result.calls[0]?.[0]).toBe(true);
          expect(result.payload?.tasks).toMatchObject([
            change === "mutation"
              ? { id: task.taskId, status: "completed" }
              : { id: replacement.taskId, title: replacement.task },
          ]);
        }
      } finally {
        await reload;
        spy.mockRestore();
      }
    },
  );

  it("lists task summaries with SDK-facing statuses and filters", async () => {
    const running = createTaskFixture("subagent", {
      taskKind: "investigation",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:worker:subagent:child",
      agentId: "main",
      runId: "run-running",
      task: "Investigate issue",
      status: "running",
      deliveryStatus: "pending",
    });
    createTaskFixture("cli", {
      requesterSessionKey: "agent:other:main",
      ownerKey: "agent:other:main",
      scopeKind: "session",
      runId: "run-other",
      task: "Other task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, payload } = await runTaskHandler("tasks.list", {
      status: "running",
      agentId: "main",
      sessionKey: "main",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.tasks).toHaveLength(1);
    const listedTask = payload?.tasks?.[0];
    expect(listedTask?.id).toBe(running.taskId);
    expect(listedTask?.taskId).toBe(running.taskId);
    expect(listedTask?.kind).toBe("investigation");
    expect(listedTask?.runtime).toBe("subagent");
    expect(listedTask?.status).toBe("running");
    expect(listedTask?.title).toBe("Investigate issue");
    expect(listedTask?.agentId).toBe("main");
    expect(listedTask?.sessionKey).toBe("agent:main:main");
    expect(listedTask?.childSessionKey).toBe("agent:worker:subagent:child");
    expect(listedTask?.runId).toBe("run-running");

    const canonical = await runTaskHandler("tasks.list", {
      status: "running",
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    expect(canonical.payload?.tasks?.map((task) => task.taskId)).toEqual([running.taskId]);
  });

  it("orders the ledger by last activity, not creation time", async () => {
    // The registry lists newest-created first; the wire must page by last
    // activity so an old task that just finished is not hidden behind
    // newer-created records.
    const base = Date.now();
    const oldButJustFinished = createTaskFixture("subagent", {
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Old long-running task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      lastEventAt: base + 60_000,
    });
    const newerQuietTask = createTaskFixture("cli", {
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Newer quiet task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      lastEventAt: base + 1_000,
    });

    const { payload } = await runTaskHandler("tasks.list", {});
    const ids = payload?.tasks?.map((task) => task.id);
    expect(ids?.indexOf(oldButJustFinished.taskId)).toBeLessThan(
      ids?.indexOf(newerQuietTask.taskId) ?? -1,
    );
  });

  it("ranks terminal tasks by completion time when the progress timestamp is stale", async () => {
    const base = Date.now();
    const justFinished = createSnapshotTask({
      taskId: "task-just-finished",
      runId: "run-just-finished",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      createdAt: base - 10_000,
      startedAt: base - 9_000,
      lastEventAt: base - 5_000,
      endedAt: base - 1_000,
    });
    const finishedEarlier = createSnapshotTask({
      taskId: "task-finished-earlier",
      runId: "run-finished-earlier",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      createdAt: base - 8_000,
      startedAt: base - 7_000,
      lastEventAt: base - 2_000,
      endedAt: base - 3_000,
    });
    seedTaskRegistryRowsForTests([justFinished, finishedEarlier]);
    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());

    const { payload } = await runTaskHandler("tasks.list", {});

    expect(payload?.tasks?.map((task) => task.taskId)).toEqual([
      justFinished.taskId,
      finishedEarlier.taskId,
    ]);
  });

  it("ranks a terminal task by its later activity when completion trails it", async () => {
    const base = Date.now();
    const laterActivity = createSnapshotTask({
      taskId: "task-later-activity",
      runId: "run-later-activity",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      createdAt: base - 10_000,
      startedAt: base - 9_000,
      lastEventAt: base - 100,
      endedAt: base - 2_000,
    });
    const laterCompletion = createSnapshotTask({
      taskId: "task-later-completion",
      runId: "run-later-completion",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      createdAt: base - 8_000,
      startedAt: base - 7_000,
      lastEventAt: base - 4_000,
      endedAt: base - 500,
    });
    seedTaskRegistryRowsForTests([laterActivity, laterCompletion]);
    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());

    const { payload } = await runTaskHandler("tasks.list", {});
    const byId = new Map(payload?.tasks?.map((task) => [task.taskId, task]));

    expect(payload?.tasks?.map((task) => task.taskId)).toEqual([
      laterActivity.taskId,
      laterCompletion.taskId,
    ]);
    expect(byId.get("task-later-activity")?.updatedAt).toBe(base - 100);
    expect(byId.get("task-later-completion")?.updatedAt).toBe(base - 500);
  });

  it("preserves activity ordering across unchanged cursor pages", async () => {
    const created = [500, 100, 700, 300, 500].map((lastEventAt, index) =>
      createTaskFixture("cli", {
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: `run-page-${index}`,
        task: `Paged task ${index}`,
        status: "succeeded",
        deliveryStatus: "not_applicable",
        lastEventAt,
      }),
    );
    const expectedIds = created
      .toSorted((left, right) => {
        const updatedDiff = (right.lastEventAt ?? 0) - (left.lastEventAt ?? 0);
        if (updatedDiff !== 0) {
          return updatedDiff;
        }
        return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
      })
      .map((task) => task.taskId);
    const context = createContext();
    const client = identifiedClient(["operator.read"]);

    const page1 = await runTaskHandler("tasks.list", { limit: 2 }, {}, client, context);
    expect(page1.payload?.tasks?.map((task) => task.id)).toEqual(expectedIds.slice(0, 2));
    expect(page1.payload?.nextCursor).toEqual(expect.any(String));
    expect(page1.payload?.nextCursor?.length).toBeLessThanOrEqual(TASKS_LIST_CURSOR_MAX_LENGTH);

    const page2 = await runTaskHandler(
      "tasks.list",
      { limit: 2, cursor: page1.payload?.nextCursor },
      {},
      client,
      context,
    );
    expect(page2.payload?.tasks?.map((task) => task.id)).toEqual(expectedIds.slice(2, 4));

    const page3 = await runTaskHandler(
      "tasks.list",
      { limit: 2, cursor: page2.payload?.nextCursor },
      {},
      client,
      context,
    );
    expect(page3.payload?.tasks?.map((task) => task.id)).toEqual(expectedIds.slice(4));
    expect(page3.payload?.nextCursor).toBeUndefined();

    const priorContext = await runTaskHandler(
      "tasks.list",
      { limit: 2, cursor: page1.payload?.nextCursor },
      {},
      client,
      createContext(),
    );
    expect(priorContext.calls[0]?.[2]?.code).toBe("INVALID_REQUEST");
  });

  it("rejects a continuation after task activity changes", async () => {
    const created = [400, 300, 200, 100].map((lastEventAt, index) =>
      createTaskFixture("cli", {
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: `run-stale-page-${index}`,
        task: `Stale page task ${index}`,
        status: "running",
        deliveryStatus: "pending",
        lastEventAt,
      }),
    );
    const context = createContext();
    const client = identifiedClient(["operator.read"]);
    const page1 = await runTaskHandler("tasks.list", { limit: 2 }, {}, client, context);
    expect(page1.payload?.tasks?.map((task) => task.id)).toEqual([
      created[0]?.taskId,
      created[1]?.taskId,
    ]);

    recordTaskProgressByRunId({
      runId: created[3]?.runId ?? "",
      lastEventAt: 500,
    });

    const page2 = await runTaskHandler(
      "tasks.list",
      { limit: 2, cursor: page1.payload?.nextCursor },
      {},
      client,
      context,
    );
    expect(page2.calls[0]).toMatchObject([
      false,
      undefined,
      {
        code: "INVALID_REQUEST",
        message: "invalid or expired tasks.list cursor; restart pagination without a cursor",
      },
    ]);
  });

  it("uses task id as the stable activity-order tie break", async () => {
    const sharedActivityAt = 5_000;
    const laterId = createSnapshotTask({
      taskId: "task-z",
      runId: "run-z",
      lastEventAt: sharedActivityAt,
    });
    const earlierId = createSnapshotTask({
      taskId: "task-a",
      runId: "run-a",
      lastEventAt: sharedActivityAt,
    });
    seedTaskRegistryRowsForTests([laterId, earlierId]);
    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());

    const { payload } = await runTaskHandler("tasks.list", {});

    expect(payload?.tasks?.map((task) => task.taskId)).toEqual(["task-a", "task-z"]);
  });

  it("clones only the requested task page", async () => {
    for (let index = 0; index < 6; index++) {
      createTaskFixture("cli", {
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        task: `Task ${index}`,
        status: "succeeded",
        deliveryStatus: "not_applicable",
        detail: { index },
      });
    }
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    try {
      const { payload } = await runTaskHandler("tasks.list", { limit: 2 });

      expect(payload?.tasks).toHaveLength(2);
      expect(payload?.nextCursor).toEqual(expect.any(String));
      expect(cloneSpy).toHaveBeenCalledTimes(2);
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it.each(["incognito", "none", "view"] as const)(
    "enforces %s session access on indirect task selectors",
    async (access) => {
      const profileId =
        access === "incognito"
          ? "viewer@example.com"
          : ensureProfileForEmail("viewer@example.com").id;
      const foreignKey = `agent:main:dashboard:${access === "incognito" ? "incognito-" : ""}foreign`;
      const ownKey = "agent:main:own-task";
      for (const [sessionKey, actorId] of [
        [foreignKey, "owner@example.com"],
        [ownKey, profileId],
      ] satisfies [string, string][]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: `session-${sessionKey}`,
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: actorId },
            visibility: "shared",
            ...(access === "incognito" && sessionKey === foreignKey ? { incognito: true } : {}),
          },
        );
      }
      const createTask = (sessionKey: string, lastEventAt: number) =>
        createTaskFixture("cli", {
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
          ownerKey: sessionKey,
          scopeKind: "session",
          task: sessionKey,
          status: "running",
          deliveryStatus: "pending",
          lastEventAt,
        });
      const foreign = createTask(foreignKey, 2_000);
      const own = createTask(ownKey, 1_000);
      const guest: GatewayOperatorRoleDefinition = {
        sessions: { others: access === "none" ? "none" : "view" },
        agents: "*",
        scopes: ["operator.read", "operator.write"],
      };
      const config: OpenClawConfig =
        access === "incognito"
          ? {}
          : { gateway: { roles: { default: "guest", definitions: { guest } } } };
      const viewer = identifiedClient(["operator.read", "operator.write"], profileId);
      const taskId = foreign.taskId;
      const selection = { taskIds: [taskId] };
      const list = await runTaskHandler("tasks.list", { limit: 1 }, config, viewer);
      const visibleForeign = access === "view";
      expect(list.payload?.tasks?.map((task) => task.taskId)).toEqual([
        visibleForeign ? taskId : own.taskId,
      ]);
      expect(list.payload?.nextCursor).toEqual(visibleForeign ? expect.any(String) : undefined);
      const get = await runTaskHandler("tasks.get", { taskId }, config, viewer);
      if (visibleForeign) {
        expect(get.payload?.task?.taskId).toBe(taskId);
      } else {
        expect(get.calls[0]).toMatchObject([
          false,
          undefined,
          { message: `task not found: ${taskId}` },
        ]);
      }
      const cancel = await runTaskHandler("tasks.cancel", { taskId }, config, viewer);
      expect(cancel.payload).toMatchObject({ found: false, cancelled: false });
      for (const method of ["tasks.retry", "tasks.dismiss"] as const) {
        const result = await runTaskHandler(method, selection, config, viewer);
        expect(result.payload?.results).toEqual([{ taskId, ok: false, reason: "task not found" }]);
      }
      if (visibleForeign) {
        addSessionMember(
          { agentId: "main", sessionKey: foreignKey },
          {
            identityId: profileId,
            addedBy: "owner@example.com",
            expectedSessionId: `session-${foreignKey}`,
          },
        );
        const invited = await runTaskHandler("tasks.retry", selection, config, viewer);
        expect(invited.payload?.results?.[0]?.reason).not.toBe("task not found");
      }
      const admin = await runTaskHandler(
        "tasks.get",
        { taskId },
        config,
        identifiedClient(["operator.admin"], profileId),
      );
      expect(admin.calls[0]?.[0]).toBe(true);
      expect(admin.payload?.task?.taskId).toBe(taskId);
    },
  );

  it("treats explicit task agentId as authoritative over the session-key fallback", async () => {
    // Cross-agent subagent task: the registry derives agentId=worker from the
    // child session key, while owner/requester keys belong to main. tasks.list
    // for main must not leak the worker task through the session-key fallback.
    const workerTask = createTaskFixture("subagent", {
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:worker:subagent:child",
      runId: "run-worker-authoritative",
      task: "Inspect worker state",
      status: "running",
      deliveryStatus: "pending",
    });
    expect(workerTask.agentId).toBe("worker");

    const mainView = await runTaskHandler("tasks.list", { agentId: "main" });
    expect(mainView.calls[0]?.[0]).toBe(true);
    expect(mainView.payload?.tasks ?? []).toEqual([]);

    const workerView = await runTaskHandler("tasks.list", { agentId: "worker" });
    expect(workerView.payload?.tasks?.map((task) => task.taskId)).toEqual([workerTask.taskId]);
  });

  const cliStaleResult = { runtime: "cli", progressSummary: "CLI stale progress" } as const;

  it.each([
    {
      label: "subagent completion",
      runtime: "subagent",
      progressSummary: "Subagent canonical result",
      terminalSummary: "Subagent terminal status",
      expected: "Subagent canonical result",
    },
    {
      label: "ACP completion",
      runtime: "acp",
      progressSummary: "ACP canonical result",
      terminalSummary: "ACP terminal status",
      expected: "ACP canonical result",
    },
    {
      label: "cron completion",
      runtime: "cron",
      progressSummary: "Cron stale progress",
      terminalSummary: "Cron canonical result",
      expected: "Cron canonical result",
    },
    {
      label: "CLI completion",
      ...cliStaleResult,
      terminalSummary: "CLI canonical result",
      expected: "CLI canonical result",
    },
    {
      label: "CLI sanitized terminal result",
      ...cliStaleResult,
      terminalSummary: "Exec denied (gateway id=req-1, approval-timeout): bash -lc ls",
      expected: "Command did not run: approval timed out.",
    },
    {
      label: "CLI blocked media references",
      ...cliStaleResult,
      terminalSummary: 'Delivery failed.\nRetained media: path="/tmp/proof.png"',
      expected: 'Delivery failed. Retained media: path="/tmp/proof.png"',
    },
    {
      label: "cron progress fallback",
      runtime: "cron",
      progressSummary: "Cron fallback result",
      terminalSummary: undefined,
      expected: "Cron fallback result",
    },
    {
      label: "cron blank-terminal fallback",
      runtime: "cron",
      progressSummary: "Cron blank-terminal fallback result",
      terminalSummary: "",
      preserveTerminalSummary: true,
      expected: "Cron blank-terminal fallback result",
    },
    {
      label: "CLI progress fallback",
      runtime: "cli",
      progressSummary: "CLI fallback result",
      terminalSummary: undefined,
      expected: "CLI fallback result",
    },
  ] as const)("returns the runtime-owned result for $label", async (fixture) => {
    const task = createTaskFixture(fixture.runtime, {
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: fixture.label,
      status: "succeeded",
      deliveryStatus: "not_applicable",
      progressSummary: fixture.progressSummary,
      terminalSummary: fixture.terminalSummary,
    });
    if ("preserveTerminalSummary" in fixture) {
      expectDefined(
        markTaskTerminalById({
          taskId: task.taskId,
          status: "succeeded",
          endedAt: Date.now(),
          terminalSummary: fixture.terminalSummary,
          preserveTerminalSummary: fixture.preserveTerminalSummary,
        }),
        "expected preserved terminal summary task",
      );
    }

    const { payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.result).toBe(fixture.expected);
  });

  it("keeps complete prompts lookup-only", async () => {
    const prompt = `Inspect the task prompt ${"x".repeat(5_000)}\n  Keep the final command argument.`;
    const task = createTaskFixture("cli", {
      ...mainSessionTaskScope,
      task: prompt,
      status: "running",
      deliveryStatus: "pending",
    });

    const listed = await runTaskHandler("tasks.list", {});
    expect(listed.payload?.tasks?.[0]?.prompt).toBeUndefined();

    const { payload } = await getTaskPayload(task.taskId);
    expect(payload?.task?.prompt).toBe(prompt);
  });

  it.each([
    ["Review this workflow:", "", "  ```yaml", "  steps:", "    - test", "  ```"].join("\n"),
    "printf A\n\nprintf A",
    "printf '<final>literal argument</final>\n'",
  ])(
    "preserves task input verbatim while removing internal runtime context %#",
    async (visiblePrompt) => {
      const task = createTaskFixture("cli", {
        ...mainSessionTaskScope,
        task: `${visiblePrompt}\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nhidden\n${INTERNAL_RUNTIME_CONTEXT_END}`,
        status: "running",
        deliveryStatus: "pending",
      });

      const { payload } = await getTaskPayload(task.taskId);

      expect(payload?.task?.prompt).toBe(visiblePrompt);
    },
  );

  it("sanitizes task text before exposing SDK summaries", async () => {
    const task = createTaskFixture("cli", {
      ...mainSessionTaskScope,
      runId: "run-sanitized",
      label:
        "Compile artifact\nOpenClaw runtime context (internal): Keep internal details private.",
      task: "Compile artifact",
      status: "running",
      deliveryStatus: "pending",
    });
    recordTaskProgressByRunId({
      runId: "run-sanitized",
      progressSummary:
        "Bundling output\nOpenClaw runtime context (internal): Keep internal details private.",
    });
    emitAgentEvent({
      runId: "run-sanitized",
      stream: "assistant",
      data: { text: "OpenClaw runtime context (internal): Keep internal details private." },
    });
    markTaskTerminalById({
      taskId: task.taskId,
      status: "failed",
      endedAt: Date.now(),
      terminalSummary:
        "Failed after build\nOpenClaw runtime context (internal): Keep internal details private.",
      error: "Tool failed\nOpenClaw runtime context (internal): Keep internal details private.",
    });

    const { calls, payload } = await getTaskPayload(task.taskId);

    expect(payload?.task?.title).toBe("Compile artifact");
    expect(payload?.task?.terminalSummary).toBe("Failed after build");
    expect(payload?.task?.error).toBe("Tool failed");
    expect(payload?.task).not.toHaveProperty("lastActivity");
    expect(payload?.task?.prompt).toBe("Compile artifact");
    expect(JSON.stringify(calls[0]?.[1])).not.toContain("OpenClaw runtime context");
  });

  it("does not report cancellation for an ordinary task without a live owner", async () => {
    const task = createTaskFixture("cli", {
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-cancel",
      task: "Cancelable task",
      status: "running",
      deliveryStatus: "pending",
    });

    const { calls, payload } = await runTaskHandler("tasks.cancel", {
      taskId: task.taskId,
      reason: "user stopped task",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.found).toBe(true);
    expect(payload?.cancelled).toBe(false);
    expect(payload?.task?.id).toBe(task.taskId);
    expect(payload?.task?.status).toBe("running");
    expect(payload?.task?.error).toBeUndefined();
  });

  it("refuses native subagent cancellation and preserves the harness result", async () => {
    const task = createTaskFixture("subagent", {
      ...mainSessionTaskScope,
      taskKind: "codex-native",
      runId: "codex-thread:native-child",
      task: "Native child task",
      notifyPolicy: "silent",
    });

    const { calls, payload } = await runTaskHandler("tasks.cancel", { taskId: task.taskId });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload).toMatchObject({
      found: true,
      cancelled: false,
      reason:
        "This subagent is controlled by its native harness. Use the parent session's native collaboration tools to stop it.",
      task: { id: task.taskId, status: "running" },
    });
    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
    expect(getTaskById(task.taskId)).toEqual(task);

    finalizeTaskRecordByRunId({
      runId: task.runId!,
      runtime: "subagent",
      sessionKey: task.ownerKey,
      status: "succeeded",
      endedAt: Date.now(),
      terminalSummary: "Native child completed.",
    });
    const completed = await getTaskPayload(task.taskId);
    expect(completed.payload?.task).toMatchObject({
      status: "completed",
      terminalSummary: "Native child completed.",
    });
  });

  it.each([
    ["succeeded", "completed"],
    ["failed", "failed"],
    ["timed_out", "timed_out"],
    ["lost", "failed"],
    ["cancelled", "cancelled"],
  ] as const)(
    "tasks.cancel preserves ACP %s and explains refused cancellation",
    async (status, wireStatus) => {
      const runId = "run-acp-cancel-race";
      const instanceId = "instance-acp-cancel-race";
      const task = createSnapshotTask({
        runtime: "acp",
        runId,
        notifyPolicy: "silent",
        childSessionKey: "agent:main:acp:cancel-race",
        agentId: "main",
        detail: createAcpTaskBackingDetailForTest(instanceId),
      });
      seedTaskRegistryRowsForTests([task]);
      await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
      cancelSessionMock.mockImplementationOnce(async () => {
        updateTaskStateByRunId({
          runId,
          runtime: "acp",
          sessionKey: task.childSessionKey,
          status,
          endedAt: 2_000,
        });
      });

      const { calls, payload } = await runTaskHandler("tasks.cancel", { taskId: task.taskId });

      expect(calls[0]?.[0]).toBe(true);
      expect(cancelSessionMock).toHaveBeenCalledExactlyOnceWith({
        cfg: {},
        sessionKey: "agent:main:acp:cancel-race",
        agentId: "main",
        reason: "task-cancel",
        expectedRunId: runId,
        expectedInstanceId: instanceId,
      });
      expect(payload).toMatchObject({ found: true, cancelled: status === "cancelled" });
      if (status === "cancelled") {
        expect(payload).not.toHaveProperty("reason");
      } else {
        expect(payload).toHaveProperty(
          "reason",
          `Task became ${status} while cancellation was in progress.`,
        );
      }
      expect(payload?.task).toMatchObject({ id: task.taskId, status: wireStatus, endedAt: 2_000 });
      expect(getTaskById(task.taskId)).toMatchObject({ status, endedAt: 2_000 });
    },
  );

  it("cancels the selected ACP instance through the live Gateway handler and control runtime", async () => {
    const instanceId = "instance-acp-primary";
    const task = createSnapshotTask({
      taskId: "task-acp-primary",
      runtime: "acp",
      notifyPolicy: "silent",
      childSessionKey: "agent:codex:acp:child",
      agentId: "codex",
      runId: "run-cancel-acp-gateway",
      task: "Primary ACP task",
      detail: createAcpTaskBackingDetailForTest(instanceId),
    });
    const siblingTask = createSnapshotTask({
      taskId: "task-acp-sibling",
      runtime: "acp",
      notifyPolicy: "silent",
      childSessionKey: "agent:codex:acp:child",
      agentId: "codex",
      runId: "run-cancel-acp-gateway",
      task: "Sibling ACP task",
      createdAt: 1_001,
      startedAt: 1_011,
      lastEventAt: 1_011,
      detail: createAcpTaskBackingDetailForTest("instance-acp-sibling", 2),
    });
    seedTaskRegistryRowsForTests([task, siblingTask]);
    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
    cancelSessionMock.mockResolvedValue(undefined);

    const { calls, payload } = await runTaskHandler("tasks.cancel", {
      taskId: task.taskId,
      reason: "operator requested stop",
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(cancelSessionMock).toHaveBeenCalledExactlyOnceWith({
      cfg: {},
      sessionKey: "agent:codex:acp:child",
      agentId: "codex",
      reason: "operator requested stop",
      expectedRunId: "run-cancel-acp-gateway",
      expectedInstanceId: instanceId,
    });
    expect(payload?.found).toBe(true);
    expect(payload?.cancelled).toBe(true);
    expect(payload?.task?.id).toBe(task.taskId);
    expect(payload?.task?.status).toBe("cancelled");
    expect(getTaskById(task.taskId)?.status).toBe("cancelled");
    expect(getTaskById(siblingTask.taskId)).toEqual(siblingTask);
  });

  it.each([
    ["tasks.retry", "task has no recoverable subagent completion"],
    ["tasks.dismiss", "completion delivery is not blocked"],
  ] as const)("returns one visible refusal per missing task for %s", async (method, reason) => {
    const { calls, payload } = await runTaskHandler(method, {
      taskIds: ["missing-one", "missing-two"],
    });

    expect(calls[0]?.[0]).toBe(true);
    expect(payload?.results).toEqual([
      {
        taskId: "missing-one",
        ok: false,
        reason,
      },
      {
        taskId: "missing-two",
        ok: false,
        reason,
      },
    ]);
  });
});
