import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OagMetricCounters } from "./oag-metrics.js";

const OAG_MEMORY_FILENAME = "oag-memory.json";
const MAX_LIFECYCLE_AGE_DAYS = 30;
const MAX_LIFECYCLES = 100;

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
  count: number;
  firstAt: string;
  lastAt: string;
};

export type OagLifecycle = {
  id: string;
  startedAt: string;
  stoppedAt: string;
  stopReason: "clean" | "crash" | "restart" | "unknown";
  uptimeMs: number;
  metricsSnapshot: Partial<OagMetricCounters>;
  incidents: OagIncident[];
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
  }>;
  completedAt: string;
};

export type OagMemory = {
  version: number;
  lifecycles: OagLifecycle[];
  evolutions: OagEvolutionRecord[];
  diagnoses: OagDiagnosisRecord[];
};

function resolveMemoryPath(): string {
  return path.join(resolveStateDir(), OAG_MEMORY_FILENAME);
}

function createEmptyMemory(): OagMemory {
  return {
    version: 1,
    lifecycles: [],
    evolutions: [],
    diagnoses: [],
  };
}

export async function loadOagMemory(): Promise<OagMemory> {
  try {
    const raw = await fs.readFile(resolveMemoryPath(), "utf8");
    const parsed = JSON.parse(raw) as OagMemory;
    if (!parsed.version || !Array.isArray(parsed.lifecycles)) {
      return createEmptyMemory();
    }
    return parsed;
  } catch {
    return createEmptyMemory();
  }
}

export async function saveOagMemory(memory: OagMemory): Promise<void> {
  const filePath = resolveMemoryPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(memory, null, 2) + "\n", "utf8");
  await fs.rename(tmp, filePath);
}

function pruneOldLifecycles(memory: OagMemory): void {
  const cutoff = Date.now() - MAX_LIFECYCLE_AGE_DAYS * 24 * 60 * 60_000;
  memory.lifecycles = memory.lifecycles
    .filter((lc) => Date.parse(lc.stoppedAt) > cutoff)
    .slice(-MAX_LIFECYCLES);
}

export async function recordLifecycleShutdown(params: {
  startedAt: number;
  stopReason: OagLifecycle["stopReason"];
  metricsSnapshot: Partial<OagMetricCounters>;
  incidents: OagIncident[];
}): Promise<void> {
  const memory = await loadOagMemory();
  const now = Date.now();
  memory.lifecycles.push({
    id: `gw-${now}`,
    startedAt: new Date(params.startedAt).toISOString(),
    stoppedAt: new Date(now).toISOString(),
    stopReason: params.stopReason,
    uptimeMs: now - params.startedAt,
    metricsSnapshot: params.metricsSnapshot,
    incidents: params.incidents,
  });
  pruneOldLifecycles(memory);
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
