import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveOagMemoryMaxLifecycleAgeDays } from "./oag-config.js";
import type { OagMetricCounters } from "./oag-metrics.js";
import { resolveRestartSentinelPath } from "./restart-sentinel.js";

export type SentinelContext = {
  sessionKey?: string;
  channel?: string;
  stopReason?: string;
  timestamp?: string;
};

const OAG_MEMORY_FILENAME = "oag-memory.json";
const MAX_LIFECYCLES = 100;
// 7 days of hourly snapshots
const MAX_METRIC_SERIES = 168;

export type MetricSnapshot = {
  timestamp: string;
  uptimeMs: number;
  metrics: Record<string, number>;
};

export type OagIncident = {
  type:
    | "channel_crash_loop"
    | "delivery_recovery_failure"
    | "stale_detection"
    | "session_stuck"
    | "lock_contention";
  channel?: string;
  accountId?: string;
  detail: string;
  lastError?: string;
  count: number;
  firstAt: string;
  lastAt: string;
  resolvedAt?: number;
  recoveryMs?: number;
};

export type OagLifecycle = {
  id: string;
  startedAt: string;
  stoppedAt: string;
  stopReason: "clean" | "crash" | "restart" | "checkpoint" | "unknown";
  uptimeMs: number;
  metricsSnapshot: Partial<OagMetricCounters>;
  incidents: OagIncident[];
  sentinelContext?: SentinelContext;
};

export type OagEvolutionRecord = {
  appliedAt: string;
  source: "adaptive" | "agent-diagnosis" | "operator";
  trigger: string;
  changes: Array<{
    configPath: string;
    from: unknown;
    to: unknown;
  }>;
  outcome?: "effective" | "reverted" | "pending";
  outcomeAt?: string;
};

export type TrackedRecommendation = {
  id: string;
  parameter: string;
  oldValue: unknown;
  newValue: unknown;
  risk: "low" | "medium" | "high";
  applied: boolean;
  outcome?: "effective" | "reverted" | "neutral" | "pending";
  outcomeTimestamp?: string;
};

export type OagDiagnosisRecord = {
  id: string;
  triggeredAt: string;
  trigger: string;
  rootCause: string;
  confidence: number;
  recommendations: Array<{
    type: "config_change" | "code_pattern" | "operator_action";
    description: string;
    configPath?: string;
    suggestedValue?: unknown;
    risk: "low" | "medium" | "high";
    applied: boolean;
    recommendationId?: string;
    outcome?: "effective" | "reverted" | "neutral" | "pending";
    outcomeTimestamp?: string;
  }>;
  trackedRecommendations?: TrackedRecommendation[];
  completedAt: string;
};

export type OagAuditEntry = {
  timestamp: string;
  action: "evolution_applied" | "evolution_reverted" | "evolution_confirmed";
  detail: string;
  changes?: Array<{ configPath: string; from: unknown; to: unknown }>;
};

export type OagMemory = {
  version: number;
  lifecycles: OagLifecycle[];
  evolutions: OagEvolutionRecord[];
  diagnoses: OagDiagnosisRecord[];
  auditLog: OagAuditEntry[];
  metricSeries: MetricSnapshot[];
  activeObservation?: {
    evolutionAppliedAt: string;
    baselineMetrics: Record<string, number>;
    rollbackChanges: Array<{ configPath: string; previousValue: unknown }>;
    windowMs: number;
    diagnosisId?: string;
    recommendationIds?: string[];
  } | null;
};

function resolveMemoryPath(): string {
  return path.join(resolveStateDir(), OAG_MEMORY_FILENAME);
}

const MAX_AUDIT_LOG_ENTRIES = 200;

function createEmptyMemory(): OagMemory {
  return {
    version: 1,
    lifecycles: [],
    evolutions: [],
    diagnoses: [],
    auditLog: [],
    metricSeries: [],
    activeObservation: null,
  };
}

function ensureAuditLog(memory: OagMemory): OagMemory {
  if (!Array.isArray(memory.auditLog)) {
    memory.auditLog = [];
  }
  if (!Array.isArray(memory.metricSeries)) {
    memory.metricSeries = [];
  }
  return memory;
}

export async function loadOagMemory(): Promise<OagMemory> {
  const filePath = resolveMemoryPath();
  // Try main file first
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as OagMemory;
    if (parsed.version && Array.isArray(parsed.lifecycles)) {
      return ensureAuditLog(parsed);
    }
  } catch {
    // Main file missing or corrupt
  }
  // Fallback to backup
  try {
    const raw = await fs.readFile(`${filePath}.bak`, "utf8");
    const parsed = JSON.parse(raw) as OagMemory;
    if (parsed.version && Array.isArray(parsed.lifecycles)) {
      return ensureAuditLog(parsed);
    }
  } catch {
    // Backup also missing or corrupt
  }
  return createEmptyMemory();
}

export async function saveOagMemory(memory: OagMemory): Promise<void> {
  const filePath = resolveMemoryPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Backup existing file before write
  try {
    await fs.copyFile(filePath, `${filePath}.bak`);
  } catch {
    // No existing file to backup — first write
  }
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(memory, null, 2) + "\n", "utf8");
  await fs.rename(tmp, filePath);
}

function pruneOldLifecycles(memory: OagMemory, cfg?: OpenClawConfig): void {
  const ageDays = resolveOagMemoryMaxLifecycleAgeDays(cfg);
  const cutoff = Date.now() - ageDays * 24 * 60 * 60_000;
  memory.lifecycles = memory.lifecycles
    .filter((lc) => Date.parse(lc.stoppedAt) > cutoff)
    .slice(-MAX_LIFECYCLES);
}

export async function recordLifecycleShutdown(params: {
  startedAt: number;
  stopReason: OagLifecycle["stopReason"];
  metricsSnapshot: Partial<OagMetricCounters>;
  incidents: OagIncident[];
  cfg?: OpenClawConfig;
  sentinelContext?: SentinelContext;
}): Promise<void> {
  const memory = await loadOagMemory();
  const now = Date.now();
  const lifecycle: OagLifecycle = {
    id: `gw-${now}`,
    startedAt: new Date(params.startedAt).toISOString(),
    stoppedAt: new Date(now).toISOString(),
    stopReason: params.stopReason,
    uptimeMs: now - params.startedAt,
    metricsSnapshot: params.metricsSnapshot,
    incidents: params.incidents,
  };
  if (params.sentinelContext) {
    lifecycle.sentinelContext = params.sentinelContext;
  }
  memory.lifecycles.push(lifecycle);
  pruneOldLifecycles(memory, params.cfg);
  await saveOagMemory(memory);
}

export async function recordEvolution(record: OagEvolutionRecord): Promise<void> {
  const memory = await loadOagMemory();
  memory.evolutions.push(record);
  // Keep last 50 evolution records
  memory.evolutions = memory.evolutions.slice(-50);
  await saveOagMemory(memory);
}

export async function recordDiagnosis(record: OagDiagnosisRecord): Promise<void> {
  const memory = await loadOagMemory();
  memory.diagnoses.push(record);
  // Keep last 20 diagnosis records
  memory.diagnoses = memory.diagnoses.slice(-20);
  await saveOagMemory(memory);
}

export async function appendAuditEntry(entry: OagAuditEntry): Promise<void> {
  const memory = await loadOagMemory();
  memory.auditLog.push(entry);
  // Cap at MAX_AUDIT_LOG_ENTRIES, keeping the most recent entries
  memory.auditLog = memory.auditLog.slice(-MAX_AUDIT_LOG_ENTRIES);
  await saveOagMemory(memory);
}

export async function appendMetricSnapshot(snapshot: MetricSnapshot): Promise<void> {
  const memory = await loadOagMemory();
  memory.metricSeries.push(snapshot);
  // Cap at MAX_METRIC_SERIES (168 = 7 days hourly), keeping most recent
  memory.metricSeries = memory.metricSeries.slice(-MAX_METRIC_SERIES);
  await saveOagMemory(memory);
}

export async function updateRecommendationOutcome(
  diagnosisId: string,
  recommendationId: string,
  outcome: "effective" | "reverted" | "neutral" | "pending",
): Promise<boolean> {
  const memory = await loadOagMemory();
  const diagnosis = memory.diagnoses.find((d) => d.id === diagnosisId);
  if (!diagnosis) {
    return false;
  }

  let updated = false;
  const now = new Date().toISOString();

  // Update in recommendations array
  for (const rec of diagnosis.recommendations) {
    if (rec.recommendationId === recommendationId) {
      rec.outcome = outcome;
      rec.outcomeTimestamp = now;
      updated = true;
    }
  }

  // Update in trackedRecommendations array
  if (diagnosis.trackedRecommendations) {
    for (const tr of diagnosis.trackedRecommendations) {
      if (tr.id === recommendationId) {
        tr.outcome = outcome;
        tr.outcomeTimestamp = now;
        updated = true;
      }
    }
  }

  if (updated) {
    await saveOagMemory(memory);
  }

  return updated;
}

export function getRecentCrashes(memory: OagMemory, windowHours = 24): OagLifecycle[] {
  const cutoff = Date.now() - windowHours * 60 * 60_000;
  return memory.lifecycles.filter(
    (lc) => lc.stopReason === "crash" && Date.parse(lc.stoppedAt) > cutoff,
  );
}

export function findRecurringIncidentPattern(
  memory: OagMemory,
  windowHours = 24,
  minOccurrences = 3,
): { type: string; channel?: string; occurrences: number; incidents: OagIncident[] }[] {
  const cutoff = Date.now() - windowHours * 60 * 60_000;
  const recentLifecycles = memory.lifecycles.filter((lc) => Date.parse(lc.stoppedAt) > cutoff);
  const grouped = new Map<string, OagIncident[]>();
  for (const lc of recentLifecycles) {
    for (const incident of lc.incidents) {
      const key = `${incident.type}:${incident.channel ?? "all"}`;
      const group = grouped.get(key);
      if (group) {
        group.push(incident);
      } else {
        grouped.set(key, [incident]);
      }
    }
  }
  const patterns: {
    type: string;
    channel?: string;
    occurrences: number;
    incidents: OagIncident[];
  }[] = [];
  for (const [key, incidents] of grouped) {
    if (incidents.length >= minOccurrences) {
      const [type, channel] = key.split(":");
      patterns.push({
        type,
        channel: channel === "all" ? undefined : channel,
        occurrences: incidents.length,
        incidents,
      });
    }
  }
  return patterns;
}

/**
 * Reads the restart sentinel file and extracts context relevant for OAG
 * lifecycle records. Returns undefined when the file is missing or invalid.
 */
export async function readSentinelContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SentinelContext | undefined> {
  const filePath = resolveRestartSentinelPath(env);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: number; payload?: Record<string, unknown> };
    if (!parsed || parsed.version !== 1 || !parsed.payload) {
      return undefined;
    }
    const payload = parsed.payload;
    const ctx: SentinelContext = {};
    if (typeof payload.sessionKey === "string") {
      ctx.sessionKey = payload.sessionKey;
    }
    // Channel lives inside deliveryContext
    const dc = payload.deliveryContext as Record<string, unknown> | undefined;
    if (dc && typeof dc.channel === "string") {
      ctx.channel = dc.channel;
    }
    if (typeof payload.kind === "string") {
      ctx.stopReason = payload.kind;
    }
    if (typeof payload.ts === "number") {
      ctx.timestamp = new Date(payload.ts).toISOString();
    }
    // Only return if at least one field was populated
    if (ctx.sessionKey || ctx.channel || ctx.stopReason || ctx.timestamp) {
      return ctx;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
