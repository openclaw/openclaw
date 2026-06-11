import type { Api, Model } from "@mariozechner/pi-ai";
import type { SimpleCompletionModelOptions } from "../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isLoopbackIpAddress, isPrivateOrLoopbackIpAddress } from "../shared/net/ip.js";
import {
  normalizeSelfImprovementModelId,
  selectSelfImprovementReviewModelPlan,
  type SelfImprovementModelProfile,
  type SelfImprovementReviewPolicy,
} from "./model-policy.js";
import { sanitizeRecommendationText, sanitizeRecommendationTexts } from "./text.js";
import type {
  SelfImprovementAnalysisMode,
  SelfImprovementReviewAttemptDiagnostic,
  SelfImprovementModelReadiness,
  SelfImprovementModelPreflightResult,
  SelfImprovementRecommendationAnalysis,
  SelfImprovementRecommendationGroup,
  SelfImprovementReviewAttempt,
  SelfImprovementReviewModelTier,
  SelfImprovementReviewPreflightStatus,
  SelfImprovementReviewPreflightSource,
} from "./types.js";

const DEFAULT_REVIEWER_AGENT_ID = "self-improvement-governor";
const LLM_PROMPT_VERSION = "self-improvement-governor-llm-review-v2";
const MAX_REVIEW_GROUPS = 8;
const MAX_EVIDENCE_PER_GROUP = 4;
const MAX_PROMPT_CHARS = 12_000;
const MAX_SUMMARY_CHARS = 600;
const MAX_ACTION_CHARS = 600;
const MAX_SAFETY_NOTE_CHARS = 220;
const LOCAL_MODEL_HEALTH_TIMEOUT_MS = 3_000;
const LOCAL_MODEL_HEALTH_FAILURE_CACHE_TTL_MS = 60_000;
const REVIEW_PAYLOAD_GROUP_KEYS = ["groups", "recommendations", "items", "findings"] as const;
const REVIEW_PAYLOAD_WRAPPER_KEYS = [
  "result",
  "review",
  "output",
  "analysis",
  "data",
  "response",
] as const;
const REVIEW_SUMMARY_KEYS = ["summary", "analysisSummary", "recommendationSummary"] as const;
const REVIEW_ACTION_KEYS = [
  "recommendedAction",
  "recommended_action",
  "nextAction",
  "next_action",
  "nextStep",
  "next_step",
  "recommendedNextStep",
  "recommended_next_step",
  "action",
  "recommendation",
  "proposal",
] as const;
const REVIEW_CONFIDENCE_KEYS = ["confidence", "confidenceScore", "confidence_score"] as const;

export type SelfImprovementLlmReviewStatus =
  | {
      mode: "disabled";
      reason: string;
      reviewPolicy: SelfImprovementReviewPolicy;
      attempts: SelfImprovementReviewAttempt[];
      schemaValidated: false;
      groupsReviewedByLocalLlm: 0;
    }
  | {
      mode: "fallback";
      reason: string;
      reviewPolicy: SelfImprovementReviewPolicy;
      attempts: SelfImprovementReviewAttempt[];
      schemaValidated: false;
      groupsReviewedByLocalLlm: number;
      modelTier?: SelfImprovementReviewModelTier;
      modelId?: string;
      reviewModelId?: string;
      fallbackModelId?: string;
      strategicModelId?: string;
      escalationReason?: string;
    }
  | {
      mode: SelfImprovementAnalysisMode;
      groupsReviewed: number;
      modelId?: string;
      modelTier: SelfImprovementReviewModelTier;
      reviewPolicy: SelfImprovementReviewPolicy;
      attempts: SelfImprovementReviewAttempt[];
      schemaValidated: true;
      groupsReviewedByLocalLlm: number;
      reviewModelId?: string;
      fallbackModelId?: string;
      strategicModelId?: string;
      escalationReason?: string;
    };

export type SelfImprovementLlmReviewerCompletion = (params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelId?: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
  topP?: number;
  timeoutMs?: number;
  modelTier?: SelfImprovementReviewModelTier;
  local?: boolean;
}) => Promise<{
  text: string;
  provider?: string;
  modelId?: string;
}>;

export type SelfImprovementLlmReviewerPreflightResult =
  | {
      ok: true;
      status: Extract<SelfImprovementReviewPreflightStatus, "not_required" | "passed" | "skipped">;
      elapsedMs: number;
      reason?: string;
      preflightSource?: SelfImprovementReviewPreflightSource;
      providerConfigured?: boolean;
    }
  | {
      ok: false;
      status: Extract<SelfImprovementReviewPreflightStatus, "missing_config" | "unavailable">;
      elapsedMs: number;
      reason: string;
      preflightSource?: SelfImprovementReviewPreflightSource;
      providerConfigured?: boolean;
    };

export type SelfImprovementLlmReviewerPreflight = (params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelId?: string;
  modelTier: SelfImprovementReviewModelTier;
  local: boolean;
  timeoutMs: number;
}) => Promise<SelfImprovementLlmReviewerPreflightResult>;

export type SelfImprovementLlmReviewResult = {
  groups: SelfImprovementRecommendationGroup[];
  status: SelfImprovementLlmReviewStatus;
};

type RawReviewedGroup = {
  groupId?: unknown;
  summary?: unknown;
  recommendedAction?: unknown;
  confidence?: unknown;
  safetyNotes?: unknown;
};

type RawReviewPayload = {
  groups?: unknown;
};

type NormalizedReviewedGroup = RawReviewedGroup & {
  groupId: string;
  summary: string;
  recommendedAction: string;
  confidence: number;
};

type ReviewPayloadDiagnostic = {
  code: SelfImprovementReviewAttemptDiagnostic;
  message: string;
};

type LocalModelEndpointProbeResult =
  | { ok: true; status?: string }
  | { ok: false; status?: string; reason: string };

type CachedLocalModelEndpointProbeResult = {
  checkedAt: number;
  result: Extract<LocalModelEndpointProbeResult, { ok: false }>;
};

const localModelHealthFailureCache = new Map<string, CachedLocalModelEndpointProbeResult>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function formatBoundedReviewError(error: unknown): string {
  return redactSelfImprovementLlmText(formatErrorMessage(error), 420);
}

export function isSelfImprovementLlmReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.OPENCLAW_SELF_IMPROVEMENT_LLM?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function redactSelfImprovementLlmText(value: string, maxLength = 600): string {
  return sanitizeRecommendationText(stripSelfImprovementLlmReasoning(value), maxLength)
    .replace(/\/Users\/[^\s"'`]+/g, "[local-path]")
    .replace(/\/private\/[^\s"'`]+/g, "[local-path]")
    .replace(/\/var\/folders\/[^\s"'`]+/g, "[local-path]")
    .replace(/\b(api[_-]?key|token|secret|password)=\S+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted-token]");
}

function redactTexts(values: readonly string[], maxLength: number): string[] {
  return sanitizeRecommendationTexts(values, maxLength).map((entry) =>
    redactSelfImprovementLlmText(entry, maxLength),
  );
}

function buildReviewPayload(groups: readonly SelfImprovementRecommendationGroup[]) {
  return {
    groups: groups.slice(0, MAX_REVIEW_GROUPS).map((group) => ({
      id: group.id,
      groupId: group.id,
      title: redactSelfImprovementLlmText(group.title, 220),
      category: group.category,
      priority: group.priority,
      status: group.status,
      route: group.route.role,
      targetAgentId: group.route.targetAgentId,
      count: group.count,
      requiresTests: group.requiresTests,
      requiresApproval: group.requiresApproval,
      deterministicSummary: redactSelfImprovementLlmText(group.analysis.summary, 500),
      recommendedAction: redactSelfImprovementLlmText(group.recommendedAction, 500),
      evidence: redactTexts(group.topEvidence.slice(0, MAX_EVIDENCE_PER_GROUP), 220),
    })),
  };
}

function buildSystemPrompt(): string {
  return [
    "You are the OpenClaw Self-Improvement Governor reviewer.",
    "Review only the provided evidence. Do not invent missing facts.",
    "Return one minified JSON object only. The first character must be { and the last non-whitespace character must be }.",
    "Do not return markdown, prose, XML tags, code fences, an empty response, or thinking.",
    'The top-level object must be {"groups":[...]}. Do not return a bare array.',
    'If no group can be improved safely, return exactly {"groups":[]}.',
    "Do not recommend direct merge, push, release, destructive file actions, secret exposure, or uncontrolled skill writes.",
    "Every code/config recommendation must require tests or explicit approval.",
  ].join("\n");
}

function buildUserPrompt(groups: readonly SelfImprovementRecommendationGroup[]): string {
  const payload = JSON.stringify(buildReviewPayload(groups));
  const boundedPayload =
    payload.length > MAX_PROMPT_CHARS ? `${payload.slice(0, MAX_PROMPT_CHARS)}...` : payload;
  return [
    "Improve these grouped recommendations for routed owner review.",
    "Return exactly this JSON shape:",
    '{"groups":[{"groupId":"sig_...","summary":"short evidence-bound summary","recommendedAction":"specific safe next action","confidence":0.8,"safetyNotes":["note"]}]}',
    "Copy each exact input groupId into the corresponding output groupId. Omit groups you cannot improve safely.",
    'If you cannot improve any group safely, return {"groups":[]}.',
    "Return JSON only. Do not add comments, markdown, prose, trailing commas, or extra top-level keys.",
    "Your response must start with { and end with }.",
    "Input:",
    boundedPayload,
  ].join("\n");
}

function findBalancedJsonEnd(text: string, start: number): number | null {
  const opener = text[start];
  if (opener !== "{" && opener !== "[") {
    return null;
  }
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char !== "}" && char !== "]") {
      continue;
    }
    if (stack.at(-1) !== char) {
      return null;
    }
    stack.pop();
    if (stack.length === 0) {
      return index;
    }
  }
  return null;
}

function extractJsonValues(text: string): string[] {
  const stripped = stripSelfImprovementLlmReasoning(text);
  const values: string[] = [];
  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (char !== "{" && char !== "[") {
      continue;
    }
    const end = findBalancedJsonEnd(stripped, index);
    if (end === null) {
      continue;
    }
    values.push(stripped.slice(index, end + 1));
    index = end;
  }
  return values;
}

export function stripSelfImprovementLlmReasoning(text: string): string {
  const stripped = text
    .replace(
      /<\s*(?:think|thinking|reasoning|cot|analysis|chain[-_\s]?of[-_\s]?thought)\s*>[\s\S]*?<\s*\/\s*(?:think|thinking|reasoning|cot|analysis|chain[-_\s]?of[-_\s]?thought)\s*>/gi,
      "",
    )
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, "")
    .replace(
      /\[\s*(?:think|thinking|reasoning|cot|analysis|chain[-_\s]?of[-_\s]?thought)\s*\][\s\S]*?\[\s*\/\s*(?:think|thinking|reasoning|cot|analysis|chain[-_\s]?of[-_\s]?thought)\s*\]/gi,
      "",
    )
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  return stripUnwrappedSelfImprovementReasoning(stripped);
}

function stripUnwrappedSelfImprovementReasoning(text: string): string {
  const reasoningPrefix =
    /^\s*(?:reasoning|thinking|thought|analysis|scratchpad|chain[-_\s]?of[-_\s]?thought)\s*:\s*/i;
  if (!reasoningPrefix.test(text)) {
    return text;
  }
  const finalMarker =
    /(?:^|\s)(?:final|answer|result|output|json|recommendation|recommended\s+action)\s*:\s*/i;
  const final = finalMarker.exec(text);
  if (final?.index !== undefined) {
    return text.slice(final.index + final[0].length).trim();
  }
  return "";
}

function removeTrailingJsonCommas(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let nextIndex = index + 1;
      while (nextIndex < text.length && /\s/.test(text[nextIndex] ?? "")) {
        nextIndex += 1;
      }
      const next = text[nextIndex];
      if (next === "}" || next === "]") {
        continue;
      }
    }
    result += char;
  }
  return result;
}

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const repaired = removeTrailingJsonCommas(text);
    if (repaired === text) {
      throw error;
    }
    return JSON.parse(repaired);
  }
}

function normalizeReviewedGroupCollection(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return [];
  }
  const groups: unknown[] = [];
  let recognizableEntries = 0;
  for (const [groupId, entry] of entries) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const keyedEntry = { groupId, ...entry };
    if (
      looksLikeReviewedGroup(keyedEntry) ||
      "groupId" in entry ||
      "group_id" in entry ||
      "id" in entry
    ) {
      recognizableEntries += 1;
    }
    groups.push(keyedEntry);
  }
  return recognizableEntries > 0 ? groups : undefined;
}

function normalizeReviewPayload(value: unknown, depth = 0): RawReviewPayload | null {
  const collection = normalizeReviewedGroupCollection(value);
  if (collection) {
    return { groups: collection };
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const key of REVIEW_PAYLOAD_GROUP_KEYS) {
    const groupCollection = normalizeReviewedGroupCollection(value[key]);
    if (groupCollection) {
      return { groups: groupCollection };
    }
  }
  if ("groupId" in value) {
    return { groups: [value] };
  }
  if (looksLikeReviewedGroup(value)) {
    return { groups: [value] };
  }
  if (depth < 3) {
    for (const key of REVIEW_PAYLOAD_WRAPPER_KEYS) {
      if (key in value) {
        const payload = normalizeReviewPayload(value[key], depth + 1);
        if (payload) {
          return payload;
        }
      }
    }
  }
  return null;
}

function parseReviewPayload(text: string): RawReviewPayload | null {
  for (const json of extractJsonValues(text)) {
    try {
      const payload = normalizeReviewPayload(parseJsonValue(json));
      if (payload && Array.isArray(payload.groups)) {
        return payload;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function diagnoseReviewPayloadFailure(params: {
  text: string;
  groups: readonly SelfImprovementRecommendationGroup[];
}): ReviewPayloadDiagnostic {
  const jsonValues = extractJsonValues(params.text);
  if (jsonValues.length === 0) {
    return {
      code: "no_balanced_json",
      message: "no balanced JSON object or array was found after reasoning content was stripped",
    };
  }
  const inputGroupIds = new Set(params.groups.map((group) => group.id));
  let parsedJsonValues = 0;
  let payloadsWithGroups = 0;
  let emptyGroupPayloads = 0;
  let missingGroupIds = 0;
  let unmatchedGroupIds = 0;
  let missingRequiredFields = 0;
  let matchedButUnsafeFields = 0;
  let nonObjectGroups = 0;
  for (const json of jsonValues) {
    let parsed: unknown;
    try {
      parsed = parseJsonValue(json);
    } catch {
      continue;
    }
    parsedJsonValues += 1;
    const payload = normalizeReviewPayload(parsed);
    if (!payload || !Array.isArray(payload.groups)) {
      continue;
    }
    payloadsWithGroups += 1;
    const outputGroups = payload.groups;
    if (outputGroups.length === 0) {
      emptyGroupPayloads += 1;
      continue;
    }
    const allowSingleGroupIdFallback = params.groups.length === 1 && outputGroups.length === 1;
    for (const entry of outputGroups) {
      if (!isRecord(entry)) {
        nonObjectGroups += 1;
        continue;
      }
      const explicitGroupId = normalizeStringField(entry, ["groupId", "group_id", "id"]);
      const reviewed = normalizeReviewedGroup({
        entry,
        ...(allowSingleGroupIdFallback ? { fallbackGroupId: params.groups[0]?.id } : {}),
      });
      if (!reviewed) {
        if (!explicitGroupId && !allowSingleGroupIdFallback) {
          missingGroupIds += 1;
        } else {
          missingRequiredFields += 1;
        }
        continue;
      }
      if (!inputGroupIds.has(reviewed.groupId)) {
        unmatchedGroupIds += 1;
        continue;
      }
      const safeSummary =
        typeof reviewed.summary === "string" && reviewed.summary.trim()
          ? redactSelfImprovementLlmText(reviewed.summary, MAX_SUMMARY_CHARS)
          : "";
      const safeAction =
        typeof reviewed.recommendedAction === "string" && reviewed.recommendedAction.trim()
          ? redactSelfImprovementLlmText(reviewed.recommendedAction, MAX_ACTION_CHARS)
          : "";
      if (!safeSummary && !safeAction) {
        matchedButUnsafeFields += 1;
      }
    }
  }
  if (parsedJsonValues === 0) {
    return {
      code: "unparseable_json",
      message: "JSON-like output was present but could not be parsed after safe repairs",
    };
  }
  if (payloadsWithGroups === 0) {
    return {
      code: "missing_group_collection",
      message: "parsed JSON did not contain a recognizable groups or recommendations collection",
    };
  }
  if (emptyGroupPayloads > 0) {
    return {
      code: "empty_groups",
      message: "review payload contained no groups",
    };
  }
  if (missingGroupIds > 0) {
    return {
      code: "missing_group_id",
      message: "review groups omitted groupId values in an ambiguous payload",
    };
  }
  if (unmatchedGroupIds > 0) {
    return {
      code: "unmatched_group_id",
      message: "review groups used ids that do not match the input groups",
    };
  }
  if (missingRequiredFields > 0) {
    return {
      code: "missing_required_fields",
      message: "review groups were missing summary, recommendedAction, or confidence",
    };
  }
  if (matchedButUnsafeFields > 0) {
    return {
      code: "unsafe_fields_after_redaction",
      message:
        "matched review groups had no safe summary or recommended action after reasoning redaction",
    };
  }
  if (nonObjectGroups > 0) {
    return {
      code: "non_object_group",
      message: "review group entries were not JSON objects",
    };
  }
  return {
    code: "invalid_review_payload",
    message: "parsed JSON did not produce a schema-valid review payload",
  };
}

function buildInvalidReviewError(params: { diagnostic: ReviewPayloadDiagnostic }): string {
  return redactSelfImprovementLlmText(
    `Reviewer returned invalid JSON. Reason: ${params.diagnostic.message}.`,
    420,
  );
}

function isValidReviewedGroup(entry: RawReviewedGroup): entry is NormalizedReviewedGroup {
  return (
    typeof entry.groupId === "string" &&
    entry.groupId.trim().length > 0 &&
    typeof entry.summary === "string" &&
    entry.summary.trim().length > 0 &&
    typeof entry.recommendedAction === "string" &&
    entry.recommendedAction.trim().length > 0 &&
    typeof entry.confidence === "number" &&
    Number.isFinite(entry.confidence)
  );
}

function normalizeStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (Array.isArray(value)) {
      const parts = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 4);
      if (parts.length > 0) {
        return parts
          .map((part, index) => (index < parts.length - 1 ? part.replace(/[.;]\s*$/, "") : part))
          .join("; ");
      }
    }
  }
  return undefined;
}

function normalizeConfidenceLabel(value: string): number | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
  const labelScores: Record<string, number> = {
    certain: 0.9,
    strong: 0.85,
    high: 0.8,
    medium: 0.65,
    moderate: 0.65,
    low: 0.45,
    weak: 0.35,
    uncertain: 0.35,
  };
  return labelScores[normalized];
}

function normalizeConfidenceField(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(trimmed);
      if (percent?.[1]) {
        const parsedPercent = Number(percent[1]);
        if (Number.isFinite(parsedPercent)) {
          return parsedPercent / 100;
        }
      }
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
      const labelScore = normalizeConfidenceLabel(trimmed);
      if (labelScore !== undefined) {
        return labelScore;
      }
    }
  }
  return undefined;
}

function normalizeSafetyNotesValue(value: unknown): unknown {
  return typeof value === "string" ? [value] : value;
}

function normalizeSafetyNotesField(record: Record<string, unknown>): unknown {
  if ("safetyNotes" in record) {
    return normalizeSafetyNotesValue(record.safetyNotes);
  }
  if ("safety_notes" in record) {
    return normalizeSafetyNotesValue(record.safety_notes);
  }
  if ("safety" in record) {
    return normalizeSafetyNotesValue(record.safety);
  }
  return undefined;
}

function looksLikeReviewedGroup(record: Record<string, unknown>): boolean {
  return Boolean(
    normalizeStringField(record, REVIEW_SUMMARY_KEYS) &&
    normalizeStringField(record, REVIEW_ACTION_KEYS) &&
    normalizeConfidenceField(record, REVIEW_CONFIDENCE_KEYS) !== undefined,
  );
}

function normalizeReviewedGroup(params: {
  entry: unknown;
  fallbackGroupId?: string;
}): NormalizedReviewedGroup | null {
  if (!isRecord(params.entry)) {
    return null;
  }
  const groupId =
    normalizeStringField(params.entry, ["groupId", "group_id", "id"]) ?? params.fallbackGroupId;
  const summary = normalizeStringField(params.entry, REVIEW_SUMMARY_KEYS);
  const recommendedAction = normalizeStringField(params.entry, REVIEW_ACTION_KEYS);
  const confidence = normalizeConfidenceField(params.entry, REVIEW_CONFIDENCE_KEYS);
  const reviewed: RawReviewedGroup = {
    groupId,
    summary,
    recommendedAction,
    confidence,
    safetyNotes: normalizeSafetyNotesField(params.entry),
  };
  return isValidReviewedGroup(reviewed) ? reviewed : null;
}

function normalizeConfidence(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(0.95, Math.max(0, value))
    : fallback;
}

function normalizeSafetyNotes(value: unknown): string[] {
  const notes = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
  const bounded = redactTexts(notes, MAX_SAFETY_NOTE_CHARS).slice(0, 4);
  return bounded.length > 0
    ? bounded
    : ["LLM reviewer output is recommendation-only and must stay approval-gated."];
}

function normalizePayloadTopP(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function mentionsTestOrProof(text: string): boolean {
  return /\b(?:test|tests|tested|smoke|verification|verify|validate|proof|gate|gates)\b/i.test(
    text,
  );
}

function mentionsApproval(text: string): boolean {
  return /\b(?:approval|approved|approve|operator|pending|review gate|owner review)\b/i.test(text);
}

function reinforceClosureRequirements(params: {
  action: string;
  requiresTests: boolean;
  requiresApproval: boolean;
}): string {
  const additions: string[] = [];
  if (params.requiresTests && !mentionsTestOrProof(params.action)) {
    additions.push("attach test or smoke proof");
  }
  if (params.requiresApproval && !mentionsApproval(params.action)) {
    additions.push("keep the item pending for owner or operator approval");
  }
  if (additions.length === 0) {
    return params.action;
  }
  return redactSelfImprovementLlmText(
    `${params.action.trim()} Before resolving, ${additions.join(" and ")}.`,
    MAX_ACTION_CHARS,
  );
}

export function buildSelfImprovementLocalReviewerPayloadHint(params: {
  local?: boolean;
  model: Pick<Model<Api>, "api">;
  topP?: number;
}): SimpleCompletionModelOptions["onPayload"] | undefined {
  if (!params.local) {
    return undefined;
  }
  const topP = normalizePayloadTopP(params.topP);
  if (params.model.api === "ollama") {
    return (payload) => {
      if (!isRecord(payload)) {
        return undefined;
      }
      let changed = false;
      if (!("format" in payload)) {
        payload.format = "json";
        changed = true;
      }
      if (!("think" in payload)) {
        payload.think = false;
        changed = true;
      }
      if (topP !== undefined) {
        if (!isRecord(payload.options)) {
          payload.options = {};
          changed = true;
        }
        const options = payload.options as Record<string, unknown>;
        if (!("top_p" in options)) {
          options.top_p = topP;
          changed = true;
        }
      }
      return changed ? payload : undefined;
    };
  }
  if (params.model.api !== "openai-completions") {
    return undefined;
  }
  return (payload) => {
    if (!isRecord(payload)) {
      return undefined;
    }
    const next = {
      ...payload,
    };
    let changed = false;
    if (!("response_format" in next)) {
      next.response_format = { type: "json_object" };
      changed = true;
    }
    if (topP !== undefined && !("top_p" in next)) {
      next.top_p = topP;
      changed = true;
    }
    return changed ? next : undefined;
  };
}

export const buildSelfImprovementLocalOpenAiPayloadHint =
  buildSelfImprovementLocalReviewerPayloadHint;

function applyReview(params: {
  groups: readonly SelfImprovementRecommendationGroup[];
  text: string;
  now: number;
  profile: SelfImprovementModelProfile;
  attemptCount: number;
  preflightStatus?: SelfImprovementReviewPreflightStatus;
  preflightSource?: SelfImprovementReviewPreflightSource;
  preflightMs?: number;
  providerConfigured?: boolean;
  modelId?: string;
}): {
  groups: SelfImprovementRecommendationGroup[];
  groupsReviewed: number;
} | null {
  const payload = parseReviewPayload(params.text);
  if (!payload || !Array.isArray(payload.groups)) {
    return null;
  }
  const byId = new Map<string, RawReviewedGroup>();
  const outputGroups = payload.groups;
  const allowSingleGroupIdFallback = params.groups.length === 1 && outputGroups.length === 1;
  for (const entry of outputGroups) {
    const reviewed = normalizeReviewedGroup({
      entry,
      ...(allowSingleGroupIdFallback ? { fallbackGroupId: params.groups[0]?.id } : {}),
    });
    if (!reviewed) {
      continue;
    }
    byId.set(reviewed.groupId, reviewed);
  }
  if (byId.size === 0) {
    return null;
  }
  let groupsReviewed = 0;
  const groups = params.groups.map((group) => {
    const reviewed = byId.get(group.id);
    if (!reviewed) {
      return group;
    }
    const reviewedSummary =
      typeof reviewed.summary === "string" && reviewed.summary.trim()
        ? redactSelfImprovementLlmText(reviewed.summary, MAX_SUMMARY_CHARS)
        : "";
    const reviewedAction =
      typeof reviewed.recommendedAction === "string" && reviewed.recommendedAction.trim()
        ? redactSelfImprovementLlmText(reviewed.recommendedAction, MAX_ACTION_CHARS)
        : "";
    if (!reviewedSummary && !reviewedAction) {
      return group;
    }
    groupsReviewed += 1;
    const summary = reviewedSummary || group.analysis.summary;
    const recommendedAction = reinforceClosureRequirements({
      action: reviewedAction || group.recommendedAction,
      requiresTests: group.requiresTests,
      requiresApproval: group.requiresApproval,
    });
    const analysis: SelfImprovementRecommendationAnalysis = {
      mode: params.profile.mode,
      summary,
      generatedAt: params.now,
      confidence: normalizeConfidence(reviewed.confidence, group.analysis.confidence),
      ...(params.modelId ? { modelId: params.modelId } : {}),
      modelTier: params.profile.tier,
      promptVersion: LLM_PROMPT_VERSION,
      evidenceCount: group.analysis.evidenceCount,
      safetyNotes: normalizeSafetyNotes(reviewed.safetyNotes),
      schemaValidated: true,
      attemptCount: params.attemptCount,
      ...(params.preflightStatus ? { preflightStatus: params.preflightStatus } : {}),
      ...(params.preflightSource ? { preflightSource: params.preflightSource } : {}),
      ...(params.preflightMs !== undefined ? { preflightMs: params.preflightMs } : {}),
      ...(params.providerConfigured !== undefined
        ? { providerConfigured: params.providerConfigured }
        : {}),
      ...(params.profile.quantization ? { quantization: params.profile.quantization } : {}),
      ...(params.profile.parameters ? { parameters: params.profile.parameters } : {}),
      ...(params.profile.contextWindow ? { contextWindow: params.profile.contextWindow } : {}),
      ...(params.profile.escalationReason
        ? { escalationReason: params.profile.escalationReason }
        : {}),
    };
    return {
      ...group,
      recommendedAction,
      analysis,
    };
  });
  if (groupsReviewed === 0) {
    return null;
  }
  return { groups, groupsReviewed };
}

async function defaultCompletion(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelId?: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
  topP?: number;
  timeoutMs?: number;
  modelTier?: SelfImprovementReviewModelTier;
  local?: boolean;
}) {
  const { prepareSimpleCompletionModelForAgent, completeWithPreparedSimpleCompletionModel } =
    await import("../agents/simple-completion-runtime.js");
  const prepared = await prepareSimpleCompletionModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    modelRef: params.modelId,
    allowMissingApiKeyModes: ["aws-sdk"],
  });
  if ("error" in prepared) {
    throw new Error(prepared.error);
  }
  const reviewerPayloadHint = buildSelfImprovementLocalReviewerPayloadHint({
    local: params.local,
    model: prepared.model,
    topP: params.topP,
  });
  const signal =
    params.timeoutMs && params.timeoutMs > 0 ? AbortSignal.timeout(params.timeoutMs) : undefined;
  const result = await completeWithPreparedSimpleCompletionModel({
    cfg: params.cfg,
    model: prepared.model,
    auth: prepared.auth,
    context: {
      systemPrompt: params.systemPrompt,
      messages: [{ role: "user", content: params.userPrompt, timestamp: Date.now() }],
    },
    options: {
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      ...(signal ? { signal } : {}),
      ...(reviewerPayloadHint ? { onPayload: reviewerPayloadHint } : {}),
    },
  });
  const text = result.content
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
    .map((entry) => entry.text)
    .join("");
  return {
    text,
    provider: prepared.selection.provider,
    modelId: prepared.selection.modelId,
  };
}

function buildLocalHealthProbeUrl(params: {
  provider: string;
  api?: string;
  baseUrl?: string;
}): string | null {
  const baseUrl = params.baseUrl?.trim();
  if (!baseUrl) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const suffix = params.provider === "ollama" || params.api === "ollama" ? "/api/tags" : "/models";
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

function normalizeUrlHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.+$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeUrlHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    isLoopbackIpAddress(normalized)
  );
}

function isTrustedLocalModelHostname(hostname: string): boolean {
  const normalized = normalizeUrlHostname(hostname);
  return (
    !normalized.includes(".") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home.arpa") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".ts.net")
  );
}

function explainLocalModelBaseUrlBlock(params: {
  provider: string;
  baseUrl?: string;
  allowPrivateNetwork?: boolean;
}): string | undefined {
  const baseUrl = params.baseUrl?.trim();
  if (!baseUrl) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return `Local model preflight requires a valid http(s) baseUrl for models.providers.${params.provider}.`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Local model preflight requires an http(s) baseUrl for models.providers.${params.provider}.`;
  }
  const hostname = normalizeUrlHostname(parsed.hostname);
  if (isLoopbackHostname(hostname)) {
    return undefined;
  }
  if (isPrivateOrLoopbackIpAddress(hostname)) {
    return params.allowPrivateNetwork === true
      ? undefined
      : `Local model preflight for ${params.provider} points at private network host ${hostname}; set models.providers.${params.provider}.request.allowPrivateNetwork=true only for trusted self-hosted model endpoints.`;
  }
  if (isTrustedLocalModelHostname(hostname)) {
    return params.allowPrivateNetwork === true
      ? undefined
      : `Local model preflight for ${params.provider} points at local hostname ${hostname}; set models.providers.${params.provider}.request.allowPrivateNetwork=true only for trusted self-hosted model endpoints.`;
  }
  return `Local-first model preflight blocked ${params.provider} because baseUrl host ${hostname} is not a loopback, private-network, or trusted local model endpoint. Use hosted escalation gates for hosted providers.`;
}

function splitLocalModelRef(
  modelId: string | undefined,
): { provider: string; model: string } | null {
  const normalized = normalizeSelfImprovementModelId(modelId);
  if (!normalized) {
    return null;
  }
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator >= normalized.length - 1) {
    return null;
  }
  return {
    provider: normalized.slice(0, separator),
    model: normalized.slice(separator + 1),
  };
}

function configuredProviderHasModel(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  const providerCfg = params.cfg.models?.providers?.[params.provider];
  return Boolean(
    Array.isArray(providerCfg?.models) &&
    providerCfg.models.some((model) => model.id === params.model),
  );
}

function readStringHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string | null | undefined> | undefined {
  if (!headers) {
    return undefined;
  }
  const result: Record<string, string | null | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) {
      result[key] = null;
      continue;
    }
    result[key] = normalizeSecretInputString(value);
  }
  return result;
}

function collectModelCatalogIds(value: unknown, ids: Set<string>, depth = 0): void {
  if (depth > 4 || value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectModelCatalogIds(entry, ids, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of ["id", "name", "model"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      ids.add(candidate.trim());
    }
  }
  for (const key of ["data", "models"]) {
    collectModelCatalogIds(value[key], ids, depth + 1);
  }
}

async function responseCatalogContainsModel(
  response: Response,
  modelId: string | undefined,
): Promise<boolean | null> {
  const normalized = normalizeSelfImprovementModelId(modelId);
  if (!normalized || !response.ok) {
    return null;
  }
  try {
    const parsed: unknown = await response.clone().json();
    const ids = new Set<string>();
    collectModelCatalogIds(parsed, ids);
    if (ids.size === 0) {
      return false;
    }
    return ids.has(normalized);
  } catch {
    return null;
  }
}

async function probeLocalModelEndpoint(params: {
  provider: string;
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string | null | undefined>;
  modelId?: string;
}): Promise<LocalModelEndpointProbeResult> {
  if (typeof fetch !== "function") {
    return { ok: true, status: "skipped" };
  }
  const url = buildLocalHealthProbeUrl(params);
  if (!url) {
    return { ok: true, status: "skipped" };
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.headers ?? {})) {
    if (typeof value === "string" && value.trim()) {
      headers[key] = value;
    }
  }
  const hasAuthorizationHeader = Object.keys(headers).some(
    (key) => key.toLowerCase() === "authorization",
  );
  const authorizationDisabled = Object.entries(params.headers ?? {}).some(
    ([key, value]) => key.toLowerCase() === "authorization" && value === null,
  );
  if (params.apiKey?.trim() && !hasAuthorizationHeader && !authorizationDisabled) {
    headers.Authorization = `Bearer ${params.apiKey.trim()}`;
  }
  const cacheKey = buildLocalModelHealthFailureCacheKey({
    api: params.api,
    url,
    modelId: params.modelId,
    headers: params.headers,
    hasApiKey: Boolean(params.apiKey?.trim()),
  });
  const cached = localModelHealthFailureCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < LOCAL_MODEL_HEALTH_FAILURE_CACHE_TTL_MS) {
    return { ...cached.result };
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(LOCAL_MODEL_HEALTH_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return cacheLocalModelEndpointFailure(cacheKey, {
        ok: false,
        status: "missing_config",
        reason: `Local model preflight reached ${params.provider} but authentication was rejected.`,
      });
    }
    if (response.status >= 500) {
      return cacheLocalModelEndpointFailure(cacheKey, {
        ok: false,
        status: "unavailable",
        reason: `Local model preflight reached ${params.provider} but the provider returned HTTP ${response.status}.`,
      });
    }
    if (!response.ok) {
      return cacheLocalModelEndpointFailure(cacheKey, {
        ok: false,
        status: "unavailable",
        reason: `Local model preflight reached ${params.provider} but the provider returned HTTP ${response.status}.`,
      });
    }
    const catalogHasModel = await responseCatalogContainsModel(response, params.modelId);
    if (catalogHasModel === false) {
      return cacheLocalModelEndpointFailure(cacheKey, {
        ok: false,
        status: "missing_config",
        reason: `Local model preflight reached ${params.provider}, but ${params.modelId} was not listed by the provider.`,
      });
    }
    if (catalogHasModel === null && normalizeSelfImprovementModelId(params.modelId)) {
      return cacheLocalModelEndpointFailure(cacheKey, {
        ok: false,
        status: "unavailable",
        reason: `Local model preflight reached ${params.provider}, but the provider catalog did not prove ${params.modelId} is available.`,
      });
    }
    localModelHealthFailureCache.delete(cacheKey);
    return { ok: true };
  } catch (error) {
    return cacheLocalModelEndpointFailure(cacheKey, {
      ok: false,
      status: "unavailable",
      reason: `Local model preflight could not reach ${params.provider}: ${formatBoundedReviewError(
        error,
      )}`,
    });
  }
}

function buildLocalModelHealthFailureCacheKey(params: {
  api?: string;
  url: string;
  modelId?: string;
  headers?: Record<string, string | null | undefined>;
  hasApiKey: boolean;
}): string {
  const headerShape = Object.entries(params.headers ?? {})
    .map(([key, value]) => `${key.toLowerCase()}:${value === null ? "null" : "set"}`)
    .toSorted()
    .join(",");
  return [
    params.api ?? "",
    params.url,
    normalizeSelfImprovementModelId(params.modelId) ?? "",
    params.hasApiKey ? "api-key" : "no-api-key",
    headerShape,
  ].join("\0");
}

function cacheLocalModelEndpointFailure<
  T extends Extract<LocalModelEndpointProbeResult, { ok: false }>,
>(cacheKey: string, result: T): T {
  localModelHealthFailureCache.set(cacheKey, {
    checkedAt: Date.now(),
    result: { ...result },
  });
  return result;
}

export function resetSelfImprovementLlmReviewerPreflightCacheForTest(): void {
  localModelHealthFailureCache.clear();
}

async function defaultPreflight(
  params: Parameters<SelfImprovementLlmReviewerPreflight>[0],
): Promise<SelfImprovementLlmReviewerPreflightResult> {
  const startedAt = Date.now();
  if (!params.local) {
    return {
      ok: true,
      status: "not_required",
      elapsedMs: elapsedSince(startedAt),
      preflightSource: "not_required",
      providerConfigured: true,
    };
  }
  const ref = splitLocalModelRef(params.modelId);
  if (!ref) {
    return {
      ok: false,
      status: "missing_config",
      elapsedMs: elapsedSince(startedAt),
      reason:
        "Local model preflight requires an explicit local model ref formatted as provider/model.",
      providerConfigured: false,
    };
  }
  const providerCfg = params.cfg.models?.providers?.[ref.provider];
  if (!providerCfg && ref.provider !== "ollama") {
    return {
      ok: false,
      status: "missing_config",
      elapsedMs: elapsedSince(startedAt),
      reason: `Local model preflight could not find models.providers.${ref.provider}.`,
      providerConfigured: false,
    };
  }
  if (providerCfg && !configuredProviderHasModel({ cfg: params.cfg, ...ref })) {
    return {
      ok: false,
      status: "missing_config",
      elapsedMs: elapsedSince(startedAt),
      reason: `Local model preflight could not find ${ref.model} in models.providers.${ref.provider}.models.`,
      preflightSource: "configured_provider",
      providerConfigured: true,
    };
  }
  const providerConfigured = Boolean(providerCfg);
  const preflightSource: SelfImprovementReviewPreflightSource = providerConfigured
    ? "configured_provider"
    : "default_ollama";
  const baseUrl =
    providerCfg?.baseUrl ?? (ref.provider === "ollama" ? "http://127.0.0.1:11434" : "");
  const localBaseUrlBlockReason = explainLocalModelBaseUrlBlock({
    provider: ref.provider,
    baseUrl,
    allowPrivateNetwork: providerCfg?.request?.allowPrivateNetwork,
  });
  if (localBaseUrlBlockReason) {
    return {
      ok: false,
      status: "missing_config",
      elapsedMs: elapsedSince(startedAt),
      reason: localBaseUrlBlockReason,
      preflightSource,
      providerConfigured,
    };
  }
  const health = await probeLocalModelEndpoint({
    provider: ref.provider,
    api: providerCfg?.api,
    baseUrl,
    apiKey: normalizeSecretInputString(providerCfg?.apiKey),
    headers: readStringHeaders(providerCfg?.headers),
    modelId: ref.model,
  });
  if (!health.ok) {
    return {
      ok: false,
      status: health.status === "missing_config" ? "missing_config" : "unavailable",
      elapsedMs: elapsedSince(startedAt),
      reason: health.reason,
      preflightSource,
      providerConfigured,
    };
  }
  if (health.status === "skipped") {
    return {
      ok: false,
      status: "unavailable",
      elapsedMs: elapsedSince(startedAt),
      reason:
        "Local model preflight found configuration, but no HTTP health endpoint was available to prove it is responsive.",
      preflightSource,
      providerConfigured,
    };
  }
  return {
    ok: true,
    status: "passed",
    elapsedMs: elapsedSince(startedAt),
    preflightSource,
    providerConfigured,
  };
}

function buildAttemptRecord(params: {
  attempt: number;
  profile: SelfImprovementModelProfile;
  status: SelfImprovementReviewAttempt["status"];
  schemaValidated: boolean;
  groupsReviewed?: number;
  preflightStatus?: SelfImprovementReviewPreflightStatus;
  preflightSource?: SelfImprovementReviewPreflightSource;
  preflightMs?: number;
  providerConfigured?: boolean;
  completionMs?: number;
  diagnostic?: SelfImprovementReviewAttemptDiagnostic;
  error?: string;
}): SelfImprovementReviewAttempt {
  const error = params.error ? redactSelfImprovementLlmText(params.error, 420) : undefined;
  const remediationHint = buildAttemptRemediationHint({
    profile: params.profile,
    status: params.status,
    error,
  });
  return {
    attempt: params.attempt,
    tier: params.profile.tier,
    modelId: params.profile.modelId,
    status: params.status,
    local: params.profile.local,
    schemaValidated: params.schemaValidated,
    groupsReviewed: params.groupsReviewed ?? 0,
    ...(params.profile.quantization ? { quantization: params.profile.quantization } : {}),
    ...(params.profile.parameters ? { parameters: params.profile.parameters } : {}),
    ...(params.profile.contextWindow ? { contextWindow: params.profile.contextWindow } : {}),
    maxOutputTokens: params.profile.maxOutputTokens,
    temperature: params.profile.temperature,
    ...(params.profile.topP !== undefined ? { topP: params.profile.topP } : {}),
    timeoutMs: params.profile.timeoutMs,
    ...(params.preflightStatus ? { preflightStatus: params.preflightStatus } : {}),
    ...(params.preflightSource ? { preflightSource: params.preflightSource } : {}),
    ...(params.preflightMs !== undefined ? { preflightMs: params.preflightMs } : {}),
    ...(params.providerConfigured !== undefined
      ? { providerConfigured: params.providerConfigured }
      : {}),
    ...(params.completionMs !== undefined ? { completionMs: params.completionMs } : {}),
    ...(params.profile.backend ? { backend: params.profile.backend } : {}),
    ...(params.profile.fallbackBackend ? { fallbackBackend: params.profile.fallbackBackend } : {}),
    ...(params.profile.escalationReason
      ? { escalationReason: params.profile.escalationReason }
      : {}),
    ...(params.diagnostic ? { diagnostic: params.diagnostic } : {}),
    ...(error ? { error } : {}),
    ...(remediationHint ? { remediationHint } : {}),
  };
}

function buildAttemptRemediationHint(params: {
  profile: SelfImprovementModelProfile;
  status: SelfImprovementReviewAttempt["status"];
  error?: string;
}): string | undefined {
  const error = params.error?.toLowerCase() ?? "";
  const modelId = params.profile.modelId;
  if (!params.error && params.status === "success") {
    return undefined;
  }
  if (params.profile.tier === "hostedEscalation") {
    return "Hosted review remains blocked until allow-hosted-escalation, per-run approval, and OPENCLAW_SELF_IMPROVEMENT_LLM=1 are all present.";
  }
  if (params.status === "invalid_json") {
    return "Keep deterministic fallback unless the reviewer can return schema-valid JSON; use the Qwen cross-check path for schema repair.";
  }
  if (error.includes("authentication was rejected")) {
    return "Check the local provider API key or Authorization header, then rerun the preflight command.";
  }
  if (error.includes("not listed by the provider") || error.includes("catalog did not prove")) {
    return "Serve and register the selected model id exactly as the provider catalog reports it, then rerun preflight.";
  }
  if (error.includes("could not reach") || error.includes("http ")) {
    return "Start the local model server or fix the provider baseUrl before rerunning preflight.";
  }
  if (error.includes("private network host") || error.includes("local hostname")) {
    return "Set request.allowPrivateNetwork=true only for a trusted self-hosted model endpoint, then rerun preflight.";
  }
  if (error.includes("models.providers.kimi-local")) {
    return "Kimi is optional external-GPU guidance only; use the default local Ollama reviewer or explicitly register kimi-local before selecting it.";
  }
  if (error.includes("models.providers.deepseek-local")) {
    return "DeepSeek is optional external-GPU guidance only; use the default strategic local model or explicitly register deepseek-local before selecting it.";
  }
  if (modelId.startsWith("ollama/") || error.includes("ollama")) {
    return "Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.";
  }
  return undefined;
}

function canRunHostedReview(params: {
  allowHostedEscalation?: boolean;
  approved?: boolean;
  env?: NodeJS.ProcessEnv;
}): { allowed: true } | { allowed: false; reason: string } {
  if (!params.allowHostedEscalation) {
    return {
      allowed: false,
      reason: "Hosted LLM review requires explicit hosted escalation allowance.",
    };
  }
  if (!params.approved) {
    return {
      allowed: false,
      reason: "Hosted LLM review requires explicit per-run approval.",
    };
  }
  if (!isSelfImprovementLlmReviewEnabled(params.env)) {
    return {
      allowed: false,
      reason: "Hosted LLM review is not enabled. Set OPENCLAW_SELF_IMPROVEMENT_LLM=1 to allow it.",
    };
  }
  return { allowed: true };
}

function localFirstAttemptBlockReason(params: {
  policy: SelfImprovementReviewPolicy;
  profile: SelfImprovementModelProfile;
}): string | undefined {
  if (
    params.policy !== "local_first" ||
    params.profile.local ||
    params.profile.tier === "hostedEscalation"
  ) {
    return undefined;
  }
  return `Local-first ${params.profile.tier} review model ${params.profile.modelId} must be local. Use --model with --allow-hosted-escalation, --approve-llm-review, and OPENCLAW_SELF_IMPROVEMENT_LLM=1 for hosted review.`;
}

export function summarizeSelfImprovementReviewPreflightAttempts(
  attempts: readonly SelfImprovementReviewAttempt[],
): Pick<SelfImprovementModelPreflightResult, "preflightStatus" | "preflightMs"> {
  const statuses = attempts
    .map((attempt) => attempt.preflightStatus)
    .filter((status): status is NonNullable<typeof status> => Boolean(status));
  if (statuses.length === 0) {
    return {};
  }
  const preflightStatus = statuses.includes("unavailable")
    ? "unavailable"
    : statuses.includes("missing_config")
      ? "missing_config"
      : statuses.includes("passed")
        ? "passed"
        : statuses.includes("skipped")
          ? "skipped"
          : "not_required";
  const preflightMs = attempts.reduce((total, attempt) => total + (attempt.preflightMs ?? 0), 0);
  return {
    preflightStatus,
    ...(preflightMs > 0 ? { preflightMs } : {}),
  };
}

function isSelfImprovementAttemptModelReady(attempt: SelfImprovementReviewAttempt): boolean {
  if (attempt.status === "success") {
    return true;
  }
  if (
    attempt.status === "invalid_json" &&
    (attempt.preflightStatus === "passed" || attempt.preflightStatus === "not_required")
  ) {
    return true;
  }
  return false;
}

export function summarizeSelfImprovementModelReadiness(
  attempts: readonly SelfImprovementReviewAttempt[],
): Pick<
  SelfImprovementModelPreflightResult,
  "ready" | "readiness" | "readyTier" | "readyModelId" | "blockedPrimaryReason"
> {
  if (attempts.length === 0) {
    return {
      ready: true,
      readiness: "ready",
    };
  }
  const readyAttempt = attempts.find(isSelfImprovementAttemptModelReady);
  const blockedPrimaryAttempt = attempts.find(
    (attempt) =>
      attempt.error &&
      !isSelfImprovementAttemptModelReady(attempt) &&
      (attempt.tier === "primaryReview" || attempt.tier === "strategic"),
  );
  if (!readyAttempt) {
    return {
      ready: false,
      readiness: "blocked",
      ...(blockedPrimaryAttempt?.error
        ? { blockedPrimaryReason: blockedPrimaryAttempt.error }
        : {}),
    };
  }
  const hasUnreadyAttempt = attempts.some(
    (attempt) => !isSelfImprovementAttemptModelReady(attempt),
  );
  const readiness: SelfImprovementModelReadiness = hasUnreadyAttempt ? "degraded" : "ready";
  return {
    ready: true,
    readiness,
    readyTier: readyAttempt.tier,
    readyModelId: readyAttempt.modelId,
    ...(blockedPrimaryAttempt?.error ? { blockedPrimaryReason: blockedPrimaryAttempt.error } : {}),
  };
}

function buildPreflightSelectionGroups(
  strategic: boolean | undefined,
): Pick<SelfImprovementRecommendationGroup, "category" | "criticality" | "priority">[] {
  return strategic
    ? [{ category: "major_change", criticality: "critical", priority: "critical" }]
    : [];
}

export async function preflightSelfImprovementReviewModels(params: {
  cfg?: OpenClawConfig;
  checkedAt?: number;
  requested?: boolean;
  approved?: boolean;
  modelId?: string;
  reviewModelId?: string;
  fallbackModelId?: string;
  strategicModelId?: string;
  localFirst?: boolean;
  allowStrategicLocal?: boolean;
  allowHostedEscalation?: boolean;
  strategic?: boolean;
  reviewerAgentId?: string;
  env?: NodeJS.ProcessEnv;
  preflight?: SelfImprovementLlmReviewerPreflight;
}): Promise<SelfImprovementModelPreflightResult> {
  const checkedAt = params.checkedAt ?? Date.now();
  const localFirst = params.localFirst === true;
  const plan = selectSelfImprovementReviewModelPlan({
    requested: params.requested === true,
    approved: params.approved,
    localFirst,
    modelId: params.modelId,
    reviewModelId: params.reviewModelId,
    fallbackModelId: params.fallbackModelId,
    strategicModelId: params.strategicModelId,
    allowStrategicLocal: params.allowStrategicLocal,
    allowHostedEscalation: params.allowHostedEscalation,
    groups: buildPreflightSelectionGroups(params.strategic),
  });
  const common = {
    checkedAt,
    reviewPolicy: plan.policy,
    ...(plan.reviewModelId ? { reviewModelId: plan.reviewModelId } : {}),
    ...(plan.fallbackModelId ? { fallbackModelId: plan.fallbackModelId } : {}),
    ...(plan.strategicModelId ? { strategicModelId: plan.strategicModelId } : {}),
    ...(plan.hostedModelId ? { hostedModelId: plan.hostedModelId } : {}),
    localFirst,
    hostedEscalationAllowed: params.allowHostedEscalation === true,
    strategicLocalAllowed: params.allowStrategicLocal === true,
    strategicRequested: params.strategic === true,
    schemaValidated: false as const,
    ...(plan.escalationReason ? { escalationReason: plan.escalationReason } : {}),
  };
  if (plan.policy === "deterministic") {
    return {
      ...common,
      ready: true,
      readiness: "ready",
      attempts: [],
      preflightStatus: "not_required",
    };
  }
  if (!params.cfg) {
    const attempts = plan.attempts.map((profile, index) =>
      buildAttemptRecord({
        attempt: index + 1,
        profile,
        status: "blocked",
        schemaValidated: false,
        error: "Runtime configuration is unavailable.",
      }),
    );
    return {
      ...common,
      ready: false,
      readiness: "blocked",
      attempts,
      fallbackReason: "Model preflight needs runtime configuration.",
    };
  }
  const preflight = params.preflight ?? defaultPreflight;
  const agentId = params.reviewerAgentId?.trim() || DEFAULT_REVIEWER_AGENT_ID;
  const attempts: SelfImprovementReviewAttempt[] = [];
  for (const [index, profile] of plan.attempts.entries()) {
    const localFirstBlockReason = localFirstAttemptBlockReason({
      policy: plan.policy,
      profile,
    });
    if (localFirstBlockReason) {
      attempts.push(
        buildAttemptRecord({
          attempt: index + 1,
          profile,
          status: "blocked",
          schemaValidated: false,
          error: localFirstBlockReason,
        }),
      );
      continue;
    }
    if (profile.tier === "hostedEscalation") {
      const gate = canRunHostedReview({
        allowHostedEscalation: params.allowHostedEscalation,
        approved: params.approved,
        env: params.env,
      });
      if (!gate.allowed) {
        attempts.push(
          buildAttemptRecord({
            attempt: index + 1,
            profile,
            status: "blocked",
            schemaValidated: false,
            error: gate.reason,
          }),
        );
        continue;
      }
    }
    const preflightResult = await preflight({
      cfg: params.cfg,
      agentId,
      modelId: profile.modelId,
      modelTier: profile.tier,
      local: profile.local,
      timeoutMs: LOCAL_MODEL_HEALTH_TIMEOUT_MS,
    });
    attempts.push(
      buildAttemptRecord({
        attempt: index + 1,
        profile,
        status: preflightResult.ok ? "success" : "blocked",
        schemaValidated: false,
        preflightStatus: preflightResult.status,
        preflightSource: preflightResult.preflightSource,
        preflightMs: preflightResult.elapsedMs,
        providerConfigured: preflightResult.providerConfigured,
        ...(preflightResult.ok ? {} : { error: preflightResult.reason }),
      }),
    );
  }
  const readinessSummary = summarizeSelfImprovementModelReadiness(attempts);
  const preflightSummary = summarizeSelfImprovementReviewPreflightAttempts(attempts);
  const lastBlocked = attempts
    .filter((attempt) => attempt.status === "blocked" && attempt.error)
    .at(-1);
  return {
    ...common,
    ...readinessSummary,
    attempts,
    ...preflightSummary,
    ...(!readinessSummary.ready && lastBlocked?.error ? { fallbackReason: lastBlocked.error } : {}),
  };
}

export async function reviewSelfImprovementGroupsWithLlm(params: {
  cfg?: OpenClawConfig;
  groups: readonly SelfImprovementRecommendationGroup[];
  requested: boolean;
  approved?: boolean;
  modelId?: string;
  reviewModelId?: string;
  fallbackModelId?: string;
  strategicModelId?: string;
  localFirst?: boolean;
  allowStrategicLocal?: boolean;
  allowHostedEscalation?: boolean;
  reviewerAgentId?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  completion?: SelfImprovementLlmReviewerCompletion;
  preflight?: SelfImprovementLlmReviewerPreflight;
}): Promise<SelfImprovementLlmReviewResult> {
  const plan = selectSelfImprovementReviewModelPlan({
    requested: params.requested,
    approved: params.approved,
    localFirst: params.localFirst,
    modelId: params.modelId,
    reviewModelId: params.reviewModelId,
    fallbackModelId: params.fallbackModelId,
    strategicModelId: params.strategicModelId,
    allowStrategicLocal: params.allowStrategicLocal,
    allowHostedEscalation: params.allowHostedEscalation,
    groups: params.groups,
  });
  if (plan.policy === "deterministic") {
    return {
      groups: [...params.groups],
      status: {
        mode: "disabled",
        reason: "LLM review was not requested.",
        reviewPolicy: "deterministic",
        attempts: [],
        schemaValidated: false,
        groupsReviewedByLocalLlm: 0,
      },
    };
  }
  if (plan.policy === "hosted") {
    const gate = canRunHostedReview({
      allowHostedEscalation: params.allowHostedEscalation,
      approved: params.approved,
      env: params.env,
    });
    if (!gate.allowed) {
      const profile = plan.attempts[0];
      const attempts = profile
        ? [
            buildAttemptRecord({
              attempt: 1,
              profile,
              status: "blocked",
              schemaValidated: false,
              error: gate.reason,
            }),
          ]
        : [];
      return {
        groups: [...params.groups],
        status: {
          mode: "fallback",
          reason: gate.reason,
          reviewPolicy: plan.policy,
          attempts,
          schemaValidated: false,
          groupsReviewedByLocalLlm: 0,
          ...(profile ? { modelTier: profile.tier, modelId: profile.modelId } : {}),
          ...(plan.hostedModelId ? { reviewModelId: plan.hostedModelId } : {}),
          ...(plan.escalationReason ? { escalationReason: plan.escalationReason } : {}),
        },
      };
    }
  }
  if (!params.cfg) {
    return {
      groups: [...params.groups],
      status: {
        mode: "fallback",
        reason: "LLM review needs runtime configuration for model routing.",
        reviewPolicy: plan.policy,
        attempts: plan.attempts.map((profile, index) =>
          buildAttemptRecord({
            attempt: index + 1,
            profile,
            status: "blocked",
            schemaValidated: false,
            error: "Runtime configuration is unavailable.",
          }),
        ),
        schemaValidated: false,
        groupsReviewedByLocalLlm: 0,
        ...(plan.reviewModelId ? { reviewModelId: plan.reviewModelId } : {}),
        ...(plan.fallbackModelId ? { fallbackModelId: plan.fallbackModelId } : {}),
        ...(plan.strategicModelId ? { strategicModelId: plan.strategicModelId } : {}),
        ...(plan.escalationReason ? { escalationReason: plan.escalationReason } : {}),
      },
    };
  }
  if (params.groups.length === 0) {
    return {
      groups: [],
      status: {
        mode: "disabled",
        reason: "No grouped self-improvement recommendations were available for model review.",
        reviewPolicy: plan.policy,
        attempts: [],
        schemaValidated: false,
        groupsReviewedByLocalLlm: 0,
        ...(plan.reviewModelId ? { reviewModelId: plan.reviewModelId } : {}),
        ...(plan.fallbackModelId ? { fallbackModelId: plan.fallbackModelId } : {}),
        ...(plan.strategicModelId ? { strategicModelId: plan.strategicModelId } : {}),
        ...(plan.escalationReason ? { escalationReason: plan.escalationReason } : {}),
      },
    };
  }

  const now = params.now ?? Date.now();
  const agentId = params.reviewerAgentId?.trim() || DEFAULT_REVIEWER_AGENT_ID;
  const completion = params.completion ?? defaultCompletion;
  const preflight = params.preflight ?? defaultPreflight;
  const attempts: SelfImprovementReviewAttempt[] = [];
  for (const [index, profile] of plan.attempts.entries()) {
    const localFirstBlockReason = localFirstAttemptBlockReason({
      policy: plan.policy,
      profile,
    });
    if (localFirstBlockReason) {
      attempts.push(
        buildAttemptRecord({
          attempt: index + 1,
          profile,
          status: "blocked",
          schemaValidated: false,
          error: localFirstBlockReason,
        }),
      );
      continue;
    }
    if (profile.tier === "hostedEscalation") {
      const gate = canRunHostedReview({
        allowHostedEscalation: params.allowHostedEscalation,
        approved: params.approved,
        env: params.env,
      });
      if (!gate.allowed) {
        attempts.push(
          buildAttemptRecord({
            attempt: index + 1,
            profile,
            status: "blocked",
            schemaValidated: false,
            error: gate.reason,
          }),
        );
        continue;
      }
    }
    const preflightResult = await preflight({
      cfg: params.cfg,
      agentId,
      modelId: profile.modelId,
      modelTier: profile.tier,
      local: profile.local,
      timeoutMs: LOCAL_MODEL_HEALTH_TIMEOUT_MS,
    });
    if (!preflightResult.ok) {
      attempts.push(
        buildAttemptRecord({
          attempt: index + 1,
          profile,
          status: "blocked",
          schemaValidated: false,
          preflightStatus: preflightResult.status,
          preflightSource: preflightResult.preflightSource,
          preflightMs: preflightResult.elapsedMs,
          providerConfigured: preflightResult.providerConfigured,
          error: preflightResult.reason,
        }),
      );
      continue;
    }
    const completionStartedAt = Date.now();
    const result = await completion({
      cfg: params.cfg,
      agentId,
      modelId: profile.modelId,
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt(params.groups),
      maxTokens: profile.maxOutputTokens,
      temperature: profile.temperature,
      ...(profile.topP !== undefined ? { topP: profile.topP } : {}),
      timeoutMs: profile.timeoutMs,
      modelTier: profile.tier,
      local: profile.local,
    }).catch((error: unknown) => ({ error }));
    const completionMs = elapsedSince(completionStartedAt);
    if ("error" in result) {
      attempts.push(
        buildAttemptRecord({
          attempt: index + 1,
          profile,
          status: "failed",
          schemaValidated: false,
          preflightStatus: preflightResult.status,
          preflightSource: preflightResult.preflightSource,
          preflightMs: preflightResult.elapsedMs,
          providerConfigured: preflightResult.providerConfigured,
          completionMs,
          error: formatBoundedReviewError(result.error),
        }),
      );
      continue;
    }
    const effectiveModelId = normalizeSelfImprovementModelId(result.modelId) ?? profile.modelId;
    const reviewed = applyReview({
      groups: params.groups,
      text: result.text,
      now,
      profile,
      attemptCount: index + 1,
      preflightStatus: preflightResult.status,
      preflightSource: preflightResult.preflightSource,
      preflightMs: preflightResult.elapsedMs,
      providerConfigured: preflightResult.providerConfigured,
      modelId: effectiveModelId,
    });
    if (!reviewed) {
      const diagnostic = diagnoseReviewPayloadFailure({
        text: result.text,
        groups: params.groups,
      });
      attempts.push(
        buildAttemptRecord({
          attempt: index + 1,
          profile,
          status: "invalid_json",
          schemaValidated: false,
          preflightStatus: preflightResult.status,
          preflightSource: preflightResult.preflightSource,
          preflightMs: preflightResult.elapsedMs,
          providerConfigured: preflightResult.providerConfigured,
          completionMs,
          diagnostic: diagnostic.code,
          error: buildInvalidReviewError({ diagnostic }),
        }),
      );
      continue;
    }
    attempts.push(
      buildAttemptRecord({
        attempt: index + 1,
        profile,
        status: "success",
        schemaValidated: true,
        groupsReviewed: reviewed.groupsReviewed,
        preflightStatus: preflightResult.status,
        preflightSource: preflightResult.preflightSource,
        preflightMs: preflightResult.elapsedMs,
        providerConfigured: preflightResult.providerConfigured,
        completionMs,
      }),
    );
    return {
      groups: reviewed.groups,
      status: {
        mode: profile.mode,
        groupsReviewed: reviewed.groupsReviewed,
        modelId: effectiveModelId,
        modelTier: profile.tier,
        reviewPolicy: plan.policy,
        attempts,
        schemaValidated: true,
        groupsReviewedByLocalLlm: profile.local ? reviewed.groupsReviewed : 0,
        ...(plan.reviewModelId ? { reviewModelId: plan.reviewModelId } : {}),
        ...(plan.fallbackModelId ? { fallbackModelId: plan.fallbackModelId } : {}),
        ...(plan.strategicModelId ? { strategicModelId: plan.strategicModelId } : {}),
        ...(profile.escalationReason ? { escalationReason: profile.escalationReason } : {}),
      },
    };
  }
  const lastAttempt = attempts.at(-1);
  const fallbackReason =
    lastAttempt?.status === "blocked" && lastAttempt.error
      ? lastAttempt.error
      : attempts.some((attempt) => attempt.status === "invalid_json")
        ? "LLM review returned invalid JSON after retry; deterministic analysis was retained."
        : attempts.some((attempt) => attempt.status === "failed")
          ? `LLM review failed: ${attempts
              .filter((attempt) => attempt.status === "failed" && attempt.error)
              .map((attempt) => attempt.error)
              .at(-1)}`
          : "LLM review did not return a schema-valid result; deterministic analysis was retained.";
  return {
    groups: [...params.groups],
    status: {
      mode: "fallback",
      reason: fallbackReason,
      reviewPolicy: plan.policy,
      attempts,
      schemaValidated: false,
      groupsReviewedByLocalLlm: attempts
        .filter((attempt) => attempt.local)
        .reduce((total, attempt) => total + attempt.groupsReviewed, 0),
      ...(lastAttempt ? { modelTier: lastAttempt.tier, modelId: lastAttempt.modelId } : {}),
      ...(plan.reviewModelId ? { reviewModelId: plan.reviewModelId } : {}),
      ...(plan.fallbackModelId ? { fallbackModelId: plan.fallbackModelId } : {}),
      ...(plan.strategicModelId ? { strategicModelId: plan.strategicModelId } : {}),
      ...(plan.escalationReason ? { escalationReason: plan.escalationReason } : {}),
    },
  };
}
