import { agentCommand } from "../agents/agent-command.js";
import { createDefaultDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { parseSessionThreadInfo } from "../config/sessions/delivery-info.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore, resolveSessionStoreEntry } from "../config/sessions/store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { deliveryContextFromSession } from "../utils/delivery-context.js";
import {
  CHIEF_TASK_STALE_AFTER_MS,
  listStaleChiefTasks,
  markChiefTaskResumeRequested,
  recordChiefTaskFailure,
  recordChiefTaskProgress,
  recordChiefTaskRecovery,
  recordChiefTaskResult,
  resolveChiefTaskHeadline,
  type ChiefTaskRecord,
} from "./chief-task-ledger.js";
import { getInboundReceiptRecord, type InboundReceiptRecord } from "./inbound-receipt-ledger.js";

export const DEFAULT_CHIEF_CONTINUATION_CHECK_MS = 60_000;

const log = createSubsystemLogger("chief/continuation-runner");

export type ChiefContinuationRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

export type ChiefContinuationResumeResult = {
  deliveryContext: Awaited<ReturnType<typeof resolveChiefContinuationDeliveryContext>>;
  result: Awaited<ReturnType<typeof agentCommand>>;
};

function buildChiefContinuationPrompt(task: ChiefTaskRecord): string {
  const headline = resolveChiefTaskHeadline(task);
  const lines = [
    "Resume the unfinished task below and continue it until it is finished, blocked, or clearly awaiting user input.",
    "Do not start unrelated work.",
    "Do not reply with NO_REPLY for this tracked user-facing task.",
    "",
    `Task ID: ${task.taskId}`,
    `Source: ${task.source}`,
    `Session: ${task.sessionKey}`,
    `${headline.kind === "goal" ? "Goal" : headline.kind === "intent" ? "Intent" : headline.kind === "success" ? "Success criteria" : headline.kind === "request" ? "Task request" : "Task summary"}: ${headline.text}`,
    `Task summary: ${task.title}`,
    `Original request: ${task.promptPreview}`,
  ];
  if (task.lastResponsePreview) {
    lines.push(`Last response preview: ${task.lastResponsePreview}`);
  }
  if (task.lastError) {
    lines.push(`Last error: ${task.lastError}`);
  }
  lines.push(
    "",
    "If the task is already complete, provide the final answer only once.",
    "If the task is blocked or waiting for input, say exactly what is missing.",
    "If you cannot finish, emit a concise terminal summary with the actual blocker, latest milestone, and next step.",
  );
  return lines.join("\n");
}

function normalizeOptionalThreadId(value?: string | number | null): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function parseTelegramReplyThreadId(
  receiptId: string | undefined,
  fallbackThreadId?: string | number,
): string | undefined {
  const trimmed = receiptId?.trim();
  if (trimmed?.startsWith("telegram|")) {
    const parts = trimmed.split("|");
    const threadId = parts[3]?.trim();
    if (threadId && threadId.toLowerCase() !== "main") {
      return threadId;
    }
  }
  return normalizeOptionalThreadId(fallbackThreadId);
}

function deriveTelegramReplyTargetFromSessionKey(
  sessionKey: string | undefined,
): { replyTo?: string; threadId?: string } {
  const trimmed = sessionKey?.trim();
  if (!trimmed) {
    return {};
  }
  const { baseSessionKey, threadId } = parseSessionThreadInfo(trimmed);
  const baseKey = baseSessionKey?.trim();
  if (!baseKey) {
    return { threadId };
  }
  const rawParts = baseKey.split(":").filter(Boolean);
  const parts = rawParts.length >= 3 && rawParts[0] === "agent" ? rawParts.slice(2) : rawParts;
  if (parts[0]?.toLowerCase() !== "telegram") {
    return { threadId };
  }
  const kind = parts[1]?.toLowerCase();
  const id = parts.slice(2).join(":").trim();
  if (!id) {
    return { threadId };
  }
  if (kind === "direct") {
    return {
      replyTo: `telegram:${id}`,
      threadId,
    };
  }
  if (kind === "group" || kind === "channel") {
    return {
      replyTo: `telegram:${kind}:${id}${threadId ? `:topic:${threadId}` : ""}`,
      threadId,
    };
  }
  return { threadId };
}

function resolveTelegramSessionDeliveryContext(params: {
  cfg: OpenClawConfig;
  sessionKey: string | undefined;
}): { replyTo?: string; replyAccountId?: string; threadId?: string } {
  const fallback = deriveTelegramReplyTargetFromSessionKey(params.sessionKey);
  const trimmedSessionKey = params.sessionKey?.trim();
  if (!trimmedSessionKey) {
    return fallback;
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: "chief" });
    const store = loadSessionStore(storePath);
    const { baseSessionKey } = parseSessionThreadInfo(trimmedSessionKey);
    const candidateKeys = [trimmedSessionKey, baseSessionKey?.trim()]
      .filter((value): value is string => Boolean(value))
      .filter((value, index, values) => values.indexOf(value) === index);
    for (const candidateKey of candidateKeys) {
      const { existing } = resolveSessionStoreEntry({
        store,
        sessionKey: candidateKey,
      });
      const delivery = deliveryContextFromSession(existing);
      if (!delivery?.channel || delivery.channel !== "telegram" || !delivery.to) {
        continue;
      }
      return {
        replyTo: delivery.to,
        replyAccountId: typeof delivery.accountId === "string" ? delivery.accountId.trim() || undefined : undefined,
        threadId: normalizeOptionalThreadId(delivery.threadId) ?? fallback.threadId,
      };
    }
  } catch {
    // Session store lookup is best-effort.
  }
  return fallback;
}

function deriveTelegramReplyTarget(
  task: Pick<ChiefTaskRecord, "sessionKey">,
  receipt: Pick<InboundReceiptRecord, "originatingTo"> | null,
  fallbackReplyTo?: string,
): string | undefined {
  const originatingTo = receipt?.originatingTo?.trim();
  if (originatingTo) {
    return originatingTo;
  }
  if (fallbackReplyTo?.trim()) {
    return fallbackReplyTo.trim();
  }
  return deriveTelegramReplyTargetFromSessionKey(task.sessionKey).replyTo;
}

async function resolveChiefContinuationDeliveryContext(params: {
  cfg: OpenClawConfig;
  task: ChiefTaskRecord;
}): Promise<{
  replyTo?: string;
  replyChannel?: string;
  replyAccountId?: string;
  threadId?: string;
  inboundReceiptId?: string;
  sourceMessageId?: string;
  paperclipIssueId?: string;
  threadKey?: string;
  openIntentKey?: string;
  intentSummary?: string;
  currentGoal?: string;
  continuityDecision?: ChiefTaskRecord["continuityDecision"];
  createdByApproval?: boolean;
}> {
  const receiptId = params.task.receiptId?.trim();
  const receipt =
    receiptId && params.task.source !== "internal"
      ? await getInboundReceiptRecord({
          cfg: params.cfg,
          agentId: "chief",
          receiptId,
        })
      : null;
  const isTelegramTask =
    params.task.source === "telegram" ||
    receipt?.sourceType === "telegram" ||
    receiptId?.startsWith("telegram|");
  const sessionDelivery = isTelegramTask
    ? resolveTelegramSessionDeliveryContext({
        cfg: params.cfg,
        sessionKey: params.task.sessionKey,
      })
    : undefined;

  return {
    ...(isTelegramTask
      ? {
          replyChannel: "telegram",
          replyTo: deriveTelegramReplyTarget(params.task, receipt, sessionDelivery?.replyTo),
          replyAccountId: receipt?.accountId?.trim() || sessionDelivery?.replyAccountId || undefined,
          threadId: parseTelegramReplyThreadId(receiptId, sessionDelivery?.threadId),
        }
      : {}),
    inboundReceiptId: receiptId,
    sourceMessageId:
      params.task.sourceMessageId?.trim() ||
      receipt?.sourceMessageId?.trim() ||
      receipt?.messageId?.trim() ||
      undefined,
    paperclipIssueId: params.task.paperclipIssueId?.trim() || receipt?.paperclipIssueId?.trim() || undefined,
    threadKey: params.task.threadKey?.trim() || receipt?.threadKey?.trim() || undefined,
    openIntentKey: params.task.openIntentKey?.trim() || receipt?.openIntentKey?.trim() || undefined,
    intentSummary: params.task.intentSummary?.trim() || undefined,
    currentGoal: params.task.currentGoal?.trim() || undefined,
    continuityDecision: params.task.continuityDecision ?? receipt?.continuityDecision,
    createdByApproval:
      params.task.createdByApproval === true || receipt?.proposalStatus === "approved" || false,
  };
}

export async function resumeChiefContinuationTask(params: {
  cfg: OpenClawConfig;
  task: ChiefTaskRecord;
  runtime?: RuntimeEnv;
  deps?: ReturnType<typeof createDefaultDeps>;
  nowMs?: () => number;
  runChief?: typeof agentCommand;
  recordTaskResult?: typeof recordChiefTaskResult;
}): Promise<ChiefContinuationResumeResult> {
  const runtime = params.runtime ?? defaultRuntime;
  const deps = params.deps ?? createDefaultDeps();
  const nowMs = params.nowMs ?? (() => Date.now());
  const runChief = params.runChief ?? agentCommand;
  const recordTaskResult = params.recordTaskResult ?? recordChiefTaskResult;
  const deliveryContext = await resolveChiefContinuationDeliveryContext({
    cfg: params.cfg,
    task: params.task,
  });
  const result = await runChief(
    {
      agentId: "chief",
      sessionKey: params.task.sessionKey,
      message: buildChiefContinuationPrompt(params.task),
      deliver: true,
      senderIsOwner: true,
      replyTo: deliveryContext.replyTo,
      replyChannel: deliveryContext.replyChannel,
      replyAccountId: deliveryContext.replyAccountId,
      threadId: deliveryContext.threadId,
      inboundReceiptId: deliveryContext.inboundReceiptId,
      sourceMessageId: deliveryContext.sourceMessageId,
      paperclipIssueId: deliveryContext.paperclipIssueId,
      threadKey: deliveryContext.threadKey,
      openIntentKey: deliveryContext.openIntentKey,
      intentSummary: deliveryContext.intentSummary,
      currentGoal: deliveryContext.currentGoal,
      continuityDecision: deliveryContext.continuityDecision,
      createdByApproval: deliveryContext.createdByApproval,
    },
    runtime,
    deps,
  );
  await recordTaskResult({
    cfg: params.cfg,
    agentId: "chief",
    taskId: params.task.taskId,
    receiptId: deliveryContext.inboundReceiptId,
    sessionKey: params.task.sessionKey,
    payloads: result?.payloads,
    deliveryConfirmed: result?.deliveryConfirmed,
    nowMs: nowMs(),
  });
  return {
    deliveryContext,
    result,
  };
}

export function startChiefContinuationRunner(opts: {
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  nowMs?: () => number;
  intervalMs?: number;
  staleAfterMs?: number;
  getQueueSize?: (lane?: string) => number;
  listStaleTasks?: typeof listStaleChiefTasks;
  markResumeRequested?: typeof markChiefTaskResumeRequested;
  recordTaskResult?: typeof recordChiefTaskResult;
  recordTaskFailure?: typeof recordChiefTaskFailure;
  runChief?: typeof agentCommand;
}): ChiefContinuationRunner {
  const runtime = opts.runtime ?? defaultRuntime;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const intervalMs = Math.max(5_000, opts.intervalMs ?? DEFAULT_CHIEF_CONTINUATION_CHECK_MS);
  const staleAfterMs = Math.max(60_000, opts.staleAfterMs ?? CHIEF_TASK_STALE_AFTER_MS);
  const getLaneSize = opts.getQueueSize ?? getQueueSize;
  const listStaleTasks = opts.listStaleTasks ?? listStaleChiefTasks;
  const markResumeRequested = opts.markResumeRequested ?? markChiefTaskResumeRequested;
  const recordTaskResult = opts.recordTaskResult ?? recordChiefTaskResult;
  const recordTaskFailure = opts.recordTaskFailure ?? recordChiefTaskFailure;
  const runChief = opts.runChief ?? agentCommand;
  const deps = createDefaultDeps();

  let cfg = opts.cfg;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(async () => {
      timer = null;
      try {
        await tick();
      } finally {
        schedule();
      }
    }, intervalMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    if (getLaneSize(CommandLane.Main) > 0) {
      return;
    }
    running = true;
    try {
      const staleTasks = await listStaleTasks({
        cfg,
        agentId: "chief",
        nowMs: nowMs(),
        staleAfterMs,
      });
      const task = staleTasks.find((candidate) => candidate.source !== "paperclip");
      if (!task) {
        return;
      }
      await markResumeRequested({
        cfg,
        agentId: "chief",
        taskId: task.taskId,
        nowMs: nowMs(),
      });
      await recordChiefTaskRecovery({
        cfg,
        agentId: "chief",
        taskId: task.taskId,
        fallbackStage: "reinvoke",
        action: "stalled_task_reinvoke",
        activeAgents: ["chief"],
        nowMs: nowMs(),
      });
      await recordChiefTaskProgress({
        cfg,
        agentId: "chief",
        taskId: task.taskId,
        sessionKey: task.sessionKey,
        sessionId: task.sessionId,
        phase: "executing",
        activeAgents: ["chief"],
        currentOwner: "chief",
        fallbackStage: "reinvoke",
        lastRecoveryAction: "stalled_task_reinvoke",
        nextStep: "Resume the stalled task and continue until it is complete, blocked, or awaiting input.",
        nowMs: nowMs(),
      });
      log.warn("chief continuation watchdog resuming stale task", {
        taskId: task.taskId,
        sessionKey: task.sessionKey,
        source: task.source,
        staleForMs: nowMs() - task.lastProgressAt,
      });
      await resumeChiefContinuationTask({
        cfg,
        task,
        runtime,
        deps,
        nowMs,
        runChief,
        recordTaskResult,
      });
    } catch (error) {
      const staleTasks = await listStaleTasks({
        cfg,
        agentId: "chief",
        nowMs: nowMs(),
        staleAfterMs,
      });
      const task = staleTasks[0];
      if (task) {
        await recordTaskFailure({
          cfg,
          agentId: "chief",
          taskId: task.taskId,
          sessionKey: task.sessionKey,
          error,
          nowMs: nowMs(),
        }).catch(() => undefined);
      }
      log.error(`chief continuation watchdog failed: ${String(error)}`);
    } finally {
      running = false;
    }
  };

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    updateConfig: (nextCfg) => {
      cfg = nextCfg;
    },
  };
}
