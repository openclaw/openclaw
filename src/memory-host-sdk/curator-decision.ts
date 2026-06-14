import path from "node:path";
import type { MemoryCuratorDecisionEvent } from "./events.js";

export type MemoryCuratorOperation =
  | "daily_flush"
  | "durable_promotion"
  | "dreaming_deep"
  | "cli_promote_apply";

export type MemoryCuratorDecision = "allow" | "deny" | "approval_required";

export type MemoryCuratorEvidenceStatus = "Confirmed" | "Inferred" | "Unknown";
export type MemoryCuratorConfidence = "high" | "medium" | "low" | "Unknown";
export type MemoryCuratorFreshness = "current" | "recent" | "stale" | "Unknown";
export type MemoryCuratorSensitivityClass =
  | "public"
  | "internal"
  | "private"
  | "secret"
  | "Unknown";
export type MemoryCuratorScope = "private" | "shared" | "global" | "Unknown";

export type MemoryPromotionApprovalContext = {
  approved?: boolean;
  targetScope?: MemoryCuratorScope;
  sensitivityClass?: MemoryCuratorSensitivityClass;
};

export type EvaluateMemoryPromotionDecisionInput = {
  agentId?: string;
  workspaceDir: string;
  targetRelativePath: string;
  operation: MemoryCuratorOperation;
  contentPreview?: string;
  sourcePath?: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
  score?: number;
  recallCount?: number;
  uniqueQueries?: number;
  nowIso: string;
  approvalContext?: MemoryPromotionApprovalContext;
};

export type MemoryPromotionDecision = {
  decision: MemoryCuratorDecision;
  evidenceStatus: MemoryCuratorEvidenceStatus;
  confidence: MemoryCuratorConfidence;
  freshness: MemoryCuratorFreshness;
  sensitivityClass: MemoryCuratorSensitivityClass;
  privateOrSharedScope: MemoryCuratorScope;
  reasons: string[];
  redactedPreview: string;
  telemetryEvent: MemoryCuratorDecisionEvent;
};

const DAILY_NOTE_RE = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;
const MEMORY_ROOT_PATH = "MEMORY.md";
const MAX_REDACTED_PREVIEW_CHARS = 240;

const SECRET_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    reason: "private key material detected",
  },
  {
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]+/i,
    reason: "password-like field detected",
  },
  {
    pattern: /\b(?:token|access_token|refresh_token|auth_token)\s*[:=]\s*["']?[^"'\s]+/i,
    reason: "token-like field detected",
  },
  {
    pattern: /\b(?:cookie|session_cookie)\s*[:=]\s*["']?[^"'\n]+/i,
    reason: "cookie-like field detected",
  },
  {
    pattern: /\b(?:secret|client_secret)\s*[:=]\s*["']?[^"'\s]+/i,
    reason: "secret-like field detected",
  },
  {
    pattern: /\b(?:privateKey|private_key)\s*[:=]\s*["']?[^"'\s]+/i,
    reason: "privateKey-like field detected",
  },
  {
    pattern: /\b(?:apiKey|api_key|api-key)\s*[:=]\s*["']?[^"'\s]+/i,
    reason: "apiKey-like field detected",
  },
  {
    pattern: /\b(?:seed phrase|mnemonic)\s*[:=]\s*["']?[^"'\n]+/i,
    reason: "wallet seed phrase-like field detected",
  },
];

function normalizeRelativePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function isMemoryRootWrite(operation: MemoryCuratorOperation, targetRelativePath: string): boolean {
  return (
    targetRelativePath === MEMORY_ROOT_PATH &&
    (operation === "durable_promotion" ||
      operation === "dreaming_deep" ||
      operation === "cli_promote_apply")
  );
}

function detectSecretReasons(content: string): string[] {
  const reasons: string[] = [];
  for (const { pattern, reason } of SECRET_PATTERNS) {
    if (pattern.test(content) && !reasons.includes(reason)) {
      reasons.push(reason);
    }
  }
  return reasons;
}

function redactPreview(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  const redacted = collapsed
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\b(?:password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]+/gi, "password=[REDACTED]")
    .replace(
      /\b(?:token|access_token|refresh_token|auth_token)\s*[:=]\s*["']?[^"'\s]+/gi,
      "token=[REDACTED]",
    )
    .replace(/\b(?:cookie|session_cookie)\s*[:=]\s*["']?[^"'\n]+/gi, "cookie=[REDACTED]")
    .replace(/\b(?:secret|client_secret)\s*[:=]\s*["']?[^"'\s]+/gi, "secret=[REDACTED]")
    .replace(/\b(?:privateKey|private_key)\s*[:=]\s*["']?[^"'\s]+/gi, "privateKey=[REDACTED]")
    .replace(/\b(?:apiKey|api_key|api-key)\s*[:=]\s*["']?[^"'\s]+/gi, "apiKey=[REDACTED]")
    .replace(/\b(?:seed phrase|mnemonic)\s*[:=]\s*["']?[^"'\n]+/gi, "seed phrase=[REDACTED]");
  return redacted.length <= MAX_REDACTED_PREVIEW_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_REDACTED_PREVIEW_CHARS - 1)}…`;
}

function inferConfidence(score: number | undefined, content: string): MemoryCuratorConfidence {
  if (/\bconfidence\s*[:=]\s*(?:high|confirmed|0\.[89]\d*|1(?:\.0+)?)\b/i.test(content)) {
    return "high";
  }
  if (/\bconfidence\s*[:=]\s*(?:medium|0\.[5-7]\d*)\b/i.test(content)) {
    return "medium";
  }
  if (/\bconfidence\s*[:=]\s*(?:low|0\.[0-4]\d*)\b/i.test(content)) {
    return "low";
  }
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return "Unknown";
  }
  if (score >= 0.85) {
    return "high";
  }
  if (score >= 0.65) {
    return "medium";
  }
  return "low";
}

function inferSensitivity(
  content: string,
  approvalContext?: MemoryPromotionApprovalContext,
): MemoryCuratorSensitivityClass {
  if (approvalContext?.sensitivityClass) {
    return approvalContext.sensitivityClass;
  }
  if (detectSecretReasons(content).length > 0) {
    return "secret";
  }
  if (/\b(?:private|personal|confidential|sensitive)\b/i.test(content)) {
    return "private";
  }
  if (/\b(?:public|shareable)\b/i.test(content)) {
    return "public";
  }
  return "internal";
}

function inferFreshness(params: { sourcePath?: string; nowIso: string }): MemoryCuratorFreshness {
  const day = params.sourcePath?.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
  if (!day) {
    return "current";
  }
  const now = Date.parse(params.nowIso);
  const then = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(now) || !Number.isFinite(then)) {
    return "Unknown";
  }
  const ageDays = Math.max(0, (now - then) / (24 * 60 * 60 * 1000));
  if (ageDays <= 30) {
    return "current";
  }
  if (ageDays <= 365) {
    return "recent";
  }
  return "stale";
}

function hasSourceCoordinates(params: {
  sourcePath?: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
}): boolean {
  return (
    typeof params.sourcePath === "string" &&
    params.sourcePath.trim().length > 0 &&
    Number.isInteger(params.sourceStartLine) &&
    Number.isInteger(params.sourceEndLine) &&
    (params.sourceStartLine ?? 0) > 0 &&
    (params.sourceEndLine ?? 0) >= (params.sourceStartLine ?? 0)
  );
}

function eventTypeForDecision(decision: MemoryCuratorDecision): MemoryCuratorDecisionEvent["type"] {
  if (decision === "allow") {
    return "memory.curator.decision.allow";
  }
  if (decision === "approval_required") {
    return "memory.curator.decision.approval_required";
  }
  return "memory.curator.decision.deny";
}

export function evaluateMemoryPromotionDecision(
  input: EvaluateMemoryPromotionDecisionInput,
): MemoryPromotionDecision {
  const targetRelativePath = normalizeRelativePath(input.targetRelativePath);
  const contentPreview = input.contentPreview ?? "";
  const sourcePath = input.sourcePath ? normalizeRelativePath(input.sourcePath) : undefined;
  const reasons: string[] = [];
  const secretReasons = detectSecretReasons(contentPreview);
  const sensitivityClass = inferSensitivity(contentPreview, input.approvalContext);
  const privateOrSharedScope = input.approvalContext?.targetScope ?? "private";
  const isDailyFlush = input.operation === "daily_flush";
  const isDurableWrite = targetRelativePath === MEMORY_ROOT_PATH;

  if (
    targetRelativePath !== path.posix.normalize(targetRelativePath) ||
    targetRelativePath.includes("..")
  ) {
    reasons.push("target path must be a normalized workspace-relative path");
  }
  if (isDailyFlush && !DAILY_NOTE_RE.test(targetRelativePath)) {
    reasons.push("daily memory flush may only append to memory/YYYY-MM-DD.md");
  }
  if (!isDailyFlush && isDurableWrite && !isMemoryRootWrite(input.operation, targetRelativePath)) {
    reasons.push("MEMORY.md writes require a durable promotion operation");
  }
  if (!isDailyFlush && !isDurableWrite) {
    reasons.push("durable memory promotion target must be MEMORY.md");
  }
  if (!isDailyFlush && !hasSourceCoordinates({ ...input, sourcePath })) {
    reasons.push("durable promotion requires source path and source line coordinates");
  }
  reasons.push(...secretReasons);

  let decision: MemoryCuratorDecision = reasons.length > 0 ? "deny" : "allow";
  if (
    decision === "allow" &&
    sensitivityClass === "private" &&
    (privateOrSharedScope === "shared" || privateOrSharedScope === "global") &&
    input.approvalContext?.approved !== true
  ) {
    decision = "approval_required";
    reasons.push("private memory requires approval before shared/global promotion");
  }

  const evidenceStatus: MemoryCuratorEvidenceStatus = isDailyFlush
    ? "Inferred"
    : hasSourceCoordinates({ ...input, sourcePath })
      ? "Confirmed"
      : "Unknown";
  const confidence = inferConfidence(input.score, contentPreview);
  const freshness = inferFreshness({ sourcePath, nowIso: input.nowIso });
  if (freshness === "stale" && decision === "allow" && input.approvalContext?.approved !== true) {
    decision = "approval_required";
    reasons.push("stale memory requires review before durable promotion");
  }

  const redactedPreview = redactPreview(contentPreview);
  const telemetryEvent: MemoryCuratorDecisionEvent = {
    type: eventTypeForDecision(decision),
    timestamp: input.nowIso,
    agentId: input.agentId,
    operation: input.operation,
    decision,
    targetRelativePath,
    ...(sourcePath ? { sourcePath } : {}),
    ...(typeof input.sourceStartLine === "number"
      ? { sourceStartLine: input.sourceStartLine }
      : {}),
    ...(typeof input.sourceEndLine === "number" ? { sourceEndLine: input.sourceEndLine } : {}),
    evidenceStatus,
    confidence,
    freshness,
    sensitivityClass,
    privateOrSharedScope,
    reasons,
    redactedPreview,
    ...(typeof input.score === "number" && Number.isFinite(input.score)
      ? { score: input.score }
      : {}),
    ...(typeof input.recallCount === "number" && Number.isFinite(input.recallCount)
      ? { recallCount: input.recallCount }
      : {}),
    ...(typeof input.uniqueQueries === "number" && Number.isFinite(input.uniqueQueries)
      ? { uniqueQueries: input.uniqueQueries }
      : {}),
  };

  return {
    decision,
    evidenceStatus,
    confidence,
    freshness,
    sensitivityClass,
    privateOrSharedScope,
    reasons,
    redactedPreview,
    telemetryEvent,
  };
}
