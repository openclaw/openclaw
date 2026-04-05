import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import { subagentRuns } from "../../agents/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { buildStatusReply, buildStatusText } from "./commands-status.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue } from "./queue/state.js";

function resetSubagentRegistryForTests() {
  subagentRuns.clear();
}

function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
}

const baseCfg = {
  commands: { text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;

async function buildStatusReplyForTest(params: {
  sessionKey?: string;
  verbose?: boolean;
  workspaceDir?: string;
}) {
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
    workspaceDir: params.workspaceDir ?? "/tmp",
    provider: "anthropic",
    model: "claude-opus-4-6",
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

function writeTranscriptUsageLog(params: {
  dir: string;
  agentId: string;
  sessionId: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
}) {
  const logPath = path.join(
    params.dir,
    ".openclaw",
    "agents",
    params.agentId,
    "sessions",
    `${params.sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    logPath,
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        model: "claude-opus-4-5",
        usage: params.usage,
      },
    }),
    "utf-8",
  );
}

describe("buildStatusReply subagent summary", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetTaskRegistryForTests();
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
    resetTaskRegistryForTests();
    clearFollowupQueue("agent:main:main");
    vi.unstubAllEnvs();
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

    expect(reply?.text).toContain("Agent: main");
    expect(reply?.text).toContain("Workspace: /tmp");
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

  it("includes the current workspace context in status replies", async () => {
    const reply = await buildStatusReplyForTest({
      workspaceDir: "/tmp/openclaw-workspace-main",
    });

    expect(reply?.text).toContain("Agent: main");
    expect(reply?.text).toContain("Workspace: /tmp/openclaw-workspace-main");
    expect(reply?.text).toContain("🧠 Model:");
  });

  it("does not leak internal runtime context through the task status line", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-leak",
      runId: "run-status-task-leak",
      task: "leaked context task",
    });
    failTaskRunByRunId({
      runId: "run-status-task-leak",
      endedAt: Date.now(),
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 recent failure");
    expect(reply?.text).toContain("leaked context task");
    expect(reply?.text).not.toContain("OpenClaw runtime context (internal):");
    expect(reply?.text).not.toContain("Internal task completion event");
  });

  it("truncates long task titles and details in the session task line", async () => {
    createRunningTaskRun({
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:status-task-truncated",
      runId: "run-status-task-truncated",
      task: "This is a deliberately long task prompt that should never be emitted in full by /status because it can include internal instructions and file paths that are not appropriate for the headline line shown to users.",
      progressSummary:
        "This progress detail is also intentionally long so the status surface proves it truncates verbose task context instead of dumping a multi-sentence internal update into the reply output.",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain(
      "This is a deliberately long task prompt that should never be emitted in full by…",
    );
    expect(reply?.text).toContain(
      "This progress detail is also intentionally long so the status surface proves it truncates verbose task context instead…",
    );
    expect(reply?.text).not.toContain("internal instructions and file paths");
    expect(reply?.text).not.toContain("dumping a multi-sentence internal update");
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

  it("shows auth labels resolved from environment-backed provider auth", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-status");

    const commandParams = buildCommandTestParams("/status", baseCfg);
    const reply = await buildStatusReply({
      cfg: baseCfg,
      command: commandParams.command,
      sessionEntry: commandParams.sessionEntry,
      sessionKey: commandParams.sessionKey,
      parentSessionKey: commandParams.sessionKey,
      sessionScope: commandParams.sessionScope,
      storePath: commandParams.storePath,
      workspaceDir: "/tmp",
      provider: "anthropic",
      model: "claude-opus-4-5",
      contextTokens: 0,
      resolvedThinkLevel: commandParams.resolvedThinkLevel,
      resolvedFastMode: false,
      resolvedVerboseLevel: commandParams.resolvedVerboseLevel,
      resolvedReasoningLevel: commandParams.resolvedReasoningLevel,
      resolvedElevatedLevel: commandParams.resolvedElevatedLevel,
      resolveDefaultThinkingLevel: commandParams.resolveDefaultThinkingLevel,
      isGroup: commandParams.isGroup,
      defaultGroupActivation: commandParams.defaultGroupActivation,
    });

    expect(reply?.text).toContain("ANTHROPIC_API_KEY");
  });

  it("shows the real follow-up queue depth in the status card", async () => {
    enqueueFollowupRun(
      "agent:main:main",
      {
        prompt: "queued follow-up",
        enqueuedAt: Date.now(),
        run: {
          agentId: "main",
          agentDir: "/tmp/agent",
          sessionId: "session-main",
          sessionKey: "agent:main:main",
          sessionFile: "/tmp/session-main.jsonl",
          workspaceDir: "/tmp",
          config: baseCfg,
          provider: "openai",
          model: "gpt-5.4",
          timeoutMs: 30_000,
          blockReplyBreak: "text_end",
        },
      },
      { mode: "collect" },
      "none",
      undefined,
      false,
    );

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("Queue: collect (depth 1)");
  });

  it("uses transcript usage fallback in /status output", async () => {
    await withTempHome(async (dir) => {
      const sessionId = "sess-status-transcript";
      writeTranscriptUsageLog({
        dir,
        agentId: "main",
        sessionId,
        usage: {
          input: 1,
          output: 2,
          cacheRead: 1000,
          cacheWrite: 0,
          totalTokens: 1003,
        },
      });

      const text = await buildStatusText({
        cfg: baseCfg,
        sessionEntry: {
          sessionId,
          updatedAt: 0,
          totalTokens: 3,
          contextTokens: 32_000,
        },
        sessionKey: "agent:main:main",
        parentSessionKey: "agent:main:main",
        sessionScope: "per-sender",
        statusChannel: "whatsapp",
        provider: "anthropic",
        model: "claude-opus-4-5",
        contextTokens: 32_000,
        resolvedFastMode: false,
        resolvedVerboseLevel: "off",
        resolvedReasoningLevel: "off",
        resolveDefaultThinkingLevel: async () => undefined,
        isGroup: false,
        defaultGroupActivation: () => "mention",
        modelAuthOverride: "unknown",
        activeModelAuthOverride: "unknown",
      });

      expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
    });
  });
});
