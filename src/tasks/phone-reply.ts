import {
  loadPendingDecisionQueue,
  projectPendingDecisionRecord,
  type PendingDecisionRecord,
} from "./pending-decision-queue.js";
import {
  loadSafeTaskIndex,
  projectSafeTaskRecord,
  type SafeTaskPublicRecord,
  type SafeTaskRecord,
} from "./safe-task-index.js";

export type PhoneControlIntent = "status" | "decisions" | "continue" | "unknown";

export type PhoneControlContinueCandidate = {
  task_id: string;
  title: string;
  workspace: string;
  source: string;
  status: SafeTaskRecord["status"];
  risk: SafeTaskRecord["risk"];
  allowed_actions: string[];
  reason: string;
  record: SafeTaskPublicRecord;
};

export type PhoneControlReply = {
  intent: PhoneControlIntent;
  text: string;
  generated_at: string;
  no_delivery: true;
  task_count: number;
  active_task_count: number;
  pending_decision_count: number;
  continue_candidate_count: number;
  tasks: SafeTaskPublicRecord[];
  decisions: PendingDecisionRecord[];
  continue_candidates: PhoneControlContinueCandidate[];
  safe_sources: string[];
  excluded_sources: string[];
  load_errors: string[];
};

const ACTIVE_STATUSES = new Set(["running", "paused", "blocked", "needs_decision"]);
const CONTINUABLE_STATUSES = new Set(["running", "paused", "blocked"]);

const SAFE_SOURCES = [
  "explicit safe task metadata",
  "pending decision queue",
  "hard-boundary task metadata",
];

const EXCLUDED_SOURCES = [
  "Codex App sqlite",
  "Codex App logs",
  "auth material",
  "caches",
  "raw transcripts",
  "live phone delivery",
];

function generatedAt(): string {
  return new Date().toISOString();
}

export function classifyPhoneControlIntent(input: string): PhoneControlIntent {
  const text = input.trim().toLowerCase();
  if (!text) {
    return "status";
  }
  if (text.includes("有什么要确认") || text.includes("待确认") || text.includes("decisions")) {
    return "decisions";
  }
  if (text.includes("继续任务") || text.includes("continue")) {
    return "continue";
  }
  if (text.includes("你在干啥") || text.includes("在干嘛") || text.includes("status")) {
    return "status";
  }
  return "unknown";
}

function isContinueCandidate(task: SafeTaskRecord): boolean {
  if (!CONTINUABLE_STATUSES.has(task.status)) {
    return false;
  }
  if (task.risk === "high" || task.risk === "hard-boundary") {
    return false;
  }
  return (
    task.allowed_actions.includes("continue_registered_local_task") ||
    task.allowed_actions.includes("continue_task") ||
    task.handoff.state === "approved"
  );
}

function decisionFromSafeTask(task: SafeTaskRecord): PendingDecisionRecord {
  return {
    id: `safe-task:${task.task_id}`,
    title: task.title,
    action: "continue_registered_local_task",
    reason: task.blocked_reason || "Task requires an explicit decision before continuation",
    risk: task.risk === "high" ? "high" : "hard-boundary",
    source: task.source,
    task_id: task.task_id,
    workspace: task.workspace,
    approval_target: "operator",
    rollback: "no action has been taken; keep task blocked until approved",
    safe_alternative: "produce a local review packet and wait for explicit approval",
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function toContinueCandidate(task: SafeTaskRecord): PhoneControlContinueCandidate {
  return {
    task_id: task.task_id,
    title: task.title,
    workspace: task.workspace,
    source: task.source,
    status: task.status,
    risk: task.risk,
    allowed_actions: [...task.allowed_actions],
    reason: "local reversible continuation is explicitly allowed by safe task metadata",
    record: projectSafeTaskRecord(task),
  };
}

function summarizeTask(task: SafeTaskRecord): string {
  return `${task.title} (${task.status}, ${task.risk})`;
}

function buildStatusText(params: {
  tasks: SafeTaskRecord[];
  activeTaskCount: number;
  decisions: PendingDecisionRecord[];
  continueCandidates: PhoneControlContinueCandidate[];
}): string {
  const headline =
    `OpenClaw 正在跟踪 ${params.tasks.length} 个本地任务，` +
    `${params.activeTaskCount} 个还在进行，` +
    `${params.decisions.length} 个需要确认，` +
    `${params.continueCandidates.length} 个可以本地继续。`;
  const active = params.tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).slice(0, 3);
  if (active.length === 0) {
    return `${headline}\n当前没有进行中的本地任务。`;
  }
  return `${headline}\n当前重点：${active.map(summarizeTask).join("；")}`;
}

function buildDecisionText(decisions: PendingDecisionRecord[]): string {
  if (decisions.length === 0) {
    return "现在没有待确认事项。手机入口不会自动批准发布、删除、外部发送、远程写入、记忆写入或常驻后台动作。";
  }
  const lines = decisions.slice(0, 5).map((decision, index) => {
    return `${index + 1}. ${decision.title}: ${decision.reason}；安全替代：${decision.safe_alternative}`;
  });
  return `有 ${decisions.length} 个待确认事项：\n${lines.join("\n")}`;
}

function buildContinueText(params: {
  decisions: PendingDecisionRecord[];
  continueCandidates: PhoneControlContinueCandidate[];
}): string {
  if (params.continueCandidates.length === 0) {
    if (params.decisions.length > 0) {
      return "没有可以直接继续的本地任务。现在有待确认事项，继续前需要先由你明确批准。";
    }
    return "没有可以直接继续的本地任务。";
  }
  const lines = params.continueCandidates.slice(0, 5).map((candidate, index) => {
    return `${index + 1}. ${candidate.title} (${candidate.status}, ${candidate.risk})`;
  });
  return (
    `可以继续 ${params.continueCandidates.length} 个本地安全任务；本探针只列出候选，不会实际执行：\n` +
    lines.join("\n")
  );
}

export function buildPhoneControlReply(input: string): PhoneControlReply {
  const intent = classifyPhoneControlIntent(input);
  const loadedTasks = loadSafeTaskIndex();
  const loadedDecisions = loadPendingDecisionQueue();
  const tasks = loadedTasks.index.tasks;
  const safeTaskDecisions = tasks
    .filter((task) => task.status === "needs_decision" || task.risk === "hard-boundary")
    .map(decisionFromSafeTask);
  const decisions = [
    ...loadedDecisions.queue.decisions.map(projectPendingDecisionRecord),
    ...safeTaskDecisions,
  ];
  const continueCandidates = tasks.filter(isContinueCandidate).map(toContinueCandidate);
  const activeTaskCount = tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length;
  const replyIntent = intent === "unknown" ? "status" : intent;
  const text =
    replyIntent === "decisions"
      ? buildDecisionText(decisions)
      : replyIntent === "continue"
        ? buildContinueText({ decisions, continueCandidates })
        : buildStatusText({ tasks, activeTaskCount, decisions, continueCandidates });

  return {
    intent: replyIntent,
    text,
    generated_at: generatedAt(),
    no_delivery: true,
    task_count: tasks.length,
    active_task_count: activeTaskCount,
    pending_decision_count: decisions.length,
    continue_candidate_count: continueCandidates.length,
    tasks: tasks.map(projectSafeTaskRecord),
    decisions,
    continue_candidates: continueCandidates,
    safe_sources: SAFE_SOURCES,
    excluded_sources: EXCLUDED_SOURCES,
    load_errors: [...loadedTasks.loadErrors, ...loadedDecisions.loadErrors],
  };
}
