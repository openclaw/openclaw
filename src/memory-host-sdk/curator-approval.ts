import { createHash } from "node:crypto";
import type {
  MemoryCuratorConfidence,
  MemoryCuratorEvidenceStatus,
  MemoryCuratorFreshness,
  MemoryCuratorOperation,
  MemoryCuratorScope,
  MemoryCuratorSensitivityClass,
} from "./curator-decision.js";

export const MEMORY_CURATOR_APPROVAL_PLUGIN_ID = "memory-core";
export const MEMORY_CURATOR_APPROVAL_TOOL_NAME = "memory.promote";
export const MEMORY_CURATOR_APPROVAL_DECISIONS = ["allow-once", "deny"] as const;

export type MemoryCuratorApprovalCandidate = {
  key: string;
  sourcePath?: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
  evidenceStatus: MemoryCuratorEvidenceStatus;
  confidence: MemoryCuratorConfidence;
  freshness: MemoryCuratorFreshness;
  sensitivityClass: MemoryCuratorSensitivityClass;
  privateOrSharedScope: MemoryCuratorScope;
  reasons: string[];
  redactedPreview?: string;
  score?: number;
  recallCount?: number;
  uniqueQueries?: number;
};

export type MemoryCuratorApprovalRequest = {
  pluginId: typeof MEMORY_CURATOR_APPROVAL_PLUGIN_ID;
  title: string;
  description: string;
  severity: "warning";
  toolName: typeof MEMORY_CURATOR_APPROVAL_TOOL_NAME;
  toolCallId: string;
  allowedDecisions: typeof MEMORY_CURATOR_APPROVAL_DECISIONS;
  operation: Exclude<MemoryCuratorOperation, "daily_flush">;
  targetRelativePath: "MEMORY.md";
  candidateCount: number;
  candidates: MemoryCuratorApprovalCandidate[];
};

export type MemoryCuratorApprovalResolutionStatus =
  | "requested"
  | "allowed_once"
  | "denied"
  | "expired"
  | "replay_blocked";

export type MemoryCuratorApprovalResolution = {
  status: MemoryCuratorApprovalResolutionStatus;
  approvalId?: string;
  reasons?: string[];
};

const MAX_APPROVAL_DESCRIPTION_CHARS = 256;
const MAX_APPROVAL_PREVIEW_CHARS = 80;

const APPROVAL_SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]+/i,
  /\b(?:token|access_token|refresh_token|auth_token)\s*[:=]\s*["']?[^"'\s]+/i,
  /\b(?:cookie|session_cookie)\s*[:=]\s*["']?[^"'\n]+/i,
  /\b(?:secret|client_secret)\s*[:=]\s*["']?[^"'\s]+/i,
  /\b(?:privateKey|private_key)\s*[:=]\s*["']?[^"'\s]+/i,
  /\b(?:apiKey|api_key|api-key)\s*[:=]\s*["']?[^"'\s]+/i,
  /\b(?:seed phrase|mnemonic)\s*[:=]\s*["']?[^"'\n]+/i,
];

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sanitizeApprovalText(value: string): string {
  return truncate(
    value
      .replace(/\s+/g, " ")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi,
        "[REDACTED_PRIVATE_KEY]",
      )
      .replace(/\b(?:password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]+/gi, "[REDACTED_FIELD]")
      .replace(
        /\b(?:token|access_token|refresh_token|auth_token)\s*[:=]\s*["']?[^"'\s]+/gi,
        "[REDACTED_FIELD]",
      )
      .replace(/\b(?:cookie|session_cookie)\s*[:=]\s*["']?[^"'\n]+/gi, "[REDACTED_FIELD]")
      .replace(/\b(?:secret|client_secret)\s*[:=]\s*["']?[^"'\s]+/gi, "[REDACTED_FIELD]")
      .replace(/\b(?:privateKey|private_key)\s*[:=]\s*["']?[^"'\s]+/gi, "[REDACTED_FIELD]")
      .replace(/\b(?:apiKey|api_key|api-key)\s*[:=]\s*["']?[^"'\s]+/gi, "[REDACTED_FIELD]")
      .replace(/\b(?:seed phrase|mnemonic)\s*[:=]\s*["']?[^"'\n]+/gi, "[REDACTED_FIELD]")
      .trim(),
    MAX_APPROVAL_PREVIEW_CHARS,
  );
}

export function validateMemoryCuratorApprovalPayloadSafe(value: unknown): string[] {
  const serialized = JSON.stringify(value);
  if (!serialized) {
    return ["approval payload must serialize to JSON"];
  }
  const issues: string[] = [];
  for (const pattern of APPROVAL_SECRET_VALUE_PATTERNS) {
    if (pattern.test(serialized)) {
      issues.push("approval payload contains secret-like raw content");
      break;
    }
  }
  return issues;
}

export function buildMemoryCuratorApprovalToolCallId(params: {
  operation: Exclude<MemoryCuratorOperation, "daily_flush">;
  targetRelativePath?: string;
  candidates: readonly MemoryCuratorApprovalCandidate[];
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        operation: params.operation,
        targetRelativePath: params.targetRelativePath ?? "MEMORY.md",
        candidates: params.candidates.map((candidate) => ({
          key: candidate.key,
          sourcePath: candidate.sourcePath,
          sourceStartLine: candidate.sourceStartLine,
          sourceEndLine: candidate.sourceEndLine,
          evidenceStatus: candidate.evidenceStatus,
          confidence: candidate.confidence,
          freshness: candidate.freshness,
          sensitivityClass: candidate.sensitivityClass,
          privateOrSharedScope: candidate.privateOrSharedScope,
          reasons: candidate.reasons,
        })),
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `memory-curator:${digest}`;
}

export function buildMemoryCuratorApprovalRequest(params: {
  operation: Exclude<MemoryCuratorOperation, "daily_flush">;
  targetRelativePath?: string;
  candidates: readonly MemoryCuratorApprovalCandidate[];
}): MemoryCuratorApprovalRequest {
  const candidates = params.candidates.map((candidate) => ({
    ...candidate,
    reasons: candidate.reasons.map((reason) => sanitizeApprovalText(reason)),
    ...(candidate.redactedPreview
      ? { redactedPreview: sanitizeApprovalText(candidate.redactedPreview) }
      : {}),
  }));
  if (candidates.length === 0) {
    throw new Error("memory curator approval requires at least one candidate");
  }
  if (candidates.some((candidate) => candidate.sensitivityClass === "secret")) {
    throw new Error("secret memory content must be denied, not approval-gated");
  }
  const first = candidates[0];
  const reasonSummary = Array.from(new Set(candidates.flatMap((candidate) => candidate.reasons)))
    .slice(0, 2)
    .join("; ");
  const sourceSummary = first?.sourcePath
    ? `${first.sourcePath}:${first.sourceStartLine ?? "?"}-${first.sourceEndLine ?? "?"}`
    : "source unknown";
  const previewSummary = first?.redactedPreview ? ` preview=${first.redactedPreview}` : "";
  const request: MemoryCuratorApprovalRequest = {
    pluginId: MEMORY_CURATOR_APPROVAL_PLUGIN_ID,
    title: "Memory Curator promotion approval required",
    description: truncate(
      `Review ${candidates.length} MEMORY.md promotion candidate(s); operation=${params.operation}; sensitivity=${first?.sensitivityClass ?? "Unknown"}; freshness=${first?.freshness ?? "Unknown"}; source=${sourceSummary}; reason=${reasonSummary || "review required"};${previewSummary}`,
      MAX_APPROVAL_DESCRIPTION_CHARS,
    ),
    severity: "warning",
    toolName: MEMORY_CURATOR_APPROVAL_TOOL_NAME,
    toolCallId: buildMemoryCuratorApprovalToolCallId({
      operation: params.operation,
      targetRelativePath: params.targetRelativePath,
      candidates,
    }),
    allowedDecisions: MEMORY_CURATOR_APPROVAL_DECISIONS,
    operation: params.operation,
    targetRelativePath: "MEMORY.md",
    candidateCount: candidates.length,
    candidates,
  };
  const issues = validateMemoryCuratorApprovalPayloadSafe(request);
  if (issues.length > 0) {
    throw new Error(issues.join("; "));
  }
  return request;
}
