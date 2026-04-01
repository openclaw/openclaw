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
import { buildChiefNewTaskProposal, evaluateChiefTaskContinuity } from "./chief-task-continuity.js";
import { recordChiefTaskStart } from "./chief-task-ledger.js";
import {
  recordInboundReceiptContinuity,
  recordInboundReceiptReceived,
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
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-chief-continuity-"));
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

async function seedTrackedTask(params: {
  cfg: OpenClawConfig;
  threadKey: string;
  sourceMessageId: string;
  bodyText: string;
  paperclipIssueId?: string;
}) {
  const receipt = await recordInboundReceiptReceived({
    cfg: params.cfg,
    agentId: "chief",
    sourceType: "telegram",
    channel: "telegram",
    accountId: "default",
    originatingTo: "12345",
    messageId: params.sourceMessageId,
    sessionKey: params.threadKey,
    threadKey: params.threadKey,
    bodyPreview: params.bodyText,
    bodyText: params.bodyText,
    sourceMessageId: params.sourceMessageId,
  });
  const task = await recordChiefTaskStart({
    cfg: params.cfg,
    agentId: "chief",
    sessionKey: params.threadKey,
    prompt: params.bodyText,
    sourceChannel: "telegram",
    sourceMessageId: params.sourceMessageId,
    receiptId: receipt?.receiptId,
    threadKey: params.threadKey,
    openIntentKey: "fix-telegram-reply-path",
    intentSummary: "Fix Telegram reply path",
    currentGoal: "Finish the Telegram reply path fix",
    continuityDecision: "attach_existing_task",
    paperclipIssueId: params.paperclipIssueId,
    nowMs: 1_000,
  });
  return {
    receipt,
    task,
  };
}

describe("chief-task-continuity", () => {
  it("classifies short questions as direct answers when no tracked task is a strong match", async () => {
    const { cfg } = await makeConfig();

    const evaluation = await evaluateChiefTaskContinuity({
      cfg,
      agentId: "chief",
      threadKey: "agent:chief:telegram:123",
      sessionKey: "agent:chief:telegram:123",
      messageId: "m-1",
      bodyText: "Cau hinh nay la gi?",
    });

    expect(evaluation.classification).toBe("direct_answer");
    expect(evaluation.requiresUserApproval).toBe(false);
    expect(evaluation.reasonCodes).toContain("short_answer_question");
  });

  it("classifies short greetings as direct answers instead of creating a tracked task candidate", async () => {
    const { cfg } = await makeConfig();

    const evaluation = await evaluateChiefTaskContinuity({
      cfg,
      agentId: "chief",
      threadKey: "agent:chief:telegram:hello",
      sessionKey: "agent:chief:telegram:hello",
      messageId: "m-hi",
      bodyText: "hi em",
    });

    expect(evaluation.classification).toBe("direct_answer");
    expect(evaluation.requiresUserApproval).toBe(false);
  });

  it("attaches to the replied open task when reply_to points at an unfinished receipt", async () => {
    const { cfg } = await makeConfig();
    const threadKey = "agent:chief:telegram:123";
    const seeded = await seedTrackedTask({
      cfg,
      threadKey,
      sourceMessageId: "m-100",
      bodyText: "Fix Telegram reply path and keep the same task open.",
      paperclipIssueId: "OPE-100",
    });

    const evaluation = await evaluateChiefTaskContinuity({
      cfg,
      agentId: "chief",
      threadKey,
      sessionKey: threadKey,
      messageId: "m-101",
      replyToId: "m-100",
      bodyText: "Tiep tuc phan nay giup toi.",
    });

    expect(evaluation.classification).toBe("attach_existing_task");
    expect(evaluation.matchedTaskId).toBe(seeded.task?.taskId);
    expect(evaluation.matchedPaperclipIssueId).toBe("OPE-100");
    expect(evaluation.reasonCodes).toContain("reply_target_open_task");
  });

  it("attaches to an existing task in the same thread when the open intent still matches", async () => {
    const { cfg } = await makeConfig();
    const threadKey = "agent:chief:telegram:456";
    const seeded = await seedTrackedTask({
      cfg,
      threadKey,
      sourceMessageId: "m-200",
      bodyText: "Fix Telegram reply path and clean the draft delivery lane.",
    });

    const evaluation = await evaluateChiefTaskContinuity({
      cfg,
      agentId: "chief",
      threadKey,
      sessionKey: threadKey,
      messageId: "m-201",
      bodyText: "Can fix Telegram reply path va draft delivery cho xong.",
    });

    expect(evaluation.classification).toBe("attach_existing_task");
    expect(evaluation.matchedTaskId).toBe(seeded.task?.taskId);
    expect(
      evaluation.reasonCodes.includes("same_thread_same_open_intent") ||
        evaluation.reasonCodes.includes("single_open_task_in_thread"),
    ).toBe(true);
  });

  it("auto-creates a truly new tracked task by default", async () => {
    const { cfg } = await makeConfig();
    const threadKey = "agent:chief:telegram:789";
    await seedTrackedTask({
      cfg,
      threadKey,
      sourceMessageId: "m-300",
      bodyText: "Fix Telegram reply path and keep it stable.",
      paperclipIssueId: "OPE-300",
    });

    const evaluation = await evaluateChiefTaskContinuity({
      cfg,
      agentId: "chief",
      threadKey,
      sessionKey: threadKey,
      messageId: "m-301",
      bodyText:
        "Mo task moi trong Paperclip de theo doi workflow content moi cho dashboard team toi khi xong.",
    });

    expect(evaluation.classification).toBe("new_task_candidate");
    expect(evaluation.requiresUserApproval).toBe(false);
    expect(evaluation.reasonCodes).toContain("autonomous_task_creation");
  });

  it("still supports manual approval mode when explicitly configured", async () => {
    const { cfg } = await makeConfig();
    cfg.agents = {
      defaults: {
        autonomyMode: "standard",
        newTaskPolicy: "require_approval",
      },
    } as OpenClawConfig["agents"];
    const threadKey = "agent:chief:telegram:manual";
    await seedTrackedTask({
      cfg,
      threadKey,
      sourceMessageId: "m-310",
      bodyText: "Fix Telegram reply path and keep it stable.",
      paperclipIssueId: "OPE-310",
    });

    const evaluation = await evaluateChiefTaskContinuity({
      cfg,
      agentId: "chief",
      threadKey,
      sessionKey: threadKey,
      messageId: "m-311",
      bodyText:
        "Mo task moi trong Paperclip de theo doi workflow content moi cho dashboard team toi khi xong.",
    });

    expect(evaluation.classification).toBe("new_task_candidate");
    expect(evaluation.requiresUserApproval).toBe(true);
    expect(evaluation.reasonCodes).toContain("user_confirmation_required");
  });

  it("treats policy-style instructions as direct answers instead of always asking to open a new task", async () => {
    const { cfg } = await makeConfig();
    const threadKey = "agent:chief:telegram:policy";

    const evaluation = await evaluateChiefTaskContinuity({
      cfg,
      agentId: "chief",
      threadKey,
      sessionKey: threadKey,
      messageId: "m-policy",
      bodyText:
        "Tu nay bat buoc em phai tham dinh ky, phan tich va danh gia ky truoc khi dua ra bat ky de xuat nao.",
    });

    expect(evaluation.classification).toBe("direct_answer");
    expect(evaluation.requiresUserApproval).toBe(false);
    expect(evaluation.reasonCodes).toContain("policy_instruction");
  });

  it("does not send another new-task confirmation when the same thread already has a pending confirmation", async () => {
    const { cfg } = await makeConfig();
    const threadKey = "agent:chief:telegram:pending";
    const receipt = await recordInboundReceiptReceived({
      cfg,
      agentId: "chief",
      sourceType: "telegram",
      channel: "telegram",
      accountId: "default",
      originatingTo: "12345",
      messageId: "m-pending-1",
      sessionKey: threadKey,
      threadKey,
      bodyPreview: "Mo task moi de theo doi workflow dashboard.",
      bodyText: "Mo task moi de theo doi workflow dashboard.",
      sourceMessageId: "m-pending-1",
    });
    await recordInboundReceiptContinuity({
      cfg,
      agentId: "chief",
      receiptId: receipt!.receiptId,
      threadKey,
      continuityDecision: "new_task_candidate",
      proposalStatus: "pending_confirmation",
      proposedTaskIntentKey: "workflow-dashboard",
      openIntentKey: "workflow-dashboard",
      proposalMessageId: "m-proposal-1",
      proposalPreview: "Toi danh gia day la mot viec moi...",
    });

    const evaluation = await evaluateChiefTaskContinuity({
      cfg,
      agentId: "chief",
      threadKey,
      sessionKey: threadKey,
      messageId: "m-pending-2",
      bodyText: "Them mot vai luu y cho workflow dashboard o tren.",
    });

    expect(evaluation.classification).toBe("direct_answer");
    expect(evaluation.requiresUserApproval).toBe(false);
    expect(evaluation.reasonCodes).toContain("pending_confirmation_already_open");
  });

  it("renders new-task proposals with preserved Vietnamese accents", () => {
    const proposal = buildChiefNewTaskProposal({
      messageText: "Xây dựng workflow content mới cho dashboard team.",
      evaluation: {
        classification: "new_task_candidate",
        requiresUserApproval: true,
        reasonCodes: ["user_confirmation_required"],
        confidence: 0.82,
        intentSummary: "Xây dựng workflow content mới cho dashboard team.",
      },
    });

    expect(proposal).toContain("Tôi đánh giá đây là một việc mới");
    expect(proposal).toContain("Tóm tắt yêu cầu");
    expect(proposal).toContain("Nếu mở task mới, tôi sẽ:");
    expect(proposal).toContain("Anh chọn một hướng bên dưới:");
  });
});
