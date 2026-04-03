import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { buildTasksReply, handleTasksCommand } from "./commands-tasks.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const baseCfg = {
  commands: { text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;

async function buildTasksReplyForTest(params: { sessionKey?: string } = {}) {
  const commandParams = buildCommandTestParams("/tasks", baseCfg);
  return await buildTasksReply({
    ...commandParams,
    sessionKey: params.sessionKey ?? commandParams.sessionKey,
  });
}

describe("buildTasksReply", () => {
  beforeEach(() => {
    resetTaskRegistryForTests();
  });

  afterEach(() => {
    resetTaskRegistryForTests();
  });

  it("lists active and recent tasks for the current session", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:tasks-running",
      runId: "run-tasks-running",
      task: "active background task",
      progressSummary: "still working",
    });
    createQueuedTaskRun({
      runtime: "cron",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:tasks-queued",
      runId: "run-tasks-queued",
      task: "queued background task",
    });
    createRunningTaskRun({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:acp:tasks-failed",
      runId: "run-tasks-failed",
      task: "failed background task",
    });
    failTaskRunByRunId({
      runId: "run-tasks-failed",
      endedAt: Date.now(),
      error: "approval denied",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("📋 Tasks");
    expect(reply.text).toContain("Current session: 2 active · 3 total");
    expect(reply.text).toContain("🟢 active background task");
    expect(reply.text).toContain("🟡 queued background task");
    expect(reply.text).toContain("🔴 failed background task");
    expect(reply.text).toContain("approval denied");
  });

  it("sanitizes leaked internal runtime context from visible task details", async () => {
    createRunningTaskRun({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:acp:tasks-sanitized-failed",
      runId: "run-tasks-sanitized-failed",
      task: "Visible failed task",
      progressSummary: "still working",
    });
    failTaskRunByRunId({
      runId: "run-tasks-sanitized-failed",
      endedAt: Date.now(),
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
      terminalSummary: "Needs a login refresh.",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("Visible failed task");
    expect(reply.text).toContain("Needs a login refresh.");
    expect(reply.text).not.toContain("OpenClaw runtime context (internal):");
    expect(reply.text).not.toContain("Internal task completion event");
  });

  it("hides stale completed tasks from the task board", async () => {
    createQueuedTaskRun({
      runtime: "cron",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:tasks-stale",
      runId: "run-tasks-stale",
      task: "stale completed task",
    });
    completeTaskRunByRunId({
      runId: "run-tasks-stale",
      endedAt: Date.now() - 10 * 60_000,
      terminalSummary: "done a while ago",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("All clear - nothing linked to this session right now.");
    expect(reply.text).not.toContain("stale completed task");
    expect(reply.text).not.toContain("done a while ago");
  });

  it("falls back to agent-local counts when the current session has no visible tasks", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:other-session",
      childSessionKey: "agent:main:subagent:tasks-agent-fallback",
      runId: "run-tasks-agent-fallback",
      agentId: "main",
      task: "hidden background task",
      progressSummary: "hidden progress detail",
    });

    const reply = await buildTasksReplyForTest({
      sessionKey: "agent:main:empty-session",
    });

    expect(reply.text).toContain("All clear - nothing linked to this session right now.");
    expect(reply.text).toContain("Agent-local: 1 active · 1 total");
    expect(reply.text).not.toContain("hidden background task");
    expect(reply.text).not.toContain("hidden progress detail");
  });
});

describe("handleTasksCommand", () => {
  it("returns usage for unsupported args", async () => {
    const params = buildCommandTestParams("/tasks extra", baseCfg);

    const result = await handleTasksCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /tasks" },
    });
  });
});
