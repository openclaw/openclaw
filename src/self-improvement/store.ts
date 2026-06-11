import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { deriveSelfImprovementGroupKey } from "./summary.js";
import { sanitizeRecommendationText, sanitizeRecommendationTexts } from "./text.js";
import type {
  SelfImprovementRecommendation,
  SelfImprovementRecommendationAnalysis,
  SelfImprovementRecommendationEffort,
  SelfImprovementRecommendationImpact,
  SelfImprovementRecommendationSeverity,
  SelfImprovementRecommendationStatus,
  SelfImprovementRecommendationStoreFile,
} from "./types.js";

const STORE_VERSION = 2;
const STORE_DIR = "self-improvement";
const STORE_FILENAME = "recommendations.json";

function cloneRecommendation(
  recommendation: SelfImprovementRecommendation,
): SelfImprovementRecommendation {
  return structuredClone(recommendation);
}

function cloneStore(
  file: SelfImprovementRecommendationStoreFile,
): SelfImprovementRecommendationStoreFile {
  return {
    version: STORE_VERSION,
    recommendations: file.recommendations.map(cloneRecommendation),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStatus(value: unknown): value is SelfImprovementRecommendationStatus {
  return (
    value === "open" ||
    value === "acknowledged" ||
    value === "assigned" ||
    value === "in_progress" ||
    value === "reopened" ||
    value === "quarantined" ||
    value === "resolved" ||
    value === "dismissed"
  );
}

function isSeverity(value: unknown): value is SelfImprovementRecommendationSeverity {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function isImpact(value: unknown): value is SelfImprovementRecommendationImpact {
  return value === "high" || value === "medium" || value === "low";
}

function isEffort(value: unknown): value is SelfImprovementRecommendationEffort {
  return value === "small" || value === "medium" || value === "large";
}

function defaultImpact(
  severity: SelfImprovementRecommendationSeverity,
): SelfImprovementRecommendationImpact {
  return severity === "critical" || severity === "high" ? "high" : "medium";
}

function defaultEffort(category: unknown): SelfImprovementRecommendationEffort {
  return category === "knowledge_hygiene" ||
    category === "instruction_adherence" ||
    category === "outcome_measurement"
    ? "small"
    : category === "major_change" ||
        category === "architecture_simplification" ||
        category === "capability_evolution"
      ? "large"
      : "medium";
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function isAnalysisMode(value: unknown): value is SelfImprovementRecommendationAnalysis["mode"] {
  return (
    value === "deterministic" ||
    value === "llm" ||
    value === "local_llm" ||
    value === "local_retry" ||
    value === "local_crosscheck" ||
    value === "strategic_local" ||
    value === "hosted_escalation"
  );
}

function isReviewModelTier(
  value: unknown,
): value is NonNullable<SelfImprovementRecommendationAnalysis["modelTier"]> {
  return (
    value === "triage" ||
    value === "primaryReview" ||
    value === "crossCheck" ||
    value === "strategic" ||
    value === "hostedEscalation"
  );
}

function isPreflightStatus(
  value: unknown,
): value is NonNullable<SelfImprovementRecommendationAnalysis["preflightStatus"]> {
  return (
    value === "not_required" ||
    value === "passed" ||
    value === "missing_config" ||
    value === "unavailable" ||
    value === "skipped"
  );
}

function normalizeAnalysis(
  value: unknown,
  fallback: {
    title: string;
    confidence: number;
    evidenceCount: number;
    generatedAt: number;
  },
): SelfImprovementRecommendationAnalysis {
  if (isRecord(value)) {
    const mode = isAnalysisMode(value.mode) ? value.mode : "deterministic";
    const summary = typeof value.summary === "string" ? value.summary : "";
    const generatedAt =
      typeof value.generatedAt === "number" && Number.isFinite(value.generatedAt)
        ? Math.max(0, Math.floor(value.generatedAt))
        : fallback.generatedAt;
    const confidence =
      typeof value.confidence === "number" && Number.isFinite(value.confidence)
        ? Math.min(1, Math.max(0, value.confidence))
        : fallback.confidence;
    return {
      mode,
      summary: sanitizeRecommendationText(
        summary || `Evidence-bound recommendation analysis for ${fallback.title}.`,
        640,
      ),
      generatedAt,
      confidence,
      ...(typeof value.modelId === "string"
        ? { modelId: sanitizeRecommendationText(value.modelId, 180) }
        : {}),
      ...(isReviewModelTier(value.modelTier) ? { modelTier: value.modelTier } : {}),
      ...(typeof value.promptVersion === "string"
        ? { promptVersion: sanitizeRecommendationText(value.promptVersion, 120) }
        : { promptVersion: "self-improvement-deterministic-v1" }),
      evidenceCount:
        typeof value.evidenceCount === "number" && Number.isFinite(value.evidenceCount)
          ? Math.max(0, Math.floor(value.evidenceCount))
          : fallback.evidenceCount,
      safetyNotes: sanitizeRecommendationTexts(normalizeStringArray(value.safetyNotes), 240),
      ...(typeof value.schemaValidated === "boolean"
        ? { schemaValidated: value.schemaValidated }
        : {}),
      ...(typeof value.attemptCount === "number" && Number.isFinite(value.attemptCount)
        ? { attemptCount: Math.max(0, Math.floor(value.attemptCount)) }
        : {}),
      ...(isPreflightStatus(value.preflightStatus)
        ? { preflightStatus: value.preflightStatus }
        : {}),
      ...(typeof value.preflightMs === "number" && Number.isFinite(value.preflightMs)
        ? { preflightMs: Math.max(0, Math.floor(value.preflightMs)) }
        : {}),
      ...(typeof value.quantization === "string"
        ? { quantization: sanitizeRecommendationText(value.quantization, 120) }
        : {}),
      ...(typeof value.parameters === "string"
        ? { parameters: sanitizeRecommendationText(value.parameters, 120) }
        : {}),
      ...(typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow)
        ? { contextWindow: Math.max(0, Math.floor(value.contextWindow)) }
        : {}),
      ...(typeof value.escalationReason === "string"
        ? { escalationReason: sanitizeRecommendationText(value.escalationReason, 240) }
        : {}),
    };
  }
  return {
    mode: "deterministic",
    summary: sanitizeRecommendationText(
      `Evidence-bound recommendation analysis for ${fallback.title}.`,
      640,
    ),
    generatedAt: fallback.generatedAt,
    confidence: fallback.confidence,
    promptVersion: "self-improvement-deterministic-v1",
    evidenceCount: fallback.evidenceCount,
    safetyNotes: ["Recommendation-only; no direct production mutation."],
  };
}

function parseRecommendation(value: unknown): SelfImprovementRecommendation | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id : "";
  const fingerprint = typeof value.fingerprint === "string" ? value.fingerprint : "";
  const status = isStatus(value.status) ? value.status : null;
  if (!id || !fingerprint || !status) {
    return null;
  }
  const entry = value as Partial<SelfImprovementRecommendation> & Record<string, unknown>;
  const title = sanitizeRecommendationText(
    typeof entry.title === "string" ? entry.title : "Self-improvement recommendation",
    180,
  );
  const severity = isSeverity(entry.severity) ? entry.severity : "medium";
  const createdAt =
    typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0;
  const updatedAt =
    typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : createdAt;
  const lastSeenAt =
    typeof entry.lastSeenAt === "number" && Number.isFinite(entry.lastSeenAt)
      ? entry.lastSeenAt
      : updatedAt;
  const evidence = sanitizeRecommendationTexts(normalizeStringArray(entry.evidence), 300);
  const source = entry.source as SelfImprovementRecommendation["source"];
  const route = entry.route as SelfImprovementRecommendation["route"];
  const recommendation: SelfImprovementRecommendation = {
    ...(entry as SelfImprovementRecommendation),
    id,
    fingerprint,
    createdAt,
    updatedAt,
    lastSeenAt,
    status,
    title,
    summary: sanitizeRecommendationText(
      typeof entry.summary === "string" ? entry.summary : "",
      640,
    ),
    category: entry.category as SelfImprovementRecommendation["category"],
    severity,
    criticality: isSeverity(entry.criticality) ? entry.criticality : severity,
    priority: isSeverity(entry.priority) ? entry.priority : severity,
    impact: isImpact(entry.impact) ? entry.impact : defaultImpact(severity),
    effort: isEffort(entry.effort) ? entry.effort : defaultEffort(entry.category),
    confidence:
      typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
        ? Math.min(1, Math.max(0, entry.confidence))
        : 0.8,
    groupKey: typeof entry.groupKey === "string" ? entry.groupKey : "",
    groupTitle: sanitizeRecommendationText(
      typeof entry.groupTitle === "string" ? entry.groupTitle : title,
      180,
    ),
    recurrenceCount:
      typeof entry.recurrenceCount === "number" && Number.isFinite(entry.recurrenceCount)
        ? Math.max(1, Math.floor(entry.recurrenceCount))
        : 1,
    source: {
      ...source,
      label: sanitizeRecommendationText(source?.label, 180),
    },
    route: {
      ...route,
      reason: sanitizeRecommendationText(route?.reason, 240),
    },
    ...(typeof entry.assignedTargetAgentId === "string"
      ? { assignedTargetAgentId: sanitizeRecommendationText(entry.assignedTargetAgentId, 120) }
      : {}),
    ...(typeof entry.claimedBy === "string"
      ? { claimedBy: sanitizeRecommendationText(entry.claimedBy, 120) }
      : {}),
    ...(typeof entry.lastRoutedAt === "number" && Number.isFinite(entry.lastRoutedAt)
      ? { lastRoutedAt: entry.lastRoutedAt }
      : {}),
    recommendedAction: sanitizeRecommendationText(
      typeof entry.recommendedAction === "string" ? entry.recommendedAction : "",
      640,
    ),
    requiredEvidence: sanitizeRecommendationTexts(
      normalizeStringArray(entry.requiredEvidence),
      220,
    ),
    safety: entry.safety as SelfImprovementRecommendation["safety"],
    analysis: normalizeAnalysis(entry.analysis, {
      title,
      confidence:
        typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
          ? Math.min(1, Math.max(0, entry.confidence))
          : 0.8,
      evidenceCount: evidence.length,
      generatedAt: updatedAt,
    }),
    ...(typeof entry.resolutionProof === "string"
      ? { resolutionProof: sanitizeRecommendationText(entry.resolutionProof, 640) }
      : {}),
    ...(typeof entry.dismissalReason === "string"
      ? { dismissalReason: sanitizeRecommendationText(entry.dismissalReason, 360) }
      : {}),
    ...(typeof entry.reopenReason === "string"
      ? { reopenReason: sanitizeRecommendationText(entry.reopenReason, 360) }
      : {}),
    evidence,
  };
  recommendation.groupKey =
    recommendation.groupKey || deriveSelfImprovementGroupKey(recommendation);
  return recommendation;
}

function normalizeRecommendationForStore(
  recommendation: SelfImprovementRecommendation,
): SelfImprovementRecommendation {
  const normalized = parseRecommendation(recommendation);
  if (!normalized) {
    throw new Error("Invalid self-improvement recommendation.");
  }
  return normalized;
}

function normalizeStoreFile(value: unknown): SelfImprovementRecommendationStoreFile {
  if (!isRecord(value) || !Array.isArray(value.recommendations)) {
    return { version: STORE_VERSION, recommendations: [] };
  }
  return {
    version: STORE_VERSION,
    recommendations: value.recommendations
      .map(parseRecommendation)
      .filter((entry): entry is SelfImprovementRecommendation => Boolean(entry)),
  };
}

async function readStoreFile(storePath: string): Promise<SelfImprovementRecommendationStoreFile> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return normalizeStoreFile(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, recommendations: [] };
    }
    throw error;
  }
}

async function writeStoreFile(
  storePath: string,
  file: SelfImprovementRecommendationStoreFile,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, storePath);
}

export function resolveSelfImprovementRecommendationStorePath(
  stateDir = resolveStateDir(),
): string {
  return path.join(stateDir, STORE_DIR, STORE_FILENAME);
}

export async function listSelfImprovementRecommendations(params?: {
  stateDir?: string;
  storePath?: string;
}): Promise<SelfImprovementRecommendation[]> {
  const storePath =
    params?.storePath ?? resolveSelfImprovementRecommendationStorePath(params?.stateDir);
  const file = await readStoreFile(storePath);
  return file.recommendations.map(cloneRecommendation);
}

export async function getSelfImprovementRecommendation(params: {
  id: string;
  stateDir?: string;
  storePath?: string;
}): Promise<SelfImprovementRecommendation | null> {
  const id = params.id.trim();
  if (!id) {
    return null;
  }
  const recommendations = await listSelfImprovementRecommendations(params);
  return recommendations.find((entry) => entry.id === id) ?? null;
}

export async function upsertSelfImprovementRecommendations(params: {
  recommendations: SelfImprovementRecommendation[];
  stateDir?: string;
  storePath?: string;
}): Promise<{
  recommendations: SelfImprovementRecommendation[];
  created: number;
  updated: number;
  reopened: number;
}> {
  const storePath =
    params.storePath ?? resolveSelfImprovementRecommendationStorePath(params.stateDir);
  const file = await readStoreFile(storePath);
  const incomingRecommendations = params.recommendations.map(normalizeRecommendationForStore);
  const byFingerprint = new Map(
    file.recommendations.map((entry) => [entry.fingerprint, cloneRecommendation(entry)]),
  );
  let created = 0;
  let updated = 0;
  let reopened = 0;
  for (const recommendation of incomingRecommendations) {
    const existing = byFingerprint.get(recommendation.fingerprint);
    if (!existing) {
      created += 1;
      byFingerprint.set(recommendation.fingerprint, cloneRecommendation(recommendation));
      continue;
    }
    const recurringResolved = existing.status === "resolved" || existing.status === "dismissed";
    const next: SelfImprovementRecommendation = {
      ...cloneRecommendation(recommendation),
      id: existing.id,
      createdAt: existing.createdAt,
      recurrenceCount: Math.max(1, existing.recurrenceCount) + 1,
      status:
        existing.status === "resolved" || existing.status === "dismissed"
          ? "reopened"
          : existing.status,
      ...(existing.assignedTargetAgentId
        ? { assignedTargetAgentId: existing.assignedTargetAgentId }
        : {}),
      ...(existing.claimedBy ? { claimedBy: existing.claimedBy } : {}),
      ...(existing.lastRoutedAt ? { lastRoutedAt: existing.lastRoutedAt } : {}),
      ...(existing.resolutionProof ? { resolutionProof: existing.resolutionProof } : {}),
      ...(existing.dismissalReason ? { dismissalReason: existing.dismissalReason } : {}),
      ...(recurringResolved
        ? { reopenReason: "Recurring evidence found by Self-Improvement Governor scan." }
        : existing.reopenReason
          ? { reopenReason: existing.reopenReason }
          : {}),
    };
    if (next.status === "reopened") {
      reopened += 1;
    }
    updated += 1;
    byFingerprint.set(next.fingerprint, next);
  }
  const recommendations = [...byFingerprint.values()].toSorted(
    (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
  );
  const nextFile = cloneStore({ version: STORE_VERSION, recommendations });
  await writeStoreFile(storePath, nextFile);
  return {
    recommendations: nextFile.recommendations.map(cloneRecommendation),
    created,
    updated,
    reopened,
  };
}

export async function updateSelfImprovementRecommendationStatus(params: {
  id: string;
  status: SelfImprovementRecommendationStatus;
  note?: string;
  assignedTargetAgentId?: string;
  claimedBy?: string;
  resolutionProof?: string;
  dismissalReason?: string;
  stateDir?: string;
  storePath?: string;
  now?: number;
}): Promise<SelfImprovementRecommendation | null> {
  const storePath =
    params.storePath ?? resolveSelfImprovementRecommendationStorePath(params.stateDir);
  const file = await readStoreFile(storePath);
  const id = params.id.trim();
  const now = params.now ?? Date.now();
  let updated: SelfImprovementRecommendation | null = null;
  const recommendations = file.recommendations.map((entry) => {
    if (entry.id !== id) {
      return entry;
    }
    const assignedTargetAgentId = sanitizeRecommendationText(params.assignedTargetAgentId, 120);
    const claimedBy = sanitizeRecommendationText(params.claimedBy, 120);
    const resolutionProof = sanitizeRecommendationText(params.resolutionProof, 640);
    const dismissalReason = sanitizeRecommendationText(params.dismissalReason, 360);
    const note = sanitizeRecommendationText(params.note, 300);
    updated = {
      ...entry,
      status: params.status,
      updatedAt: now,
      ...(assignedTargetAgentId ? { assignedTargetAgentId, lastRoutedAt: now } : {}),
      ...(claimedBy ? { claimedBy } : {}),
      ...(resolutionProof ? { resolutionProof } : {}),
      ...(dismissalReason ? { dismissalReason } : {}),
      evidence: note ? [...entry.evidence, note] : entry.evidence,
    };
    return updated;
  });
  if (!updated) {
    return null;
  }
  await writeStoreFile(storePath, { version: STORE_VERSION, recommendations });
  return cloneRecommendation(updated);
}
