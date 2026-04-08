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

  it("sanitizes inline internal runtime fences from visible task titles", async () => {
    createRunningTaskRun({
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:main",
      runId: "run-tasks-inline-fence",
      task: [
        "[Mon 2026-04-06 02:42 GMT+1] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
      ].join("\n"),
      progressSummary: "done",
    });
    completeTaskRunByRunId({
      runId: "run-tasks-inline-fence",
      endedAt: Date.now(),
      terminalSummary: "Finished.",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("[Mon 2026-04-06 02:42 GMT+1]");
    expect(reply.text).not.toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
    expect(reply.text).not.toContain("OpenClaw runtime context (internal):");
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

  it("shows automation counts separately when the current session has no visible tasks", async () => {
    createRunningTaskRun({
      runtime: "cron",
      ownerKey: "system:cron:tasks-automation-running",
      scopeKind: "system",
      requesterSessionKey: "system:cron:tasks-automation-running",
      childSessionKey: "agent:main:cron:tasks-automation-running",
      runId: "run-tasks-automation-running",
      agentId: "main",
      task: "hidden background task",
      progressSummary: "hidden progress detail",
    });

    const reply = await buildTasksReplyForTest({
      sessionKey: "agent:main:empty-session",
    });

    expect(reply.text).toContain("All clear - nothing linked to this session right now.");
    expect(reply.text).toContain("Automation: 1 active · 1 total");
    expect(reply.text).not.toContain("hidden background task");
    expect(reply.text).not.toContain("hidden progress detail");
  });

  it("keeps automation visible separately when the current session has its own tasks", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:tasks-visible",
      runId: "run-tasks-visible",
      task: "visible session task",
    });
    createQueuedTaskRun({
      runtime: "cron",
      ownerKey: "system:cron:tasks-automation-queued",
      scopeKind: "system",
      requesterSessionKey: "system:cron:tasks-automation-queued",
      childSessionKey: "agent:main:cron:tasks-automation-queued",
      runId: "run-tasks-automation-queued",
      agentId: "main",
      task: "hidden automation task",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("Current session: 1 active · 1 total");
    expect(reply.text).toContain("Automation: 1 active · 1 total");
    expect(reply.text).not.toContain("hidden automation task");
  });

  it("counts cron-owned session tasks as automation instead of current-session detail", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      ownerKey: "agent:main:cron:tasks-automation-owned",
      requesterSessionKey: "agent:main:cron:tasks-automation-owned",
      scopeKind: "session",
      childSessionKey: "agent:main:subagent:tasks-automation-owned-child",
      runId: "run-tasks-automation-owned",
      agentId: "main",
      task: "hidden cron-owned task",
      progressSummary: "hidden cron-owned detail",
    });

    const reply = await buildTasksReplyForTest({
      sessionKey: "agent:main:empty-session",
    });

    expect(reply.text).toContain("All clear - nothing linked to this session right now.");
    expect(reply.text).toContain("Automation: 1 active · 1 total");
    expect(reply.text).not.toContain("hidden cron-owned task");
    expect(reply.text).not.toContain("hidden cron-owned detail");
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
