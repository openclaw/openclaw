import type { OpenClawConfig } from "../config/config.js";
import {
  findInboundReceiptByMessageId,
  listInboundReceipts,
  type InboundReceiptRecord,
} from "./inbound-receipt-ledger.js";
import {
  listChiefTaskContinuityCandidates,
  type ChiefTaskRecord,
} from "./chief-task-ledger.js";

export type ChiefTaskContinuityClassification =
  | "direct_answer"
  | "attach_existing_task"
  | "new_task_candidate";

export type ChiefTaskContinuityEvaluation = {
  classification: ChiefTaskContinuityClassification;
  requiresUserApproval: boolean;
  matchedTaskId?: string;
  matchedPaperclipIssueId?: string;
  openIntentKey?: string;
  reasonCodes: string[];
  confidence: number;
  intentSummary?: string;
  currentGoal?: string;
  suggestedTitle?: string;
};

export type ChiefAutonomyPolicy = {
  autonomyMode: "standard" | "autonomous_executive";
  newTaskPolicy: "require_approval" | "auto_create";
  featureExpansionPolicy: "bounded" | "value_driven";
  questionPolicy: "iterative" | "intake_batch_only";
  releaseGateRequired: boolean;
};

const SHORT_DIRECT_MAX_CHARS = 220;
const ATTACH_CONFIDENCE_THRESHOLD = 0.58;
const WEAK_ATTACH_THRESHOLD = 0.32;
const SINGLE_TASK_ATTACH_THRESHOLD = 0.18;

const STOPWORDS = new Set([
  "anh",
  "chi",
  "em",
  "toi",
  "moi",
  "nay",
  "kia",
  "la",
  "va",
  "voi",
  "cua",
  "cho",
  "trong",
  "tren",
  "duoc",
  "khong",
  "co",
  "hay",
  "nhe",
  "nha",
  "giu",
  "giuup",
  "please",
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "need",
  "them",
  "they",
  "you",
  "your",
  "neu",
  "roi",
  "mot",
  "cai",
  "ve",
  "de",
  "di",
]);

const DIRECT_QUESTION_PREFIXES = [
  "la gi",
  "gi",
  "sao",
  "vi sao",
  "tai sao",
  "co phai",
  "the nao",
  "bao gio",
  "bao lau",
  "bao nhieu",
  "what",
  "why",
  "how",
  "when",
  "where",
  "which",
  "who",
];

const DIRECT_GREETING_PREFIXES = [
  "hi",
  "hello",
  "hey",
  "xin chao",
  "chao",
  "chao em",
  "hi em",
  "hello em",
];

const TRACKED_WORK_CUES = [
  "fix",
  "sua",
  "trien khai",
  "tiep tuc",
  "resume",
  "continue",
  "xay dung",
  "tao",
  "thiet ke",
  "debug",
  "dieu tra",
  "workflow",
  "task",
  "issue",
  "paperclip",
  "agent",
  "refactor",
  "deploy",
  "release",
  "cau hinh",
  "runtime",
  "tai lieu",
  "ke hoach",
];

const STRONG_TRACKED_ACTION_CUES = [
  "fix",
  "sua",
  "trien khai",
  "tiep tuc",
  "resume",
  "continue",
  "xay dung",
  "tao",
  "thiet ke",
  "debug",
  "dieu tra",
  "workflow",
  "task",
  "issue",
  "refactor",
  "deploy",
  "release",
];

const EXPLICIT_NEW_TASK_CUES = [
  "mo task",
  "mở task",
  "task moi",
  "task mới",
  "new task",
  "tao task",
  "tạo task",
  "tao issue",
  "tạo issue",
  "issue moi",
  "issue mới",
  "tracked work",
  "paperclip de theo doi",
  "paperclip để theo dõi",
  "theo doi toi khi xong",
  "theo dõi tới khi xong",
];

const DURABLE_TRACKED_CUES = [
  "paperclip",
  "tracked",
  "theo doi",
  "theo dõi",
  "checkpoint",
  "owner",
  "eta",
  "blocker",
  "issue",
  "project",
  "du an",
  "dự án",
  "roadmap",
  "milestone",
];

const POLICY_INSTRUCTION_CUES = [
  "tu nay",
  "từ nay",
  "bat buoc",
  "bắt buộc",
  "quy tac",
  "quy tắc",
  "nguyen tac",
  "nguyên tắc",
  "rule",
  "policy",
  "mac dinh",
  "mặc định",
  "luat",
  "luật",
  "luu y",
  "lưu ý",
];

export function resolveChiefAutonomyPolicy(cfg: OpenClawConfig): ChiefAutonomyPolicy {
  const defaults = cfg.agents?.defaults;
  const autonomyMode =
    defaults?.autonomyMode === "standard" ? "standard" : "autonomous_executive";
  const newTaskPolicy =
    defaults?.newTaskPolicy === "require_approval"
      ? "require_approval"
      : autonomyMode === "standard"
        ? "require_approval"
        : "auto_create";
  return {
    autonomyMode,
    newTaskPolicy,
    featureExpansionPolicy:
      defaults?.featureExpansionPolicy === "bounded" ? "bounded" : "value_driven",
    questionPolicy:
      defaults?.questionPolicy === "iterative" ? "iterative" : "intake_batch_only",
    releaseGateRequired: defaults?.releaseGateRequired !== false,
  };
}

function normalizePreview(value: string | undefined, maxChars = 220): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeIntentText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeIntent(value: string | undefined): string[] {
  const normalized = normalizeIntentText(value);
  if (!normalized) {
    return [];
  }
  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !STOPWORDS.has(token))
    .slice(0, 24);
}

function uniqueTokens(value: string | undefined): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of tokenizeIntent(value)) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

export function deriveChiefOpenIntentKey(value: string | undefined): string | undefined {
  const tokens = uniqueTokens(value).slice(0, 8);
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens.join("-");
}

function buildIntentSummary(value: string | undefined): string | undefined {
  return normalizePreview(value, 160) || undefined;
}

function buildSuggestedTitle(value: string | undefined): string | undefined {
  const preview = normalizePreview(value, 100);
  if (!preview) {
    return undefined;
  }
  return preview.replace(/[?.!]+$/g, "").trim() || undefined;
}

function hasTrackedWorkCue(value: string | undefined): boolean {
  const normalized = normalizeIntentText(value);
  return TRACKED_WORK_CUES.some((cue) => normalized.includes(cue));
}

function hasStrongTrackedActionCue(value: string | undefined): boolean {
  const normalized = normalizeIntentText(value);
  return STRONG_TRACKED_ACTION_CUES.some((cue) => normalized.includes(cue));
}

function hasContinuationCue(value: string | undefined): boolean {
  const normalized = normalizeIntentText(value);
  return ["tiep tuc", "resume", "continue", "lam tiep", "xu ly tiep"].some((cue) =>
    normalized.includes(cue),
  );
}

function hasExplicitNewTaskCue(value: string | undefined): boolean {
  const normalized = normalizeIntentText(value);
  return EXPLICIT_NEW_TASK_CUES.some((cue) => normalized.includes(cue));
}

function hasDurableTrackedCue(value: string | undefined): boolean {
  const normalized = normalizeIntentText(value);
  return DURABLE_TRACKED_CUES.some((cue) => normalized.includes(cue));
}

function isLikelyPolicyInstruction(value: string | undefined): boolean {
  const normalized = normalizeIntentText(value);
  return POLICY_INSTRUCTION_CUES.some((cue) => normalized.includes(cue));
}

function shouldRequireNewTaskApproval(params: {
  bodyText: string;
  candidates: ChiefTaskRecord[];
  bestScore?: number;
}): boolean {
  const { bodyText, candidates, bestScore } = params;
  if (!bodyText) {
    return false;
  }
  if (isLikelyPolicyInstruction(bodyText) && !hasExplicitNewTaskCue(bodyText)) {
    return false;
  }
  if (hasExplicitNewTaskCue(bodyText)) {
    return true;
  }
  if (!hasStrongTrackedActionCue(bodyText)) {
    return false;
  }
  if (!hasDurableTrackedCue(bodyText)) {
    return false;
  }
  if (candidates.length > 0 && (bestScore ?? 0) >= WEAK_ATTACH_THRESHOLD) {
    return false;
  }
  return bodyText.trim().length >= 260;
}

function isPendingConfirmationReceipt(receipt: InboundReceiptRecord): boolean {
  return (
    receipt.status === "awaiting_input" &&
    receipt.proposalStatus === "pending_confirmation" &&
    receipt.continuityDecision === "new_task_candidate"
  );
}

async function findPendingConfirmationReceipt(params: {
  cfg: OpenClawConfig;
  agentId: string;
  threadKey?: string;
  openIntentKey?: string;
}): Promise<InboundReceiptRecord | null> {
  if (!params.threadKey) {
    return null;
  }
  const receipts = await listInboundReceipts({
    cfg: params.cfg,
    agentId: params.agentId,
    threadKey: params.threadKey,
    limit: 20,
  });
  const pending = receipts.filter(isPendingConfirmationReceipt);
  if (pending.length === 0) {
    return null;
  }
  if (params.openIntentKey) {
    const exact = pending.find((receipt) => receipt.openIntentKey === params.openIntentKey);
    if (exact) {
      return exact;
    }
  }
  return pending[0] ?? null;
}

function isLikelyShortDirectAnswer(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return false;
  }
  if (trimmed.length > SHORT_DIRECT_MAX_CHARS) {
    return false;
  }
  if (hasStrongTrackedActionCue(trimmed)) {
    return false;
  }
  const normalized = normalizeIntentText(trimmed);
  if (
    DIRECT_GREETING_PREFIXES.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
    )
  ) {
    return true;
  }
  return (
    /[?？]$/.test(trimmed) ||
    DIRECT_QUESTION_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function jaccardScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const aSet = new Set(a);
  const bSet = new Set(b);
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...aSet, ...bSet]).size;
  return union > 0 ? intersection / union : 0;
}

function buildCandidateText(task: ChiefTaskRecord): string {
  return [
    task.openIntentKey,
    task.intentSummary,
    task.currentGoal,
    task.title,
    task.promptPreview,
    task.lastResponsePreview,
  ]
    .filter(Boolean)
    .join(" ");
}

function scoreTaskCandidate(task: ChiefTaskRecord, bodyText: string, openIntentKey?: string): number {
  const requestTokens = uniqueTokens(openIntentKey ?? bodyText);
  const candidateTokens = uniqueTokens(buildCandidateText(task));
  return jaccardScore(requestTokens, candidateTokens);
}

type EvaluateParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  threadKey?: string;
  sessionKey?: string;
  messageId: string;
  replyToId?: string;
  bodyText?: string;
};

function toAttachResult(params: {
  task: ChiefTaskRecord;
  openIntentKey?: string;
  reasonCodes: string[];
  confidence: number;
}): ChiefTaskContinuityEvaluation {
  return {
    classification: "attach_existing_task",
    requiresUserApproval: false,
    matchedTaskId: params.task.taskId,
    matchedPaperclipIssueId: params.task.paperclipIssueId,
    openIntentKey: params.openIntentKey ?? params.task.openIntentKey,
    reasonCodes: params.reasonCodes,
    confidence: params.confidence,
    intentSummary: params.task.intentSummary,
    currentGoal: params.task.currentGoal ?? params.task.intentSummary ?? params.task.title,
    suggestedTitle: params.task.title,
  };
}

function resolveMatchedReplyTask(params: {
  replyReceipt: InboundReceiptRecord | null;
  candidates: ChiefTaskRecord[];
}): ChiefTaskRecord | undefined {
  const taskId = params.replyReceipt?.matchedTaskId ?? params.replyReceipt?.taskId;
  if (!taskId) {
    return undefined;
  }
  return params.candidates.find((candidate) => candidate.taskId === taskId);
}

export async function evaluateChiefTaskContinuity(
  params: EvaluateParams,
): Promise<ChiefTaskContinuityEvaluation> {
  const autonomyPolicy = resolveChiefAutonomyPolicy(params.cfg);
  const agentId = params.agentId?.trim().toLowerCase() || "chief";
  const bodyText = params.bodyText?.trim() ?? "";
  const threadKey = params.threadKey?.trim() || params.sessionKey?.trim();
  const openIntentKey = deriveChiefOpenIntentKey(bodyText);
  const candidates = await listChiefTaskContinuityCandidates({
    cfg: params.cfg,
    agentId,
    threadKey,
    sessionKey: params.sessionKey,
    limit: 12,
  });

  const replyReceipt =
    params.replyToId && threadKey
      ? await findInboundReceiptByMessageId({
          cfg: params.cfg,
          agentId,
          messageId: params.replyToId,
          threadKey,
        })
      : null;
  const replyTask = resolveMatchedReplyTask({ replyReceipt, candidates });
  if (replyTask) {
    return toAttachResult({
      task: replyTask,
      openIntentKey: openIntentKey ?? replyTask.openIntentKey,
      reasonCodes: ["reply_target_open_task"],
      confidence: 0.98,
    });
  }

  const scored = candidates
    .map((task) => ({
      task,
      score: scoreTaskCandidate(task, bodyText, openIntentKey),
    }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const pendingConfirmationReceipt = await findPendingConfirmationReceipt({
    cfg: params.cfg,
    agentId,
    threadKey,
    openIntentKey,
  });

  if (isLikelyShortDirectAnswer(bodyText) && (!best || best.score < WEAK_ATTACH_THRESHOLD)) {
    return {
      classification: "direct_answer",
      requiresUserApproval: false,
      openIntentKey,
      reasonCodes: ["short_answer_question"],
      confidence: 0.9,
      intentSummary: buildIntentSummary(bodyText),
      currentGoal: buildIntentSummary(bodyText),
      suggestedTitle: buildSuggestedTitle(bodyText),
    };
  }

  if (pendingConfirmationReceipt) {
    return {
      classification: "direct_answer",
      requiresUserApproval: false,
      matchedTaskId: pendingConfirmationReceipt.matchedTaskId,
      matchedPaperclipIssueId: pendingConfirmationReceipt.matchedPaperclipIssueId,
      openIntentKey: openIntentKey ?? pendingConfirmationReceipt.openIntentKey,
      reasonCodes: ["pending_confirmation_already_open"],
      confidence: 0.72,
      intentSummary:
        pendingConfirmationReceipt.proposedTaskIntentKey ??
        pendingConfirmationReceipt.proposalPreview ??
        pendingConfirmationReceipt.bodyPreview ??
        buildIntentSummary(bodyText),
      currentGoal: buildIntentSummary(bodyText),
      suggestedTitle: buildSuggestedTitle(bodyText),
    };
  }

  if (best && best.score >= ATTACH_CONFIDENCE_THRESHOLD) {
    return toAttachResult({
      task: best.task,
      openIntentKey: openIntentKey ?? best.task.openIntentKey,
      reasonCodes: ["same_thread_same_open_intent"],
      confidence: Math.min(0.95, Math.max(0.6, best.score)),
    });
  }

  if (
    candidates.length === 1 &&
    ((!hasTrackedWorkCue(bodyText) && (!best || best.score < WEAK_ATTACH_THRESHOLD)) ||
      hasContinuationCue(bodyText) ||
      (best != null && best.score >= SINGLE_TASK_ATTACH_THRESHOLD))
  ) {
    return toAttachResult({
      task: candidates[0],
      openIntentKey: openIntentKey ?? candidates[0].openIntentKey,
      reasonCodes: ["single_open_task_in_thread"],
      confidence: 0.56,
    });
  }

  if (!shouldRequireNewTaskApproval({ bodyText, candidates, bestScore: best?.score })) {
    return {
      classification: "direct_answer",
      requiresUserApproval: false,
      matchedTaskId: best && best.score >= WEAK_ATTACH_THRESHOLD ? best.task.taskId : undefined,
      matchedPaperclipIssueId:
        best && best.score >= WEAK_ATTACH_THRESHOLD ? best.task.paperclipIssueId : undefined,
      openIntentKey,
      reasonCodes:
        isLikelyPolicyInstruction(bodyText)
          ? ["policy_instruction"]
          : hasStrongTrackedActionCue(bodyText)
            ? ["untracked_request_no_approval_needed"]
            : ["non_tracked_request"],
      confidence: best && best.score >= WEAK_ATTACH_THRESHOLD ? Math.max(0.45, best.score) : 0.74,
      intentSummary: buildIntentSummary(bodyText),
      currentGoal: buildIntentSummary(bodyText),
      suggestedTitle: buildSuggestedTitle(bodyText),
    };
  }

  const requiresUserApproval = autonomyPolicy.newTaskPolicy === "require_approval";
  return {
    classification: "new_task_candidate",
    requiresUserApproval,
    matchedTaskId: best && best.score >= WEAK_ATTACH_THRESHOLD ? best.task.taskId : undefined,
    matchedPaperclipIssueId:
      best && best.score >= WEAK_ATTACH_THRESHOLD ? best.task.paperclipIssueId : undefined,
    openIntentKey,
    reasonCodes:
      best && best.score >= WEAK_ATTACH_THRESHOLD
        ? [
            "insufficient_match_existing_task",
            requiresUserApproval ? "user_confirmation_required" : "autonomous_task_creation",
          ]
        : [
            "no_open_task_match",
            requiresUserApproval ? "user_confirmation_required" : "autonomous_task_creation",
          ],
    confidence:
      best && best.score >= WEAK_ATTACH_THRESHOLD ? Math.max(0.35, best.score) : 0.78,
    intentSummary: buildIntentSummary(bodyText),
    currentGoal: buildIntentSummary(bodyText),
    suggestedTitle: buildSuggestedTitle(bodyText),
  };
}

export function buildChiefNewTaskProposal(params: {
  messageText?: string;
  evaluation: ChiefTaskContinuityEvaluation;
}): string {
  const summary =
    params.evaluation.intentSummary ?? buildIntentSummary(params.messageText) ?? "Y\u00eau c\u1ea7u m\u1edbi";
  const whyLine = params.evaluation.matchedTaskId
    ? "T\u00f4i th\u1ea5y c\u00f3 task \u0111ang m\u1edf trong thread n\u00e0y, nh\u01b0ng m\u1ee5c ti\u00eau ch\u01b0a \u0111\u1ee7 kh\u1edbp \u0111\u1ec3 t\u1ef1 \u0111\u1ed9ng g\u1ed9p v\u00e0o."
    : "Hi\u1ec7n ch\u01b0a c\u00f3 task \u0111ang m\u1edf n\u00e0o trong thread n\u00e0y \u0111\u1ee7 kh\u1edbp \u0111\u1ec3 ti\u1ebfp t\u1ee5c lu\u00f4n.";
  return [
    "T\u00f4i \u0111\u00e1nh gi\u00e1 \u0111\u00e2y l\u00e0 m\u1ed9t vi\u1ec7c m\u1edbi v\u00e0 c\u1ea7n anh x\u00e1c nh\u1eadn tr\u01b0\u1edbc khi m\u1edf task tracked.",
    whyLine,
    "",
    `T\u00f3m t\u1eaft y\u00eau c\u1ea7u: ${summary}`,
    "",
    "N\u1ebfu m\u1edf task m\u1edbi, t\u00f4i s\u1ebd:",
    "1. T\u1ea1o tracked work trong Paperclip \u0111\u1ec3 theo d\u00f5i t\u1edbi khi xong.",
    "2. Gi\u1eef chief l\u00e0 execution owner v\u00e0 ti\u1ebfp t\u1ee5c l\u00e0m cho t\u1edbi khi task done, blocked, ho\u1eb7c awaiting_input.",
    "3. Ghi checkpoint r\u00f5 r\u00e0ng \u0111\u1ec3 tr\u00e1nh b\u1ecf s\u00f3t v\u00e0 tr\u00e1nh t\u1ea1o task tr\u00f9ng.",
    "",
    "Anh ch\u1ecdn m\u1ed9t h\u01b0\u1edbng b\u00ean d\u01b0\u1edbi:",
  ].join("\n");
}
