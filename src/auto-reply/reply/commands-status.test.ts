import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { buildStatusReply } from "./commands-status.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const baseCfg = {
  commands: { text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;

async function buildStatusReplyForTest(params: { sessionKey?: string; verbose?: boolean }) {
  const commandParams = buildCommandTestParams("/status", baseCfg);
  const sessionKey = params.sessionKey ?? commandParams.sessionKey;
  return await buildStatusReply({
    cfg: baseCfg,
    command: commandParams.command,
    sessionEntry: commandParams.sessionEntry,
    sessionKey,
    parentSessionKey: sessionKey,
    sessionScope: commandParams.sessionScope,
    storePath: commandParams.storePath,
    provider: "anthropic",
    model: "claude-opus-4-5",
    contextTokens: 0,
    resolvedThinkLevel: commandParams.resolvedThinkLevel,
    resolvedFastMode: false,
    resolvedVerboseLevel: params.verbose ? "on" : commandParams.resolvedVerboseLevel,
    resolvedReasoningLevel: commandParams.resolvedReasoningLevel,
    resolvedElevatedLevel: commandParams.resolvedElevatedLevel,
    resolveDefaultThinkingLevel: commandParams.resolveDefaultThinkingLevel,
    isGroup: commandParams.isGroup,
    defaultGroupActivation: commandParams.defaultGroupActivation,
  });
}

describe("buildStatusReply subagent summary", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetTaskRegistryForTests();
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
    resetTaskRegistryForTests();
  });

  it("counts ended orchestrators with active descendants as active", async () => {
    const parentKey = "agent:main:subagent:status-ended-parent";
    addSubagentRunForTests({
      runId: "run-status-ended-parent",
      childSessionKey: parentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "status orchestrator",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
      endedAt: Date.now() - 110_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-status-active-child",
      childSessionKey: "agent:main:subagent:status-ended-parent:subagent:child",
      requesterSessionKey: parentKey,
      requesterDisplayKey: "subagent:status-ended-parent",
      task: "status child still running",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("dedupes stale rows in the verbose subagent status summary", async () => {
    const childSessionKey = "agent:main:subagent:status-dedupe-worker";
    addSubagentRunForTests({
      runId: "run-status-current",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current status worker",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });
    addSubagentRunForTests({
      runId: "run-status-stale",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale status worker",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
      endedAt: Date.now() - 90_000,
      outcome: { status: "ok" },
    });

    const reply = await buildStatusReplyForTest({ verbose: true });

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
    expect(reply?.text).not.toContain("· 1 done");
  });

  it("does not count a child session that moved to a newer parent in the old parent's status", async () => {
    const oldParentKey = "agent:main:subagent:status-old-parent";
    const newParentKey = "agent:main:subagent:status-new-parent";
    const childSessionKey = "agent:main:subagent:status-shared-child";
    addSubagentRunForTests({
      runId: "run-status-old-parent",
      childSessionKey: oldParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
    });
    addSubagentRunForTests({
      runId: "run-status-new-parent",
      childSessionKey: newParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent",
      cleanup: "keep",
      createdAt: Date.now() - 90_000,
      startedAt: Date.now() - 90_000,
    });
    addSubagentRunForTests({
      runId: "run-status-child-stale-old-parent",
      childSessionKey,
      requesterSessionKey: oldParentKey,
      requesterDisplayKey: oldParentKey,
      controllerSessionKey: oldParentKey,
      task: "stale old parent child",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });
    addSubagentRunForTests({
      runId: "run-status-child-current-new-parent",
      childSessionKey,
      requesterSessionKey: newParentKey,
      requesterDisplayKey: newParentKey,
      controllerSessionKey: newParentKey,
      task: "current new parent child",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
    });

    const reply = await buildStatusReplyForTest({ sessionKey: oldParentKey, verbose: true });

    expect(reply?.text).not.toContain("🤖 Subagents: 1 active");
    expect(reply?.text).not.toContain("stale old parent child");
  });

  it("counts controller-owned runs even when the latest child requester differs", async () => {
    addSubagentRunForTests({
      runId: "run-status-controller-owned",
      childSessionKey: "agent:main:subagent:status-controller-owned",
      requesterSessionKey: "agent:main:requester-only",
      requesterDisplayKey: "requester-only",
      controllerSessionKey: "agent:main:main",
      task: "controller-owned status worker",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("includes active and total task counts for the current session", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-running",
      runId: "run-status-task-running",
      task: "active background task",
      progressSummary: "still working",
    });
    createQueuedTaskRun({
      runtime: "cron",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-queued",
      runId: "run-status-task-queued",
      task: "queued background task",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 2 active · 2 total");
    expect(reply?.text).toMatch(/📌 Tasks: 2 active · 2 total · (subagent|cron) · /);
  });

  it("hides stale completed task rows from the session task line", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-live",
      runId: "run-status-task-live",
      task: "live background task",
      progressSummary: "still working",
    });
    createQueuedTaskRun({
      runtime: "cron",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-stale-done",
      runId: "run-status-task-stale-done",
      task: "stale completed task",
    });
    completeTaskRunByRunId({
      runId: "run-status-task-stale-done",
      endedAt: Date.now() - 10 * 60_000,
      terminalSummary: "done a while ago",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 active · 1 total");
    expect(reply?.text).toContain("live background task");
    expect(reply?.text).not.toContain("stale completed task");
    expect(reply?.text).not.toContain("done a while ago");
  });

  it("shows a recent failure when no active tasks remain", async () => {
    createRunningTaskRun({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:acp:status-task-failed",
      runId: "run-status-task-failed",
      task: "failed background task",
    });
    failTaskRunByRunId({
      runId: "run-status-task-failed",
      endedAt: Date.now(),
      error: "approval denied",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 recent failure");
    expect(reply?.text).toContain("failed background task");
    expect(reply?.text).toContain("approval denied");
  });

  it("prefers failure context over newer success context when showing recent failures", async () => {
    createRunningTaskRun({
      runtime: "acp",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:acp:status-task-failed-priority",
      runId: "run-status-task-failed-priority",
      task: "failed background task",
    });
    failTaskRunByRunId({
      runId: "run-status-task-failed-priority",
      endedAt: Date.now() - 30_000,
      error: "approval denied",
    });
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-succeeded-later",
      runId: "run-status-task-succeeded-later",
      task: "later successful task",
    });
    completeTaskRunByRunId({
      runId: "run-status-task-succeeded-later",
      endedAt: Date.now(),
      terminalSummary: "all done",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 recent failure");
    expect(reply?.text).toContain("failed background task");
    expect(reply?.text).toContain("approval denied");
    expect(reply?.text).not.toContain("later successful task");
    expect(reply?.text).not.toContain("all done");
  });

  it("falls back to same-agent task counts without details when the current session has none", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:other",
      childSessionKey: "agent:main:subagent:status-agent-fallback-running",
      runId: "run-status-agent-fallback-running",
      agentId: "main",
      task: "hidden task title",
      progressSummary: "hidden progress detail",
    });
    createQueuedTaskRun({
      runtime: "cron",
      requesterSessionKey: "agent:main:another",
      childSessionKey: "agent:main:subagent:status-agent-fallback-queued",
      runId: "run-status-agent-fallback-queued",
      agentId: "main",
      task: "another hidden task title",
    });

    const reply = await buildStatusReplyForTest({ sessionKey: "agent:main:empty-session" });

    expect(reply?.text).toContain("📌 Tasks: 2 active · 2 total · agent-local");
    expect(reply?.text).not.toContain("hidden task title");
    expect(reply?.text).not.toContain("hidden progress detail");
    expect(reply?.text).not.toContain("subagent");
    expect(reply?.text).not.toContain("cron");
  });
});
