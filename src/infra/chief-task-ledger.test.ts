import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ensurePaperclipTrackedIssue = vi.hoisted(() =>
  vi.fn(async (params: { paperclipIssueId?: string; status?: string }) => ({
    id: params.paperclipIssueId?.trim() || "OPE-TEST-1",
    companyId: "company-test",
    assigneeAgentId: "openclaw_gateway",
    status: params.status ?? "in_progress",
  })),
);
const updatePaperclipTrackedIssue = vi.hoisted(() => vi.fn(async () => ({ id: "OPE-TEST-1" })));
const fetchMock = vi.hoisted(() =>
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/agents/me")) {
      return new Response(JSON.stringify({ id: "openclaw_gateway", companyId: "company-test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/companies/company-test/issues")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      return new Response(
        JSON.stringify({
          id: "OPE-TEST-1",
          identifier: "OPE-TEST-1",
          status: body.status ?? "in_progress",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/issues/")) {
      const issueId = url.split("/issues/")[1]?.split(/[/?#]/)[0] || "OPE-TEST-1";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      return new Response(
        JSON.stringify({
          id: issueId,
          identifier: issueId,
          status: body.status ?? "in_progress",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
);

vi.mock("./paperclip-issues.js", async () => {
  const actual = await vi.importActual<typeof import("./paperclip-issues.js")>("./paperclip-issues.js");
  return {
    ...actual,
    ensurePaperclipTrackedIssue,
    updatePaperclipTrackedIssue,
  };
});

import type { OpenClawConfig } from "../config/config.js";
import {
  archiveChiefTaskLedger,
  loadChiefRuntimeState,
  recordChiefTaskResult,
  loadChiefTaskLedgerArchiveForTest,
  loadChiefTaskLedgerForTest,
  listStaleChiefTasks,
  recordChiefTaskStart,
  reconcileChiefTaskAuthority,
  resolveChiefTaskLedgerArchivePath,
  resolveChiefTaskLedgerPath,
} from "./chief-task-ledger.js";
import {
  loadInboundReceiptLedgerForTest,
  recordInboundReceiptReceived,
  resolveInboundReceiptLedgerPath,
} from "./inbound-receipt-ledger.js";

const cleanupPaths: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  ensurePaperclipTrackedIssue.mockClear();
  updatePaperclipTrackedIssue.mockClear();
  fetchMock.mockClear();
  globalThis.fetch = originalFetch;
  await Promise.allSettled(
    cleanupPaths.splice(0).map(async (target) => {
      await fs.promises.rm(target, { recursive: true, force: true });
    }),
  );
});

async function ensurePaperclipTestRuntime(): Promise<void> {
  const claimedKeyPath = path.join(
    os.homedir(),
    ".openclaw",
    "workspace",
    "paperclip-claimed-api-key.json",
  );
  await fs.promises.mkdir(path.dirname(claimedKeyPath), { recursive: true });
  await fs.promises.writeFile(
    claimedKeyPath,
    `${JSON.stringify({ apiKey: "test-paperclip-key" }, null, 2)}\n`,
    "utf-8",
  );
  globalThis.fetch = fetchMock as typeof globalThis.fetch;
}

async function makeConfig(): Promise<{ cfg: OpenClawConfig; root: string; storePath: string }> {
  await ensurePaperclipTestRuntime();
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-chief-ledger-"));
  cleanupPaths.push(root);
  const storePath = path.join(root, "sessions.json");
  return {
    cfg: {
      session: {
        store: storePath,
      },
    } as OpenClawConfig,
    root,
    storePath,
  };
}

describe("chief-task-ledger", () => {
  it("does not reuse a matched existing task when an approved new tracked task is created", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";

    const existing = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Tiếp tục xử lý task cũ.",
      sourceChannel: "telegram",
      sourceMessageId: "1401",
      continuityDecision: "attach_existing_task",
      paperclipIssueId: "OPE-OLD-1",
      nowMs: 1_000,
    });

    const approved = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Mở task mới cho yêu cầu này và theo dõi tới khi xong.",
      sourceChannel: "telegram",
      sourceMessageId: "1412",
      receiptId: "telegram|default|telegram:523353610|main|1412|chief",
      matchedTaskId: existing?.taskId,
      paperclipIssueId: "OPE-NEW-1",
      continuityDecision: "new_task_candidate",
      createdByApproval: true,
      nowMs: 2_000,
    });

    expect(existing?.taskId).toBe("paperclip:OPE-OLD-1");
    expect(approved?.taskId).toBe("paperclip:OPE-NEW-1");
    expect(approved?.taskId).not.toBe(existing?.taskId);
    expect(approved?.paperclipIssueId).toBe("OPE-NEW-1");
    expect(approved?.createdByApproval).toBe(true);
    expect(approved?.continuityDecision).toBe("new_task_candidate");

    const ledger = await loadChiefTaskLedgerForTest(resolveChiefTaskLedgerPath(cfg));
    expect(ledger.activeBySessionKey[sessionKey]).toBe("paperclip:OPE-NEW-1");
  });

  it("preserves original task metadata when continuation prompt resumes the same task", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";

    await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Fix Telegram reply path and report the final result.",
      sourceChannel: "telegram",
      sourceMessageId: "1225",
      nowMs: 1_000,
    });

    await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt:
        "Resume the unfinished task below and continue it until it is finished, blocked, or clearly awaiting user input.\nDo not start unrelated work.",
      nowMs: 2_000,
    });

    const ledger = await loadChiefTaskLedgerForTest(resolveChiefTaskLedgerPath(cfg));
    const activeTaskId = ledger.activeBySessionKey[sessionKey];
    expect(activeTaskId).toBeTruthy();
    const task = ledger.tasks[activeTaskId];
    expect(task.source).toBe("telegram");
    expect(task.sourceMessageId).toBe("1225");
    expect(task.paperclipIssueId).toBe("OPE-TEST-1");
    expect(task.title).toContain("Fix Telegram reply path");
    expect(task.promptPreview).toContain("Fix Telegram reply path");
  });

  it("does not overwrite the original receipt body when a continuation prompt replays the same task", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";
    const receipt = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "telegram:523353610",
      messageId: "1362",
      sessionKey,
      threadKey: sessionKey,
      bodyPreview: "Hãy xây dựng quy trình phân tích trước khi trả lời.",
      bodyText: "Hãy xây dựng quy trình phân tích trước khi trả lời.",
      sourceMessageId: "1362",
    });

    await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Hãy xây dựng quy trình phân tích trước khi trả lời.",
      sourceChannel: "telegram",
      receiptId: receipt?.receiptId,
      sourceMessageId: "1362",
      nowMs: 1_000,
    });

    await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt:
        "Resume the unfinished task below and continue it until it is finished, blocked, or clearly awaiting user input.\nDo not start unrelated work.",
      sourceChannel: "telegram",
      receiptId: receipt?.receiptId,
      sourceMessageId: "1362",
      nowMs: 2_000,
    });

    const inboundLedger = await loadInboundReceiptLedgerForTest(resolveInboundReceiptLedgerPath(cfg));
    const updatedReceipt = inboundLedger.receipts[receipt?.receiptId ?? ""];
    expect(updatedReceipt?.bodyText).toBe("Hãy xây dựng quy trình phân tích trước khi trả lời.");
    expect(updatedReceipt?.bodyPreview).toBe("Hãy xây dựng quy trình phân tích trước khi trả lời.");
  });

  it("reconciles a stale chief task to done when the transcript already has a final assistant reply", async () => {
    const { cfg, root, storePath } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";
    const sessionId = "session-1";
    const sessionFile = path.join(root, `${sessionId}.jsonl`);

    await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Please finish this Telegram task.",
      sourceChannel: "telegram",
      sourceMessageId: "1225",
      nowMs: 1_000,
    });

    const store = {
      [sessionKey]: {
        sessionId,
        updatedAt: 1_500,
        sessionFile,
      },
    };
    await fs.promises.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
    const transcript = [
      { type: "session", version: 3, id: sessionId, timestamp: "2026-03-30T15:00:00.000Z" },
      {
        type: "message",
        timestamp: "2026-03-30T15:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Original request for message 1225" }],
        },
      },
      {
        type: "message",
        timestamp: "2026-03-30T15:00:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "[[reply_to_current]] Đã xong.\n[STOP]: completed" }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await fs.promises.writeFile(sessionFile, `${transcript}\n`, "utf-8");

    const stale = await listStaleChiefTasks({
      cfg,
      nowMs: 10 * 60_000,
    });
    expect(stale).toEqual([]);

    const ledger = await loadChiefTaskLedgerForTest(resolveChiefTaskLedgerPath(cfg));
    const task = Object.values(ledger.tasks)[0];
    expect(task?.status).toBe("done");
    expect(task?.paperclipIssueId).toBe("OPE-TEST-1");
    expect(task?.lastResponsePreview).toContain("Đã xong");
    expect(ledger.activeBySessionKey[sessionKey]).toBeUndefined();
  });

  it("writes runtime state for active and completed chief tasks", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";
    const started = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      sessionId: "session-123",
      prompt: "Continue the durable Telegram task until it is done.",
      sourceChannel: "telegram",
      sourceMessageId: "1228",
      nowMs: 5_000,
    });

    const activeState = await loadChiefRuntimeState({ cfg });
    expect(activeState.activeTaskCount).toBe(1);
    expect(activeState.activeTask?.taskId).toBe(started?.taskId);
    expect(activeState.activeTask?.phase).toBe("executing");
    expect(activeState.activeTask?.container).toBe("paperclip_issue");
    expect(activeState.activeTask?.paperclipIssueId).toBe("OPE-TEST-1");

    await recordChiefTaskResult({
      cfg,
      agentId: "chief",
      taskId: started?.taskId,
      sessionKey,
      payloads: [{ text: "[STOP]: completed" }],
      nowMs: 8_000,
    });

    const completedState = await loadChiefRuntimeState({ cfg });
    expect(completedState.activeTaskCount).toBe(0);
    expect(completedState.activeTask).toBeUndefined();
  });

  it("keeps telegram tasks in progress until outbound delivery is confirmed", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";
    const receipt = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "telegram:523353610",
      messageId: "2001",
      sessionKey,
      threadKey: sessionKey,
      bodyPreview: "Hoàn tất task Telegram này.",
      bodyText: "Hoàn tất task Telegram này.",
      sourceMessageId: "2001",
    });

    const started = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      sessionId: "session-123",
      prompt: "Hoàn tất task Telegram này.",
      sourceChannel: "telegram",
      receiptId: receipt?.receiptId,
      sourceMessageId: "2001",
      nowMs: 5_000,
    });

    const pending = await recordChiefTaskResult({
      cfg,
      agentId: "chief",
      taskId: started?.taskId,
      receiptId: receipt?.receiptId,
      sessionKey,
      payloads: [{ text: "[STOP]: completed" }],
      deliveryConfirmed: false,
      nowMs: 8_000,
    });

    expect(pending?.status).toBe("in_progress");
    expect(pending?.nextStep).toContain("Await confirmed outbound delivery");

    const ledgerAfterPending = await loadChiefTaskLedgerForTest(resolveChiefTaskLedgerPath(cfg));
    expect(ledgerAfterPending.activeBySessionKey[sessionKey]).toBe(started?.taskId);

    const delivered = await recordChiefTaskResult({
      cfg,
      agentId: "chief",
      receiptId: receipt?.receiptId,
      sessionKey,
      payloads: [{ text: "[STOP]: completed" }],
      deliveryConfirmed: true,
      nowMs: 10_000,
    });

    expect(delivered?.status).toBe("done");

    const inboundLedger = await loadInboundReceiptLedgerForTest(resolveInboundReceiptLedgerPath(cfg));
    expect(inboundLedger.receipts[receipt?.receiptId ?? ""]?.status).toBe("done");
  });

  it("cascades a terminal chief result to sibling tasks that share the same receipt or paperclip issue", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";
    const receipt = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "telegram:523353610",
      messageId: "2002",
      sessionKey,
      threadKey: sessionKey,
      bodyPreview: "Hoàn tất task Telegram này.",
      bodyText: "Hoàn tất task Telegram này.",
      sourceMessageId: "2002",
    });

    const rootTask = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      sessionId: "session-2002",
      prompt: "Hoàn tất task Telegram này.",
      sourceChannel: "telegram",
      receiptId: receipt?.receiptId,
      sourceMessageId: "2002",
      paperclipIssueId: "OPE-SHARED-2002",
      nowMs: 5_000,
    });

    const ledgerPath = resolveChiefTaskLedgerPath(cfg);
    const seededLedger = await loadChiefTaskLedgerForTest(ledgerPath);
    seededLedger.tasks["chief:sibling-2002"] = {
      ...seededLedger.tasks[rootTask?.taskId ?? ""],
      taskId: "chief:sibling-2002",
      parentTaskId: rootTask?.taskId,
      status: "in_progress",
      phase: "executing",
      createdAt: 6_000,
      updatedAt: 6_000,
      lastProgressAt: 6_000,
      latestMilestone: "Implementation pass completed; quality_guard review started.",
      verificationEvidence: [],
    };
    seededLedger.activeBySessionKey[sessionKey] = "chief:sibling-2002";
    await fs.promises.writeFile(ledgerPath, `${JSON.stringify(seededLedger, null, 2)}\n`, "utf-8");

    const settled = await recordChiefTaskResult({
      cfg,
      agentId: "chief",
      taskId: rootTask?.taskId,
      receiptId: receipt?.receiptId,
      sessionKey,
      payloads: [{ text: "Đã hoàn tất.\n\n`[COMPLETE]: đã hoàn thành tác vụ hiện tại`" }],
      deliveryConfirmed: true,
      nowMs: 8_000,
    });

    expect(settled?.status).toBe("done");

    const reconciledLedger = await loadChiefTaskLedgerForTest(ledgerPath);
    expect(reconciledLedger.tasks["chief:sibling-2002"]?.status).toBe("done");
    expect(reconciledLedger.tasks["chief:sibling-2002"]?.lastResponsePreview).toContain(
      "[COMPLETE]:",
    );
    expect(reconciledLedger.tasks["chief:sibling-2002"]?.verificationEvidence).toContain(
      "related_task_terminalized",
    );
    expect(reconciledLedger.activeBySessionKey[sessionKey]).toBeUndefined();
  });

  it("treats non-complete STOP payloads as blocked instead of done", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";
    const receipt = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "telegram:523353610",
      messageId: "2003",
      sessionKey,
      threadKey: sessionKey,
      bodyPreview: "Kiểm tra task lỗi.",
      bodyText: "Kiểm tra task lỗi.",
      sourceMessageId: "2003",
    });

    const started = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      sessionId: "session-2003",
      prompt: "Kiểm tra task lỗi.",
      sourceChannel: "telegram",
      receiptId: receipt?.receiptId,
      sourceMessageId: "2003",
      nowMs: 5_000,
    });

    const stopped = await recordChiefTaskResult({
      cfg,
      agentId: "chief",
      taskId: started?.taskId,
      receiptId: receipt?.receiptId,
      sessionKey,
      payloads: [{ text: "⚠️ Agent finished without generating a deliverable reply.\n\n`[STOP]: đã dừng do lỗi trong lúc xử lý`" }],
      deliveryConfirmed: true,
      nowMs: 8_000,
    });

    expect(stopped?.status).toBe("blocked");
  });

  it("reuses the matched task id instead of creating a new task when continuity attaches", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:9001";

    const first = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Fix Telegram reply path and keep tracking this same task.",
      sourceChannel: "telegram",
      sourceMessageId: "1900",
      threadKey: sessionKey,
      openIntentKey: "fix-telegram-reply-path",
      intentSummary: "Fix Telegram reply path",
      currentGoal: "Finish the Telegram reply path fix",
      continuityDecision: "attach_existing_task",
      nowMs: 1_000,
    });

    const resumed = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Tiep tuc fix Telegram reply path cho xong.",
      sourceChannel: "telegram",
      sourceMessageId: "1901",
      matchedTaskId: first?.taskId,
      threadKey: sessionKey,
      openIntentKey: "fix-telegram-reply-path",
      intentSummary: "Fix Telegram reply path",
      currentGoal: "Keep the same tracked work alive",
      continuityDecision: "attach_existing_task",
      nowMs: 2_000,
    });

    expect(resumed?.taskId).toBe(first?.taskId);

    const ledger = await loadChiefTaskLedgerForTest(resolveChiefTaskLedgerPath(cfg));
    const task = first?.taskId ? ledger.tasks[first.taskId] : undefined;
    expect(task?.continuityDecision).toBe("attach_existing_task");
    expect(task?.continuityHistory?.length).toBeGreaterThanOrEqual(2);
    expect(task?.threadKey).toBe(sessionKey);
    expect(task?.openIntentKey).toBe("fix-telegram-reply-path");
    expect(task?.paperclipIssueId).toBe("OPE-TEST-1");
  });

  it("does not reuse an unrelated active task for a new direct-answer message in the same session", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";

    const first = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Tracked work that is still in progress.",
      sourceChannel: "telegram",
      receiptId: "telegram|default|telegram:523353610|main|1362|chief",
      sourceMessageId: "1362",
      paperclipIssueId: "OPE-TRACKED-1362",
      threadKey: sessionKey,
      openIntentKey: "tracked-work-1362",
      continuityDecision: "new_task_candidate",
      createdByApproval: true,
      nowMs: 1_000,
    });

    const second = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "em còn làm việc ko?",
      sourceChannel: "telegram",
      receiptId: "telegram|default|telegram:523353610|main|1364|chief",
      sourceMessageId: "1364",
      paperclipIssueId: "OPE-DIRECT-1364",
      threadKey: sessionKey,
      openIntentKey: "con-lam-viec",
      continuityDecision: "direct_answer",
      nowMs: 2_000,
    });

    expect(second?.taskId).not.toBe(first?.taskId);
    expect(second?.receiptId).toBe("telegram|default|telegram:523353610|main|1364|chief");
    expect(second?.sourceMessageId).toBe("1364");
    expect(second?.paperclipIssueId).toBe("OPE-DIRECT-1364");
    expect(second?.continuityDecision).toBe("direct_answer");
  });

  it("does not let a replay continuation hijack a different active task in the same session", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";

    const active = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "em còn làm việc ko?",
      sourceChannel: "telegram",
      receiptId: "telegram|default|telegram:523353610|main|1364|chief",
      sourceMessageId: "1364",
      paperclipIssueId: "OPE-DIRECT-1364",
      threadKey: sessionKey,
      openIntentKey: "con-lam-viec",
      continuityDecision: "direct_answer",
      nowMs: 1_000,
    });

    const replayed = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt:
        "Resume the unfinished task below and continue it until it is finished, blocked, or clearly awaiting user input.\nDo not start unrelated work.",
      sourceChannel: "telegram",
      receiptId: "telegram|default|telegram:523353610|main|1362|chief",
      sourceMessageId: "1362",
      paperclipIssueId: "OPE-TRACKED-1362",
      threadKey: sessionKey,
      openIntentKey: "tracked-work-1362",
      continuityDecision: "direct_answer",
      nowMs: 2_000,
    });

    expect(replayed?.taskId).not.toBe(active?.taskId);
    expect(replayed?.receiptId).toBe("telegram|default|telegram:523353610|main|1362|chief");
    expect(replayed?.sourceMessageId).toBe("1362");
    expect(replayed?.paperclipIssueId).toBe("OPE-TRACKED-1362");
    expect(replayed?.title).toContain("Resume the unfinished task below");
  });

  it("keeps the internal chief paperclip maintenance session out of tracked paperclip authority", async () => {
    const { cfg } = await makeConfig();

    const task = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey: "agent:chief:paperclip",
      prompt:
        "[Wed 2026-04-01 01:06 GMT+7] Windows host note: load PAPERCLIP_API_KEY from ~/.openclaw/workspace/paperclip-claimed-api-key.json before Paperclip issue calls.",
      nowMs: 1_000,
    });

    expect(task?.source).toBe("internal");
    expect(task?.container).toBe("ephemeral_internal");
    expect(task?.paperclipIssueId).toBeUndefined();
  });

  it("excludes ephemeral internal maintenance tasks from runtime active summary", async () => {
    const { cfg } = await makeConfig();

    await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey: "agent:chief:paperclip",
      prompt:
        "[Wed 2026-04-01 13:01 GMT+7] Windows host note: load PAPERCLIP_API_KEY from ~/.openclaw/workspace/paperclip-claimed-api-key.json before Paperclip issue calls.",
      nowMs: 1_000,
    });

    const tracked = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey: "agent:chief:telegram:direct:7001",
      prompt: "Continue the tracked Telegram task until it is done.",
      sourceChannel: "telegram",
      sourceMessageId: "7001",
      nowMs: 2_000,
    });

    const activeState = await loadChiefRuntimeState({ cfg });
    expect(activeState.activeTaskCount).toBe(1);
    expect(activeState.activeTask?.taskId).toBe(tracked?.taskId);
    expect(activeState.activeTask?.container).toBe("paperclip_issue");
  });

  it("backfills missing paperclip authority for active tracked tasks", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:4242";
    const ledgerPath = resolveChiefTaskLedgerPath(cfg);

    await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Keep this Telegram task alive until it is finished.",
      sourceChannel: "telegram",
      sourceMessageId: "active-1",
      nowMs: 1_000,
    });

    const ledger = await loadChiefTaskLedgerForTest(ledgerPath);
    const taskId = ledger.activeBySessionKey[sessionKey];
    expect(taskId).toBeTruthy();
    if (!taskId) {
      throw new Error("Missing active task id.");
    }
    ledger.tasks[taskId] = {
      ...ledger.tasks[taskId],
      paperclipIssueId: undefined,
      container: "durable_local",
    };
    await fs.promises.writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf-8");
    ensurePaperclipTrackedIssue.mockClear();

    const reconciled = await reconcileChiefTaskAuthority({ cfg });
    const task = reconciled.tasks[taskId];
    expect(task?.paperclipIssueId).toBe("OPE-TEST-1");
    expect(task?.container).toBe("paperclip_issue");
    expect(task?.legacyLocalTerminal).toBe(false);
    expect(ensurePaperclipTrackedIssue).not.toHaveBeenCalled();
  });

  it("swallows paperclip run-id enforcement when syncing a terminal task outside a run context", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:7777";

    const task = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Finish this tracked task safely.",
      sourceChannel: "telegram",
      sourceMessageId: "7777",
      nowMs: 1_000,
    });

    updatePaperclipTrackedIssue.mockRejectedValueOnce(
      new Error('Paperclip request failed (401) /issues/OPE-TEST-1: {"error":"Agent run id required"}'),
    );

    await expect(
      recordChiefTaskResult({
        cfg,
        agentId: "chief",
        taskId: task?.taskId,
        sessionKey,
        payloads: [{ text: "[STOP]: completed" }],
        nowMs: 2_000,
      }),
    ).resolves.toMatchObject({
      taskId: task?.taskId,
      status: "done",
    });
  });

  it("swallows missing paperclip issue errors when the authority issue was deleted externally", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:8888";

    const task = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Finish this tracked task even if the Paperclip issue disappears.",
      sourceChannel: "telegram",
      sourceMessageId: "8888",
      nowMs: 1_000,
    });

    updatePaperclipTrackedIssue.mockRejectedValueOnce(
      new Error('Paperclip request failed (404) /issues/OPE-TEST-1: {"error":"Issue not found"}'),
    );

    await expect(
      recordChiefTaskResult({
        cfg,
        agentId: "chief",
        taskId: task?.taskId,
        sessionKey,
        payloads: [{ text: "[STOP]: completed" }],
        nowMs: 2_000,
      }),
    ).resolves.toMatchObject({
      taskId: task?.taskId,
      status: "done",
    });
  });

  it("marks legacy terminal local tasks instead of backfilling paperclip authority", async () => {
    const { cfg } = await makeConfig();
    const ledgerPath = resolveChiefTaskLedgerPath(cfg);
    const sessionKey = "agent:chief:telegram:direct:terminal";
    const taskId = "telegram:agent:chief:telegram:direct:terminal:legacy";

    await fs.promises.writeFile(
      ledgerPath,
      `${JSON.stringify(
        {
          version: 3,
          activeBySessionKey: {},
          tasks: {
            [taskId]: {
              taskId,
              agentId: "chief",
              sessionKey,
              status: "done",
              phase: "done",
              container: "durable_local",
              source: "telegram",
              title: "Legacy terminal Telegram task",
              promptPreview: "Legacy terminal Telegram task",
              createdAt: 1_000,
              updatedAt: 2_000,
              lastProgressAt: 2_000,
              activeAgents: ["chief"],
              currentOwner: "chief",
              runAttempts: 1,
              resumeAttempts: 0,
              recoveryCount: 0,
              fallbackStage: "none",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    ensurePaperclipTrackedIssue.mockClear();

    const reconciled = await reconcileChiefTaskAuthority({ cfg });
    const task = reconciled.tasks[taskId];
    expect(task?.legacyLocalTerminal).toBe(true);
    expect(task?.paperclipIssueId).toBeUndefined();
    expect(ensurePaperclipTrackedIssue).not.toHaveBeenCalled();
  });

  it("archives legacy local terminal tasks older than the retention window", async () => {
    const { cfg } = await makeConfig();
    const ledgerPath = resolveChiefTaskLedgerPath(cfg);
    const archivePath = resolveChiefTaskLedgerArchivePath(cfg);
    const nowMs = 40 * 24 * 60 * 60 * 1000;
    const oldCompletedAt = nowMs - 31 * 24 * 60 * 60 * 1000;
    const recentCompletedAt = nowMs - 5 * 24 * 60 * 60 * 1000;

    await fs.promises.writeFile(
      ledgerPath,
      `${JSON.stringify(
        {
          version: 3,
          activeBySessionKey: {},
          tasks: {
            "legacy-old": {
              taskId: "legacy-old",
              agentId: "chief",
              sessionKey: "agent:chief:telegram:direct:archive-old",
              status: "done",
              phase: "done",
              container: "durable_local",
              source: "telegram",
              title: "Old legacy task",
              promptPreview: "Old legacy task",
              createdAt: oldCompletedAt - 1_000,
              updatedAt: oldCompletedAt,
              lastProgressAt: oldCompletedAt,
              completedAt: oldCompletedAt,
              activeAgents: ["chief"],
              currentOwner: "chief",
              legacyLocalTerminal: true,
              runAttempts: 1,
              resumeAttempts: 0,
              recoveryCount: 0,
              fallbackStage: "none",
            },
            "legacy-recent": {
              taskId: "legacy-recent",
              agentId: "chief",
              sessionKey: "agent:chief:telegram:direct:archive-recent",
              status: "done",
              phase: "done",
              container: "durable_local",
              source: "telegram",
              title: "Recent legacy task",
              promptPreview: "Recent legacy task",
              createdAt: recentCompletedAt - 1_000,
              updatedAt: recentCompletedAt,
              lastProgressAt: recentCompletedAt,
              completedAt: recentCompletedAt,
              activeAgents: ["chief"],
              currentOwner: "chief",
              legacyLocalTerminal: true,
              runAttempts: 1,
              resumeAttempts: 0,
              recoveryCount: 0,
              fallbackStage: "none",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const archived = await archiveChiefTaskLedger({
      cfg,
      nowMs,
      retentionDays: 30,
    });

    expect(archived.archivedTaskIds).toEqual(["legacy-old"]);
    expect(archived.retainedLegacyLocalTerminalCount).toBe(1);

    const ledger = await loadChiefTaskLedgerForTest(ledgerPath);
    expect(ledger.tasks["legacy-old"]).toBeUndefined();
    expect(ledger.tasks["legacy-recent"]?.legacyLocalTerminal).toBe(true);

    const archive = await loadChiefTaskLedgerArchiveForTest(archivePath);
    expect(archive.archiveLastOutcome).toBe("archived_1");
    expect(archive.archivedTasks["legacy-old"]?.task.taskId).toBe("legacy-old");
    expect(archive.archivedTasks["legacy-recent"]).toBeUndefined();
  });
});
