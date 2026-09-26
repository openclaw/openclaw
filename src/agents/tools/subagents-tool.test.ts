// Subagents tool tests cover requester-scoped task listing and cancellation.
import { describe, expect, it, vi } from "vitest";
import { createSubagentTaskBackingDetail } from "../../tasks/task-backing-records.js";
import type { cancelDetachedTaskRunById } from "../../tasks/task-executor.js";
import { emitTaskRegistryObserverEvent } from "../../tasks/task-registry-state.js";
import type { TaskRecord, TaskRuntime, TaskStatus } from "../../tasks/task-registry.types.js";
import { TASK_STATUS_DETAIL_MAX_CHARS } from "../../tasks/task-status.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../subagents/registry/subagent-lifecycle-events.js";
import {
  addSubagentRunForTests,
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "../subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { createSubagentsTool } from "./subagents-tool.js";

function task(params: {
  taskId: string;
  runtime: TaskRuntime;
  status?: TaskStatus;
  ownerKey?: string;
  requesterSessionKey?: string;
  childSessionKey?: string;
  label?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: TaskRecord["terminalOutcome"];
  error?: string;
}): TaskRecord {
  return {
    taskId: params.taskId,
    runtime: params.runtime,
    ownerKey: params.ownerKey ?? "agent:main:main",
    requesterSessionKey: params.requesterSessionKey ?? "agent:main:main",
    scopeKind: "session",
    task: params.taskId,
    status: params.status ?? "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "done_only",
    createdAt: Date.now(),
    lastEventAt: Date.now(),
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
    ...(params.label ? { label: params.label } : {}),
    ...(params.progressSummary ? { progressSummary: params.progressSummary } : {}),
    ...(params.terminalSummary ? { terminalSummary: params.terminalSummary } : {}),
    ...(params.terminalOutcome ? { terminalOutcome: params.terminalOutcome } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

describe("subagents tool", () => {
  it.each(["reparent", "controller", "legacy-controller", "remove", "timeout"] as const)(
    "rechecks the current control graph after %s without trusting retained task links",
    async (transition) => {
      resetSubagentRegistryForTests();
      const retainsReadAccess = transition === "controller" || transition === "legacy-controller";
      const waitsUntilTimeout = transition === "timeout" || retainsReadAccess;
      if (waitsUntilTimeout) {
        vi.useFakeTimers();
      }
      const owner = "agent:main:main";
      const childKey = "agent:main:subagent:controlled-child";
      const childRun: SubagentRunRecord = {
        runId: "controlled-run",
        childSessionKey: childKey,
        controllerSessionKey: owner,
        requesterSessionKey: owner,
        requesterDisplayKey: "main",
        requesterAgentId: "main",
        task: "Observe controlled work",
        generation: 1,
        createdAt: Date.now(),
        cleanup: "keep",
        execution: { status: "running", startedAt: Date.now() },
      };
      addSubagentRunForTests(childRun);
      const childTask = {
        ...task({ taskId: "controlled-task", runtime: "subagent", childSessionKey: childKey }),
        runId: childRun.runId,
        detail: transition === "legacy-controller" ? undefined : createSubagentTaskBackingDetail(1),
      };
      const descendant = task({ taskId: "descendant-task", runtime: "cli", ownerKey: childKey });
      const cancelTask = vi.fn<typeof cancelDetachedTaskRunById>().mockResolvedValue({
        found: true,
        cancelled: true,
      });
      const tool = createSubagentsTool({
        agentSessionKey: owner,
        config: {},
        listTasks: () => [childTask, descendant],
        cancelTask,
      });
      try {
        expect(
          (
            await tool.execute("before", {
              action: "wait",
              taskIds: [descendant.taskId],
              timeoutSeconds: 0,
            })
          ).details,
        ).toMatchObject({ reason: "timeout", tasks: [{ taskId: descendant.taskId }] });
        expect(
          (
            await tool.execute("cancel-before", {
              action: "cancel",
              taskId: descendant.taskId,
            })
          ).details,
        ).toMatchObject({ status: "cancelled", taskId: descendant.taskId });
        expect(cancelTask).toHaveBeenCalledExactlyOnceWith({
          cfg: {},
          taskId: descendant.taskId,
        });
        cancelTask.mockClear();
        const waiting = tool.execute("waiting", {
          action: "wait",
          taskIds: [childTask.taskId, descendant.taskId],
          timeoutSeconds: 1,
        });
        if (transition === "remove") {
          releaseSubagentRun(childRun.runId);
        } else {
          addSubagentRunForTests({
            ...childRun,
            controllerSessionKey: "agent:main:other",
            requesterSessionKey: retainsReadAccess ? owner : "agent:main:other",
          });
        }
        descendant.progressSummary = "FORMER_CHILD_NEW_PRIVATE_WORK";
        if (waitsUntilTimeout) {
          await vi.advanceTimersByTimeAsync(1_000);
        } else {
          descendant.status = "succeeded";
          emitTaskRegistryObserverEvent(() => ({ kind: "upserted", task: descendant }));
        }
        const result = await waiting;
        if (retainsReadAccess) {
          expect(result.details).toMatchObject({
            reason: "timeout",
            tasks: [{ taskId: childTask.taskId }, { taskId: descendant.taskId }],
          });
        } else {
          expect(result.details).toMatchObject({
            reason: "unavailable",
            unavailable: [childTask.taskId, descendant.taskId],
            tasks: [],
          });
          expect(JSON.stringify(result.details)).not.toContain("FORMER_CHILD_NEW_PRIVATE_WORK");
        }
        expect(childTask.ownerKey).toBe(owner);
        expect(
          (
            await tool.execute("cancel-after", {
              action: "cancel",
              taskId: descendant.taskId,
            })
          ).details,
        ).toMatchObject({ status: "forbidden", error: "Task outside session tree." });
        expect(cancelTask).not.toHaveBeenCalled();
        expect((await tool.execute("list", { action: "list" })).details).toMatchObject({
          tasks: expect.arrayContaining([
            expect.objectContaining({ taskId: childTask.taskId }),
            ...(retainsReadAccess ? [expect.objectContaining({ taskId: descendant.taskId })] : []),
          ]),
        });
      } finally {
        vi.useRealTimers();
        resetSubagentRegistryForTests();
      }
    },
  );

  it("waits on harness-owned subagent tasks without borrowing the native registry", async () => {
    const selected = Object.assign(
      task({
        taskId: "external-child",
        runtime: "subagent",
        status: "succeeded",
        childSessionKey: "harness:child",
      }),
      { runId: "harness-run", taskKind: "external-harness" },
    );
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => [selected],
    });
    const result = await tool.execute("wait", {
      action: "wait",
      taskIds: [selected.taskId],
      timeoutSeconds: 0,
    });
    expect(result.details).toMatchObject({ reason: "completed", completed: [selected.taskId] });
  });

  it("waits for the selected task and leaves sibling work and delivery untouched", async () => {
    const selected = task({ taskId: "selected", runtime: "subagent" });
    const sibling = task({ taskId: "sibling", runtime: "cli" });
    const cancelTask = vi.fn();
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => [selected, sibling],
      cancelTask,
    });
    let resolved = false;
    const pending = tool
      .execute("wait", { action: "wait", taskIds: [selected.taskId] })
      .then((result) => {
        resolved = true;
        return result;
      });
    sibling.status = "succeeded";
    emitTaskRegistryObserverEvent(() => ({ kind: "upserted", task: sibling }));
    await Promise.resolve();
    expect(resolved).toBe(false);
    selected.status = "succeeded";
    selected.deliveryStatus = "pending";
    emitTaskRegistryObserverEvent(() => ({ kind: "upserted", task: selected }));
    expect((await pending).details).toMatchObject({
      reason: "completed",
      completed: [selected.taskId],
      tasks: [{ taskId: selected.taskId, deliveryStatus: "pending" }],
    });
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it("rechecks wait ownership and reports blocked work as attention", async () => {
    const selected = task({ taskId: "selected", runtime: "subagent" });
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => [selected],
    });
    const pending = tool.execute("wait", { action: "wait", taskIds: [selected.taskId] });
    selected.ownerKey = "agent:other:main";
    emitTaskRegistryObserverEvent(() => ({ kind: "upserted", task: selected }));
    expect((await pending).details).toMatchObject({
      reason: "unavailable",
      unavailable: [selected.taskId],
      tasks: [],
    });
    selected.ownerKey = "agent:main:main";
    selected.status = "succeeded";
    selected.terminalOutcome = "blocked";
    const result = await tool.execute("attention", { action: "wait", taskIds: [selected.taskId] });
    expect(result.details).toMatchObject({ reason: "attention", attention: [selected.taskId] });
  });

  it("times out or aborts the wait without cancelling its selected task", async () => {
    const selected = task({ taskId: "selected", runtime: "subagent" });
    const cancelTask = vi.fn();
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => [selected],
      cancelTask,
    });
    expect(tool.parameters).toMatchObject({
      properties: {
        timeoutSeconds: {
          description: expect.stringMatching(/integer.*0–60.*default: 30.*0.*snapshot/),
        },
      },
    });
    const result = await tool.execute("snapshot", {
      action: "wait",
      taskIds: [selected.taskId],
      timeoutSeconds: 0,
    });
    expect(result.details).toMatchObject({
      reason: "timeout",
      tasks: [{ taskId: selected.taskId, status: "running" }],
    });
    const controller = new AbortController();
    const pending = tool.execute(
      "abort",
      { action: "wait", taskIds: [selected.taskId] },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("tasks continue running");
    expect(selected.status).toBe("running");
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it("reports a killed subagent truthfully through the actual list tool", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    const run = {
      runId: "run-tool-killed",
      childSessionKey: "agent:main:subagent:tool-killed",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "report the killed child",
      cleanup: "keep",
      createdAt: now - 2_000,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        status: "terminal",
        startedAt: now - 2_000,
        endedAt: now - 1_000,
        outcome: { status: "error", error: "agent run aborted" },
      },
    } satisfies SubagentRunRecord;
    addSubagentRunForTests(run);

    try {
      const tool = createSubagentsTool({
        agentSessionKey: "agent:main:main",
        config: {},
        listTasks: () => [],
      });

      const result = await tool.execute("list-killed", { action: "list" });

      expect(result.details).toMatchObject({
        status: "ok",
        recent: [expect.objectContaining({ runId: run.runId, status: "killed" })],
      });
      expect((result.details as { text: string }).text).toContain(" killed");
    } finally {
      resetSubagentRegistryForTests();
    }
  });

  it("lists cross-runtime tasks in the caller session tree", async () => {
    const tasks = [
      task({
        taskId: "subagent-task",
        runtime: "subagent",
        childSessionKey: "agent:main:dashboard:child",
        label: "Research",
        progressSummary: "Reading",
      }),
      task({ taskId: "acp-task", runtime: "acp", status: "succeeded", terminalSummary: "Done" }),
      task({ taskId: "cli-task", runtime: "cli" }),
      task({ taskId: "cron-task", runtime: "cron" }),
      task({
        taskId: "outside-owner",
        runtime: "cli",
        ownerKey: "agent:other:main",
        requesterSessionKey: "agent:main:main",
      }),
      task({
        taskId: "child-task",
        runtime: "cli",
        ownerKey: "agent:main:dashboard:child",
        requesterSessionKey: "agent:main:dashboard:child",
      }),
      task({
        taskId: "outside",
        runtime: "cron",
        ownerKey: "agent:other:main",
        requesterSessionKey: "agent:other:main",
      }),
    ];
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => tasks,
    });

    const result = await tool.execute("list", { action: "list" });

    expect(result.details).toMatchObject({ status: "ok", taskTotal: 5 });
    const rows = (result.details as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "subagent-task",
          runtime: "subagent",
          status: "running",
          label: "Research",
          progressSummary: "Reading",
        }),
        expect.objectContaining({
          taskId: "acp-task",
          runtime: "acp",
          status: "completed",
          terminalSummary: "Done",
        }),
        expect.objectContaining({ taskId: "cli-task", runtime: "cli" }),
        expect.objectContaining({ taskId: "cron-task", runtime: "cron" }),
        expect.objectContaining({ taskId: "child-task", runtime: "cli" }),
      ]),
    );
    expect(rows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "outside" }),
        expect.objectContaining({ taskId: "outside-owner" }),
      ]),
    );
  });

  it("cancels only tasks in the caller session tree", async () => {
    const tasks = [
      task({ taskId: "inside", runtime: "cli" }),
      task({
        taskId: "outside",
        runtime: "cron",
        ownerKey: "agent:other:main",
        requesterSessionKey: "agent:other:main",
      }),
      task({
        taskId: "outside-owner",
        runtime: "cli",
        ownerKey: "agent:other:main",
        requesterSessionKey: "agent:main:main",
      }),
    ];
    const cancelTask = vi.fn(async () => ({ found: true, cancelled: true }));
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => tasks,
      cancelTask: cancelTask as never,
    });

    await expect(tool.execute("cancel", { action: "cancel", taskId: "inside" })).resolves.toEqual(
      expect.objectContaining({ details: expect.objectContaining({ status: "cancelled" }) }),
    );
    expect(cancelTask).toHaveBeenCalledWith({ cfg: {}, taskId: "inside" });

    await expect(
      tool.execute("cancel-outside", { action: "cancel", taskId: "outside" }),
    ).resolves.toEqual(
      expect.objectContaining({ details: expect.objectContaining({ status: "forbidden" }) }),
    );
    expect(cancelTask).toHaveBeenCalledTimes(1);

    await expect(
      tool.execute("cancel-outside-owner", { action: "cancel", taskId: "outside-owner" }),
    ).resolves.toEqual(
      expect.objectContaining({ details: expect.objectContaining({ status: "forbidden" }) }),
    );
    expect(cancelTask).toHaveBeenCalledTimes(1);
  });

  it.each(["list", "cancel"] as const)(
    "keeps %s available when an unrelated retained task has ambiguous ownership",
    async (action) => {
      const config = { agents: { entries: { alpha: {}, beta: {} } } };
      const cancelTask = vi.fn<typeof cancelDetachedTaskRunById>().mockResolvedValue({
        found: true,
        cancelled: true,
      });
      const tool = createSubagentsTool({
        agentSessionKey: "agent:alpha:main",
        config,
        listTasks: () => [
          task({
            taskId: "legacy-orphan",
            runtime: "cli",
            ownerKey: "global",
            requesterSessionKey: "global",
          }),
          task({
            taskId: "owned-task",
            runtime: "cli",
            ownerKey: "agent:alpha:main",
            requesterSessionKey: "agent:alpha:main",
          }),
        ],
        cancelTask,
      });

      const result = await tool.execute(action, { action, taskId: "owned-task" });

      if (action === "list") {
        expect(result.details).toMatchObject({
          status: "ok",
          taskTotal: 1,
          tasks: [expect.objectContaining({ taskId: "owned-task" })],
        });
        expect(cancelTask).not.toHaveBeenCalled();
      } else {
        expect(result.details).toMatchObject({ status: "cancelled", taskId: "owned-task" });
        expect(cancelTask).toHaveBeenCalledExactlyOnceWith({ cfg: config, taskId: "owned-task" });
      }
    },
  );

  it("preserves blocked terminal outcomes and actionable terminal failure reasons", async () => {
    const tasks = [
      task({
        taskId: "blocked",
        runtime: "acp",
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session authorization required.",
      }),
      task({
        taskId: "failed",
        runtime: "subagent",
        status: "failed",
        error: "Provider rejected the tool call.",
      }),
      task({
        taskId: "timed-out",
        runtime: "cli",
        status: "timed_out",
        error: "Provider timed out before producing output.",
      }),
    ];
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => tasks,
    });

    const result = await tool.execute("list", { action: "list" });

    expect(result.details).toMatchObject({
      status: "ok",
      taskTotal: 3,
      tasks: expect.arrayContaining([
        expect.objectContaining({
          taskId: "blocked",
          status: "blocked",
          terminalOutcome: "blocked",
          terminalSummary: "Writable session authorization required.",
        }),
        expect.objectContaining({
          taskId: "failed",
          status: "failed",
          error: "Provider rejected the tool call.",
        }),
        expect.objectContaining({
          taskId: "timed-out",
          status: "timed_out",
          error: "Provider timed out before producing output.",
        }),
      ]),
    });
  });

  it("bounds terminal failure text with the canonical surrogate-safe task detail budget", async () => {
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => [
        task({
          taskId: "oversized-error",
          runtime: "subagent",
          status: "failed",
          error: "🚀".repeat(20_000),
        }),
      ],
    });

    const result = await tool.execute("list", { action: "list" });
    const [row] = (result.details as { tasks: Array<{ error?: string }> }).tasks;

    if (!row?.error) {
      throw new Error("Expected a sanitized terminal task failure.");
    }
    expect(row.error.length).toBeLessThanOrEqual(TASK_STATUS_DETAIL_MAX_CHARS);
    expect(row.error.endsWith("…")).toBe(true);
    for (const character of row.error) {
      const code = character.charCodeAt(0);
      expect(character.length > 1 || code < 0xd800 || code > 0xdfff).toBe(true);
    }
  });

  it("strips internal provider context and redacts raw approval denial details", async () => {
    const internalContext = [
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "[Internal task completion event]",
      "providerAuthorization: private-provider-context",
    ].join("\n");
    const tool = createSubagentsTool({
      agentSessionKey: "agent:main:main",
      config: {},
      listTasks: () => [
        task({
          taskId: "with-internal-context",
          runtime: "subagent",
          status: "failed",
          error: `Permission denied by ACP runtime.\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n${internalContext}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`,
        }),
        task({
          taskId: "only-internal-context",
          runtime: "subagent",
          status: "failed",
          error: internalContext,
        }),
        task({
          taskId: "approval-denied",
          runtime: "acp",
          status: "failed",
          error: "Exec denied (gateway id=req-1, approval-timeout): bash -lc print-private-context",
        }),
      ],
    });

    const result = await tool.execute("list", { action: "list" });
    const rows = (result.details as { tasks: Array<{ taskId: string; error?: string }> }).tasks;

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "with-internal-context",
          error: "Permission denied by ACP runtime.",
        }),
        expect.objectContaining({
          taskId: "approval-denied",
          error: "Command did not run: approval timed out.",
        }),
      ]),
    );
    expect(rows.find((row) => row.taskId === "only-internal-context")).not.toHaveProperty("error");
    expect(JSON.stringify(result.details)).not.toContain("private-provider-context");
    expect(JSON.stringify(result.details)).not.toContain("print-private-context");
  });

  it.each([0, 1.5])("rejects invalid recentMinutes value %s", async (recentMinutes) => {
    const tool = createSubagentsTool();

    await expect(
      tool.execute("call-1", {
        action: "list",
        recentMinutes,
      }),
    ).rejects.toThrow("recentMinutes must be a positive integer");
  });

  it("lists and cancels retained policy-key tasks for a split-key caller", async () => {
    // Regression for the ClawSweeper P2 finding on #137779: when the listing root switches to
    // the durable key, task rows created by pre-change code still carry the policy key in
    // owner_key. Without the fallback policy key, split-key callers (e.g. Telegram DM) lose
    // sight of retained running tasks and cannot cancel them ("Task outside session tree").
    const durableKey = "agent:main:telegram:direct:456";
    const policyKey = "agent:main:telegram:default:direct:456";
    const tasks = [
      // Retained row from pre-change code: owner_key is the policy key.
      task({
        taskId: "retained-media",
        runtime: "cli",
        ownerKey: policyKey,
        requesterSessionKey: policyKey,
      }),
      // Newly created row: owner_key is the durable key.
      task({
        taskId: "new-spawn",
        runtime: "cli",
        ownerKey: durableKey,
        requesterSessionKey: durableKey,
      }),
    ];

    const cancelTask = vi.fn(async () => ({ found: true, cancelled: true }));
    const tool = createSubagentsTool({
      agentSessionKey: durableKey,
      callerPolicySessionKey: policyKey,
      config: {},
      listTasks: () => tasks,
      cancelTask: cancelTask as never,
    });

    const result = await tool.execute("list", { action: "list" });
    const rows = (result.details as { tasks: Array<{ taskId: string }> }).tasks;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "retained-media" }),
        expect.objectContaining({ taskId: "new-spawn" }),
      ]),
    );

    await expect(
      tool.execute("cancel", { action: "cancel", taskId: "retained-media" }),
    ).resolves.toEqual(
      expect.objectContaining({ details: expect.objectContaining({ status: "cancelled" }) }),
    );
    expect(cancelTask).toHaveBeenCalledWith({ cfg: {}, taskId: "retained-media" });

    const childKey = "agent:main:subagent:retained-native";
    const childRun: SubagentRunRecord = {
      runId: "retained-native-run",
      childSessionKey: childKey,
      controllerSessionKey: policyKey,
      requesterSessionKey: durableKey,
      requesterDisplayKey: durableKey,
      requesterAgentId: "main",
      task: "Retained native work",
      generation: 1,
      createdAt: Date.now(),
      cleanup: "keep",
      execution: { status: "running", startedAt: Date.now() },
    };
    tasks.push(
      {
        ...task({
          taskId: "retained-native",
          runtime: "subagent",
          ownerKey: durableKey,
          requesterSessionKey: durableKey,
          childSessionKey: childKey,
        }),
        runId: childRun.runId,
        detail: createSubagentTaskBackingDetail(1),
      },
      task({ taskId: "retained-descendant", runtime: "cli", ownerKey: childKey }),
    );
    resetSubagentRegistryForTests();
    addSubagentRunForTests(childRun);
    try {
      expect(
        (
          await tool.execute("cancel-native-descendant", {
            action: "cancel",
            taskId: "retained-descendant",
          })
        ).details,
      ).toMatchObject({ status: "cancelled", taskId: "retained-descendant" });
      expect(cancelTask).toHaveBeenCalledWith({ cfg: {}, taskId: "retained-descendant" });
    } finally {
      resetSubagentRegistryForTests();
    }
  });
});
