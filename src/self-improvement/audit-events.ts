import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { redactSensitiveFieldValue } from "../logging/redact.js";
import { sanitizeRecommendationText, sanitizeRecommendationTexts } from "./text.js";
import type {
  SelfImprovementAuditEvent,
  SelfImprovementAuditEventStoreFile,
  SelfImprovementModelPreflightResult,
} from "./types.js";

const STORE_VERSION = 1;
const STORE_DIR = "self-improvement";
const STORE_FILENAME = "audit-events.json";
const MAX_EVENTS = 2_000;
const MAX_METADATA_ENTRIES = 50;
const MAX_METADATA_ARRAY_ITEMS = 50;

function eventId(value: string): string {
  return `sie_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isAuditEventKind(value: unknown): value is SelfImprovementAuditEvent["kind"] {
  return (
    value === "recommendation_status_updated" ||
    value === "recommendation_group_updated" ||
    value === "background_cycle" ||
    value === "analysis_run" ||
    value === "model_preflight" ||
    value === "reviewer_eval_run" ||
    value === "operational_health_snapshot" ||
    value === "production_check" ||
    value === "retention_maintenance" ||
    value === "proposal_created" ||
    value === "proposal_status_updated" ||
    value === "curator_status_updated" ||
    value === "scorecard_snapshot_written"
  );
}

function isAuditEventActor(value: unknown): value is SelfImprovementAuditEvent["actor"] {
  return value === "governor" || value === "operator" || value === "cli" || value === "gateway";
}

function sanitizeAuditMetadata(
  value: unknown,
): Record<string, string | number | boolean | string[]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const metadata: Record<string, string | number | boolean | string[]> = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, MAX_METADATA_ENTRIES)) {
    const key = sanitizeRecommendationText(rawKey, 120);
    if (!key) {
      continue;
    }
    if (typeof rawValue === "string") {
      const text = sanitizeRecommendationText(redactSensitiveFieldValue(rawKey, rawValue), 640);
      if (text) {
        metadata[key] = text;
      }
      continue;
    }
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      metadata[key] = rawValue;
      continue;
    }
    if (typeof rawValue === "boolean") {
      metadata[key] = rawValue;
      continue;
    }
    if (Array.isArray(rawValue)) {
      const texts = sanitizeRecommendationTexts(
        rawValue
          .slice(0, MAX_METADATA_ARRAY_ITEMS)
          .map((entry) =>
            typeof entry === "string" ? redactSensitiveFieldValue(rawKey, entry) : entry,
          ),
        240,
      );
      if (texts.length > 0) {
        metadata[key] = texts;
      }
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function parseEvent(value: unknown): SelfImprovementAuditEvent | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isAuditEventKind(value.kind) ||
    !isAuditEventActor(value.actor) ||
    typeof value.targetId !== "string" ||
    typeof value.summary !== "string"
  ) {
    return null;
  }
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? Math.max(0, Math.floor(value.createdAt))
      : 0;
  const metadata = sanitizeAuditMetadata(value.metadata);
  return {
    id: sanitizeRecommendationText(value.id, 140) || eventId(`${createdAt}:${value.kind}`),
    createdAt,
    kind: value.kind,
    actor: value.actor,
    targetId: sanitizeRecommendationText(value.targetId, 180),
    summary: sanitizeRecommendationText(value.summary, 640),
    ...(metadata ? { metadata } : {}),
  };
}

function normalizeStore(value: unknown): SelfImprovementAuditEventStoreFile {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    return { version: STORE_VERSION, events: [] };
  }
  return {
    version: STORE_VERSION,
    events: value.events
      .map(parseEvent)
      .filter((entry): entry is SelfImprovementAuditEvent => Boolean(entry)),
  };
}

async function readStore(storePath: string): Promise<SelfImprovementAuditEventStoreFile> {
  try {
    return normalizeStore(JSON.parse(await fs.readFile(storePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, events: [] };
    }
    throw error;
  }
}

async function writeStore(
  storePath: string,
  file: SelfImprovementAuditEventStoreFile,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, storePath);
}

export function resolveSelfImprovementAuditEventStorePath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, STORE_DIR, STORE_FILENAME);
}

export async function appendSelfImprovementAuditEvent(params: {
  event: Omit<SelfImprovementAuditEvent, "id" | "createdAt"> & {
    id?: string;
    createdAt?: number;
  };
  stateDir?: string;
  storePath?: string;
}): Promise<SelfImprovementAuditEvent> {
  const storePath = params.storePath ?? resolveSelfImprovementAuditEventStorePath(params.stateDir);
  const file = await readStore(storePath);
  const createdAt = params.event.createdAt ?? Date.now();
  const event = parseEvent({
    ...params.event,
    id:
      params.event.id ??
      eventId(`${createdAt}:${params.event.kind}:${params.event.targetId}:${params.event.summary}`),
    createdAt,
  });
  if (!event) {
    throw new Error("Invalid self-improvement audit event.");
  }
  const events = [...file.events, event]
    .toSorted((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_EVENTS);
  await writeStore(storePath, { version: STORE_VERSION, events });
  return structuredClone(event);
}

export function buildSelfImprovementModelAttemptAuditMetadata(
  attempts: Readonly<SelfImprovementModelPreflightResult["attempts"]>,
): Record<string, number | string | string[]> {
  const passedAttempts = attempts.filter((attempt) => attempt.status === "success");
  const blockedAttempts = attempts.filter((attempt) => attempt.status === "blocked");
  const failedAttempts = attempts.filter((attempt) => attempt.status === "failed");
  const invalidJsonAttempts = attempts.filter((attempt) => attempt.status === "invalid_json");
  const invalidJsonDiagnostics = invalidJsonAttempts
    .map((attempt) => attempt.diagnostic ?? "")
    .filter(Boolean)
    .slice(0, 4);
  const primaryProblemAttempt = attempts.find(
    (attempt) =>
      attempt.status !== "success" &&
      (attempt.tier === "primaryReview" || attempt.tier === "strategic"),
  );
  const blockedRemediationHints = attempts
    .filter((attempt) => attempt.status !== "success")
    .map((attempt) =>
      attempt.remediationHint ? `${attempt.tier}: ${attempt.remediationHint}` : "",
    )
    .filter(Boolean)
    .slice(0, 4);
  const attemptBlockers = attempts
    .filter((attempt) => attempt.status !== "success" && attempt.error)
    .map(
      (attempt) =>
        `${attempt.tier}:${attempt.status}:${attempt.preflightStatus ?? "not_required"}: ${
          attempt.error ?? ""
        }`,
    )
    .slice(0, 4);
  const completionDurations = attempts
    .filter(
      (attempt) =>
        typeof attempt.completionMs === "number" && Number.isFinite(attempt.completionMs),
    )
    .map((attempt) => `${attempt.tier}:${Math.max(0, Math.floor(attempt.completionMs ?? 0))}ms`)
    .slice(0, 8);
  const preflightSources = attempts
    .filter((attempt) => attempt.preflightSource)
    .map(
      (attempt) =>
        `${attempt.tier}:${attempt.preflightSource}:${
          attempt.providerConfigured === undefined
            ? "unknown"
            : attempt.providerConfigured
              ? "configured"
              : "default"
        }`,
    )
    .slice(0, 8);
  const defaultOllamaFallbackAttempts = attempts.filter(
    (attempt) => attempt.preflightSource === "default_ollama",
  ).length;
  return {
    attemptCount: attempts.length,
    passedAttempts: passedAttempts.length,
    blockedAttempts: blockedAttempts.length,
    failedAttempts: failedAttempts.length,
    invalidJsonAttempts: invalidJsonAttempts.length,
    ...(primaryProblemAttempt?.remediationHint
      ? { primaryRemediationHint: primaryProblemAttempt.remediationHint }
      : {}),
    ...(blockedRemediationHints.length > 0 ? { blockedRemediationHints } : {}),
    ...(invalidJsonDiagnostics.length > 0 ? { invalidJsonDiagnostics } : {}),
    ...(attemptBlockers.length > 0 ? { attemptBlockers } : {}),
    ...(completionDurations.length > 0 ? { completionDurations } : {}),
    ...(preflightSources.length > 0 ? { preflightSources } : {}),
    ...(defaultOllamaFallbackAttempts > 0 ? { defaultOllamaFallbackAttempts } : {}),
    attemptStatuses: attempts
      .slice(0, 8)
      .map(
        (attempt) =>
          `${attempt.tier}:${attempt.status}:${attempt.preflightStatus ?? "not_required"}`,
      ),
  };
}

export async function appendSelfImprovementModelPreflightAuditEvent(params: {
  result: SelfImprovementModelPreflightResult;
  stateDir?: string;
  actor?: SelfImprovementAuditEvent["actor"];
}): Promise<SelfImprovementAuditEvent> {
  const { result } = params;
  return await appendSelfImprovementAuditEvent({
    stateDir: params.stateDir,
    event: {
      createdAt: result.checkedAt,
      actor: params.actor ?? "gateway",
      kind: "model_preflight",
      targetId: "self-improvement-models",
      summary: `Checked Self-Improvement model readiness: ${result.readiness}.`,
      metadata: {
        reviewPolicy: result.reviewPolicy,
        readiness: result.readiness,
        ready: result.ready,
        localFirst: result.localFirst,
        hostedEscalationAllowed: result.hostedEscalationAllowed,
        strategicLocalAllowed: result.strategicLocalAllowed,
        strategicRequested: result.strategicRequested,
        schemaValidated: result.schemaValidated,
        ...buildSelfImprovementModelAttemptAuditMetadata(result.attempts),
        ...(result.readyTier ? { readyTier: result.readyTier } : {}),
        ...(result.readyModelId ? { readyModelId: result.readyModelId } : {}),
        ...(result.reviewModelId ? { reviewModelId: result.reviewModelId } : {}),
        ...(result.fallbackModelId ? { fallbackModelId: result.fallbackModelId } : {}),
        ...(result.strategicModelId ? { strategicModelId: result.strategicModelId } : {}),
        ...(result.hostedModelId ? { hostedModelId: result.hostedModelId } : {}),
        ...(result.preflightStatus ? { preflightStatus: result.preflightStatus } : {}),
        ...(result.preflightMs !== undefined ? { preflightMs: result.preflightMs } : {}),
        ...(result.escalationReason ? { escalationReason: result.escalationReason } : {}),
        ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
        ...(result.blockedPrimaryReason
          ? { blockedPrimaryReason: result.blockedPrimaryReason }
          : {}),
      },
    },
  });
}

export async function listSelfImprovementAuditEvents(params?: {
  stateDir?: string;
  storePath?: string;
  limit?: number;
  kind?: SelfImprovementAuditEvent["kind"] | SelfImprovementAuditEvent["kind"][];
}): Promise<SelfImprovementAuditEvent[]> {
  const storePath =
    params?.storePath ?? resolveSelfImprovementAuditEventStorePath(params?.stateDir);
  const file = await readStore(storePath);
  const limit = params?.limit && params.limit > 0 ? params.limit : 100;
  const kinds = params?.kind
    ? new Set(Array.isArray(params.kind) ? params.kind : [params.kind])
    : null;
  return file.events
    .filter((entry) => !kinds || kinds.has(entry.kind))
    .toSorted((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map((entry) => structuredClone(entry));
}
