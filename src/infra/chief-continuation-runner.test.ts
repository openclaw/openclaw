import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../config/config.js";
import { recordInboundReceiptReceived } from "./inbound-receipt-ledger.js";
import { resumeChiefContinuationTask, startChiefContinuationRunner } from "./chief-continuation-runner.js";
import type { ChiefTaskRecord } from "./chief-task-ledger.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(
    cleanupPaths.splice(0).map(async (target) => {
      await fs.promises.rm(target, { recursive: true, force: true });
    }),
  );
});

async function makeConfig(): Promise<{ cfg: OpenClawConfig; root: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-chief-continuation-"));
  cleanupPaths.push(root);
  return {
    cfg: {
      session: {
        store: path.join(root, "sessions.json"),
      },
    } as OpenClawConfig,
    root,
  };
}

function buildTelegramTask(overrides?: Partial<ChiefTaskRecord>): ChiefTaskRecord {
  return {
    taskId: "telegram:agent:chief:telegram:direct:523353610:1412",
    agentId: "chief",
    sessionKey: "agent:chief:telegram:direct:523353610",
    sessionId: "session-1",
    status: "in_progress",
    phase: "executing",
    container: "paperclip_issue",
    source: "telegram",
    title: "Tracked Telegram task",
    promptPreview: "Please keep working until this tracked task is complete.",
    createdAt: 1_000,
    updatedAt: 1_000,
    lastProgressAt: 1_000,
    activeAgents: ["chief"],
    currentOwner: "chief",
    receiptId: "telegram|default|telegram:523353610|main|1412|chief",
    sourceMessageId: "1412",
    paperclipIssueId: "issue-1",
    threadKey: "agent:chief:telegram:direct:523353610",
    openIntentKey: "tracked-task",
    intentSummary: "Tracked work item",
    currentGoal: "Finish the requested tracked work",
    continuityDecision: "new_task_candidate",
    createdByApproval: true,
    runAttempts: 1,
    resumeAttempts: 0,
    recoveryCount: 0,
    fallbackStage: "reinvoke",
    ...overrides,
  };
}

function buildPaperclipTask(overrides?: Partial<ChiefTaskRecord>): ChiefTaskRecord {
  return {
    ...buildTelegramTask({
      taskId: "paperclip:issue-1",
      sessionKey: "agent:chief:paperclip",
      source: "paperclip",
      sourceMessageId: "issue-1",
      receiptId: "paperclip|issue-1|issue-1",
      threadKey: "agent:chief:paperclip",
    }),
    ...overrides,
  };
}

describe("chief-continuation-runner", () => {
  it("resumes a stale Telegram task with the original delivery and receipt context", async () => {
    const { cfg } = await makeConfig();
    const task = buildTelegramTask();
    const receipt = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "telegram:523353610",
      messageId: "1412",
      sessionKey: task.sessionKey,
      receiptId: task.receiptId,
      sourceMessageId: task.sourceMessageId,
      paperclipIssueId: task.paperclipIssueId,
      threadKey: task.threadKey,
      bodyPreview: task.promptPreview,
      bodyText: task.promptPreview,
    });
    expect(receipt?.receiptId).toBe(task.receiptId);

    const runChief = vi.fn().mockResolvedValue({
      payloads: [{ text: "[STOP]: completed" }],
      deliveryConfirmed: true,
    });
    const recordTaskResult = vi.fn().mockResolvedValue(task);
    await resumeChiefContinuationTask({
      cfg,
      nowMs: () => 10_000,
      task,
      recordTaskResult,
      runChief,
    });

    expect(runChief).toHaveBeenCalledTimes(1);
    expect(runChief).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "chief",
        sessionKey: task.sessionKey,
        deliver: true,
        replyChannel: "telegram",
        replyTo: "telegram:523353610",
        replyAccountId: "default",
        inboundReceiptId: task.receiptId,
        sourceMessageId: task.sourceMessageId,
        paperclipIssueId: task.paperclipIssueId,
        threadKey: task.threadKey,
        openIntentKey: task.openIntentKey,
        intentSummary: task.intentSummary,
        currentGoal: task.currentGoal,
        continuityDecision: task.continuityDecision,
        createdByApproval: true,
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(recordTaskResult).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        agentId: "chief",
        taskId: task.taskId,
        receiptId: task.receiptId,
        sessionKey: task.sessionKey,
        deliveryConfirmed: true,
      }),
    );
  });

  it("preserves Telegram topic replies when the receipt id encodes a message thread", async () => {
    const { cfg } = await makeConfig();
    const task = buildTelegramTask({
      taskId: "telegram:agent:chief:telegram:group:-100999:77:1412",
      sessionKey: "agent:chief:telegram:group:-100999:topic:77",
      receiptId: "telegram|default|telegram:group:-100999:topic:77|77|1412|chief",
      threadKey: "telegram:group:-100999:topic:77",
    });
    await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "telegram:group:-100999:topic:77",
      messageId: "1412",
      sessionKey: task.sessionKey,
      receiptId: task.receiptId,
      sourceMessageId: task.sourceMessageId,
      paperclipIssueId: task.paperclipIssueId,
      threadKey: task.threadKey,
      bodyPreview: task.promptPreview,
      bodyText: task.promptPreview,
    });

    const runChief = vi.fn().mockResolvedValue({
      payloads: [{ text: "[STOP]: completed" }],
      deliveryConfirmed: true,
    });
    await resumeChiefContinuationTask({
      cfg,
      nowMs: () => 10_000,
      task,
      recordTaskResult: vi.fn().mockResolvedValue(task),
      runChief,
    });

    expect(runChief).toHaveBeenCalledWith(
      expect.objectContaining({
        replyChannel: "telegram",
        replyTo: "telegram:group:-100999:topic:77",
        threadId: "77",
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("falls back to the session key when a Telegram receipt has no originating target", async () => {
    const { cfg } = await makeConfig();
    const task = buildTelegramTask({
      taskId: "telegram:agent:chief:telegram:group:-100999:77:1412",
      sessionKey: "agent:chief:telegram:group:-100999:topic:77",
      receiptId: "telegram|default|unknown|77|1412|chief",
      threadKey: "telegram:group:-100999:topic:77",
    });
    await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      messageId: "1412",
      sessionKey: task.sessionKey,
      receiptId: task.receiptId,
      sourceMessageId: task.sourceMessageId,
      paperclipIssueId: task.paperclipIssueId,
      threadKey: task.threadKey,
      bodyPreview: task.promptPreview,
      bodyText: task.promptPreview,
    });

    const runChief = vi.fn().mockResolvedValue({
      payloads: [{ text: "[STOP]: completed" }],
      deliveryConfirmed: true,
    });
    await resumeChiefContinuationTask({
      cfg,
      nowMs: () => 10_000,
      task,
      recordTaskResult: vi.fn().mockResolvedValue(task),
      runChief,
    });

    expect(runChief).toHaveBeenCalledWith(
      expect.objectContaining({
        replyChannel: "telegram",
        replyTo: "telegram:group:-100999:topic:77",
        replyAccountId: "default",
        threadId: "77",
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("falls back to the stored session delivery context when the receipt is missing", async () => {
    const { cfg, root } = await makeConfig();
    const task = buildTelegramTask({
      taskId: "telegram:agent:chief:telegram:group:-100123:77:1412",
      sessionKey: "agent:chief:telegram:group:-100123:topic:77",
      receiptId: undefined,
      threadKey: "telegram:group:-100123:topic:77",
    });
    await fs.promises.writeFile(
      path.join(root, "sessions.json"),
      JSON.stringify(
        {
          [task.sessionKey]: {
            sessionId: "session-1",
            updatedAt: 1_000,
            deliveryContext: {
              channel: "telegram",
              to: "telegram:group:-100123:topic:77",
              accountId: "default",
              threadId: 77,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const runChief = vi.fn().mockResolvedValue({
      payloads: [{ text: "[STOP]: completed" }],
      deliveryConfirmed: true,
    });
    await resumeChiefContinuationTask({
      cfg,
      nowMs: () => 10_000,
      task,
      recordTaskResult: vi.fn().mockResolvedValue(task),
      runChief,
    });

    expect(runChief).toHaveBeenCalledWith(
      expect.objectContaining({
        replyChannel: "telegram",
        replyTo: "telegram:group:-100123:topic:77",
        replyAccountId: "default",
        threadId: "77",
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not locally resume paperclip tasks from the continuation watchdog", async () => {
    vi.useFakeTimers();
    const { cfg } = await makeConfig();
    const runChief = vi.fn();
    const markResumeRequested = vi.fn();
    const runner = startChiefContinuationRunner({
      cfg,
      intervalMs: 5_000,
      getQueueSize: () => 0,
      listStaleTasks: vi.fn().mockResolvedValue([buildPaperclipTask()]),
      markResumeRequested,
      runChief,
      recordTaskResult: vi.fn(),
      recordTaskFailure: vi.fn(),
    });

    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(markResumeRequested).not.toHaveBeenCalled();
      expect(runChief).not.toHaveBeenCalled();
    } finally {
      runner.stop();
    }
  });
});
