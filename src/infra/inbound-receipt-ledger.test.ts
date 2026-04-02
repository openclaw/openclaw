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
  findInboundReceiptByMessageId,
  loadInboundReceiptLedgerForTest,
  loadInboundReceiptRuntimeState,
  recordInboundReceiptAcked,
  recordInboundReceiptContinuity,
  recordInboundReceiptReceived,
  syncInboundReceiptFromChiefTask,
  resolveInboundReceiptLedgerPath,
  resolveInboundReceiptRuntimeStatePath,
} from "./inbound-receipt-ledger.js";
import {
  recordChiefTaskProgress,
  recordChiefTaskResult,
  recordChiefTaskStart,
} from "./chief-task-ledger.js";

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
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-receipt-ledger-"));
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

describe("inbound-receipt-ledger", () => {
  it("tracks a telegram receipt through chief execution and finalization", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:main";
    const received = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "12345",
      messageId: "456",
      sessionKey,
      bodyPreview: "Please continue the unfinished fix.",
      sourceMessageId: "456",
    });
    expect(received?.status).toBe("received");

    await recordInboundReceiptAcked({
      cfg,
      agentId: "chief",
      receiptId: received?.receiptId ?? "",
    });

    const task = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Continue the unfinished fix.",
      sourceChannel: "telegram",
      sourceMessageId: "456",
      receiptId: received?.receiptId,
      nowMs: 1_000,
    });
    await recordChiefTaskProgress({
      cfg,
      agentId: "chief",
      taskId: task?.taskId,
      sessionKey,
      phase: "reviewing",
      activeAgents: ["chief", "quality_guard"],
      currentOwner: "chief",
      nowMs: 2_000,
    });
    await recordChiefTaskResult({
      cfg,
      agentId: "chief",
      taskId: task?.taskId,
      sessionKey,
      payloads: [{ text: "[STOP]: completed" }],
      nowMs: 3_000,
    });

    const ledger = await loadInboundReceiptLedgerForTest(resolveInboundReceiptLedgerPath(cfg));
    const receipt = ledger.receipts[received?.receiptId ?? ""];
    expect(receipt?.taskId).toBe(task?.taskId);
    expect(receipt?.paperclipIssueId).toBe("OPE-TEST-1");
    expect(receipt?.status).toBe("done");
    expect(receipt?.sourceMessageId).toBe("456");

    const runtimeState = await loadInboundReceiptRuntimeState({ cfg });
    expect(runtimeState.unfinishedReceiptCount).toBe(0);
    expect(runtimeState.actionableReceiptCount).toBe(0);
    expect(runtimeState.awaitingConfirmationCount).toBe(0);
    expect(runtimeState.replayQueueCount).toBe(0);
  });

  it("surfaces stale unfinished receipts as replay candidates", async () => {
    const { cfg } = await makeConfig();
    const received = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "12345",
      messageId: "789",
      sessionKey: "agent:chief:main",
      bodyPreview: "Replay me if I stall.",
      sourceMessageId: "789",
    });
    const ledgerPath = resolveInboundReceiptLedgerPath(cfg);
    const ledger = await loadInboundReceiptLedgerForTest(ledgerPath);
    const stale = ledger.receipts[received?.receiptId ?? ""];
    stale.status = "executing";
    stale.lastProgressAt = Date.now() - 10 * 60_000;
    await fs.promises.writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf-8");
    await fs.promises.rm(resolveInboundReceiptRuntimeStatePath(cfg), { force: true });

    const runtimeState = await loadInboundReceiptRuntimeState({ cfg });
    expect(runtimeState.unfinishedReceiptCount).toBe(1);
    expect(runtimeState.actionableReceiptCount).toBe(1);
    expect(runtimeState.awaitingConfirmationCount).toBe(0);
    expect(runtimeState.replayQueueCount).toBe(1);
    expect(runtimeState.replayCandidates[0]?.receiptId).toBe(received?.receiptId);
  });

  it("finds a pending confirmation receipt by proposal message id within the session key", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";
    const received = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "telegram:523353610",
      messageId: "1331",
      sessionKey,
      threadKey: sessionKey,
      bodyPreview: "Hãy xây dựng cơ chế suy nghĩ, phân tích...",
      sourceMessageId: "1331",
    });

    await recordInboundReceiptContinuity({
      cfg,
      agentId: "chief",
      receiptId: received?.receiptId ?? "",
      threadKey: sessionKey,
      continuityDecision: "new_task_candidate",
      proposalStatus: "pending_confirmation",
      proposedTaskIntentKey: "xay-dung-co-che-suy-nghi-phan-tich",
      proposalMessageId: "1332",
      proposalPreview: "Tôi đánh giá đây là một việc mới...",
    });

    const found = await findInboundReceiptByMessageId({
      cfg,
      agentId: "chief",
      messageId: "1332",
      threadKey: sessionKey,
    });

    expect(found?.receiptId).toBe(received?.receiptId);
    expect(found?.proposalMessageId).toBe("1332");
    expect(found?.proposalStatus).toBe("pending_confirmation");

    const runtimeState = await loadInboundReceiptRuntimeState({ cfg });
    expect(runtimeState.unfinishedReceiptCount).toBe(1);
    expect(runtimeState.actionableReceiptCount).toBe(0);
    expect(runtimeState.visibleWaitingReceiptCount).toBe(1);
    expect(runtimeState.awaitingConfirmationCount).toBe(1);
    expect(runtimeState.replayQueueCount).toBe(0);
  });

  it("preserves approved tracked-task metadata when later chief sync is weaker", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";
    const received = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "telegram:523353610",
      messageId: "1412",
      sessionKey,
      threadKey: sessionKey,
      bodyPreview: "Mở task mới cho yêu cầu này.",
      bodyText: "Mở task mới cho yêu cầu này.",
      sourceMessageId: "1412",
    });

    await recordInboundReceiptContinuity({
      cfg,
      agentId: "chief",
      receiptId: received?.receiptId ?? "",
      threadKey: sessionKey,
      continuityDecision: "new_task_candidate",
      proposalStatus: "approved",
      proposedTaskIntentKey: "mo-task-moi-cho-yeu-cau-nay",
      matchedTaskId: "paperclip:OPE-NEW-1",
      matchedPaperclipIssueId: "OPE-NEW-1",
      openIntentKey: "mo-task-moi-cho-yeu-cau-nay",
    });

    await syncInboundReceiptFromChiefTask({
      cfg,
      task: {
        taskId: "paperclip:OPE-NEW-1",
        agentId: "chief",
        sessionKey,
        source: "telegram",
        promptPreview: "Mở task mới cho yêu cầu này.",
        sourceMessageId: "1412",
        paperclipIssueId: "OPE-NEW-1",
        receiptId: received?.receiptId,
        status: "in_progress",
        phase: "executing",
        lastProgressAt: 2_000,
        continuityDecision: "direct_answer",
        openIntentKey: "hoi-ngan-khong-track",
        createdByApproval: true,
      },
      stage: "executing",
    });

    const ledger = await loadInboundReceiptLedgerForTest(resolveInboundReceiptLedgerPath(cfg));
    const receipt = ledger.receipts[received?.receiptId ?? ""];
    expect(receipt?.proposalStatus).toBe("approved");
    expect(receipt?.continuityDecision).toBe("new_task_candidate");
    expect(receipt?.matchedTaskId).toBe("paperclip:OPE-NEW-1");
    expect(receipt?.matchedPaperclipIssueId).toBe("OPE-NEW-1");
    expect(receipt?.paperclipIssueId).toBe("OPE-NEW-1");
  });

  it("does not let a child chief task downgrade a terminal telegram receipt", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";
    const received = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "telegram:523353610",
      messageId: "1503",
      sessionKey,
      threadKey: sessionKey,
      bodyPreview: "Finish the tracked Telegram task.",
      bodyText: "Finish the tracked Telegram task.",
      sourceMessageId: "1503",
    });

    const task = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Finish the tracked Telegram task.",
      sourceChannel: "telegram",
      sourceMessageId: "1503",
      receiptId: received?.receiptId,
      nowMs: 1_000,
    });

    await recordChiefTaskResult({
      cfg,
      agentId: "chief",
      taskId: task?.taskId,
      receiptId: received?.receiptId,
      sessionKey,
      payloads: [{ text: "[COMPLETE]: done" }],
      deliveryConfirmed: true,
      nowMs: 3_000,
    });

    await syncInboundReceiptFromChiefTask({
      cfg,
      task: {
        taskId: "chief:child-followup",
        agentId: "chief",
        sessionKey,
        source: "telegram",
        promptPreview: "Internal follow-up child task.",
        receiptId: received?.receiptId,
        paperclipIssueId: "OPE-CHILD-1",
        status: "in_progress",
        phase: "executing",
        lastProgressAt: 4_000,
      },
      stage: "executing",
    });

    const ledger = await loadInboundReceiptLedgerForTest(resolveInboundReceiptLedgerPath(cfg));
    const receipt = ledger.receipts[received?.receiptId ?? ""];
    expect(receipt?.status).toBe("done");
    expect(receipt?.taskId).toBe(task?.taskId);
    expect(receipt?.paperclipIssueId).toBe("OPE-TEST-1");
    expect(receipt?.sourceMessageId).toBe("1503");
    expect(receipt?.completedAt).toBe(3_000);
  });

  it("does not reopen a terminal telegram receipt when the same task re-enters executing", async () => {
    const { cfg } = await makeConfig();
    const sessionKey = "agent:chief:telegram:direct:523353610";
    const received = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "telegram:523353610",
      messageId: "1504",
      sessionKey,
      threadKey: sessionKey,
      bodyPreview: "Keep terminal receipts terminal.",
      bodyText: "Keep terminal receipts terminal.",
      sourceMessageId: "1504",
    });

    const task = await recordChiefTaskStart({
      cfg,
      agentId: "chief",
      sessionKey,
      prompt: "Keep terminal receipts terminal.",
      sourceChannel: "telegram",
      sourceMessageId: "1504",
      receiptId: received?.receiptId,
      nowMs: 1_000,
    });

    await recordChiefTaskResult({
      cfg,
      agentId: "chief",
      taskId: task?.taskId,
      receiptId: received?.receiptId,
      sessionKey,
      payloads: [{ text: "[COMPLETE]: done" }],
      deliveryConfirmed: true,
      nowMs: 3_000,
    });

    await syncInboundReceiptFromChiefTask({
      cfg,
      task: {
        taskId: task?.taskId ?? "telegram:agent:chief:telegram:direct:523353610:1504",
        agentId: "chief",
        sessionKey,
        source: "telegram",
        promptPreview: "Re-entering execution should not reopen the receipt.",
        sourceMessageId: "1504",
        receiptId: received?.receiptId,
        paperclipIssueId: "OPE-TEST-1",
        status: "in_progress",
        phase: "executing",
        lastProgressAt: 4_000,
      },
      stage: "executing",
    });

    const ledger = await loadInboundReceiptLedgerForTest(resolveInboundReceiptLedgerPath(cfg));
    const receipt = ledger.receipts[received?.receiptId ?? ""];
    expect(receipt?.status).toBe("done");
    expect(receipt?.taskId).toBe(task?.taskId);
    expect(receipt?.completedAt).toBe(3_000);
  });
});
