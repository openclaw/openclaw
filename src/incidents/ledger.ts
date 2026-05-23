import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { REDACTED_SENTINEL, redactConfigObject } from "../config/redact-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";

/**
 * Incident Ledger - Persistent audit trail for repairs and incidents.
 *
 * Stores JSONL records for each repair attempt, enabling:
 * - Repair audit trails with timestamps and outcomes
 * - Circuit breaker pattern for repeated failures
 * - Delta reports comparing before/after state
 */

export const LEDGER_DIRNAME = "incidents";
export const LEDGER_FILENAME = "ledger.jsonl";

export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "open" | "resolved" | "frozen";
export type RepairStatus = "pending" | "in_progress" | "succeeded" | "failed" | "skipped";

export type IncidentType =
  | "session_state_corruption"
  | "gateway_health"
  | "channel_connectivity"
  | "plugin_failure"
  | "task_flow_stuck"
  | "heartbeat_poisoned"
  | "a2a_delivery_failure"
  | "custom";

export type LedgerEntry = {
  id: string;
  timestamp: string;
  type: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;
  summary: string;
  details?: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
  source: string;
};

export type RepairAttempt = {
  id: string;
  incidentId: string;
  timestamp: string;
  action: string;
  status: RepairStatus;
  durationMs?: number;
  error?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
};

export type IncidentWithRepairs = LedgerEntry & {
  repairs: RepairAttempt[];
  attemptCount: number;
  lastAttemptAt?: string;
  circuitBreakerTripped: boolean;
};

function resolveLedgerDir(_config?: OpenClawConfig): string {
  const stateDir = resolveStateDir();
  const ledgerDir = path.join(stateDir, LEDGER_DIRNAME);
  if (!fs.existsSync(ledgerDir)) {
    fs.mkdirSync(ledgerDir, { recursive: true });
  }
  return ledgerDir;
}

function resolveLedgerPath(config?: OpenClawConfig): string {
  return path.join(resolveLedgerDir(config), LEDGER_FILENAME);
}

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${timestamp}-${random}`;
}

function parseJsonlLine(line: string): LedgerEntry | RepairAttempt | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && "id" in parsed && "timestamp" in parsed) {
      return parsed as LedgerEntry | RepairAttempt;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function redactLedgerValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveUrlLikeString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactLedgerValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactLedgerValue(item),
      ]),
    );
  }
  return value;
}

function redactLedgerRecord<T extends Record<string, unknown>>(record: T): T {
  return redactLedgerValue(redactConfigObject(record)) as T;
}

export function appendLedgerEntry(
  entry: Omit<LedgerEntry, "id" | "timestamp">,
  config?: OpenClawConfig,
): LedgerEntry {
  const ledgerPath = resolveLedgerPath(config);
  const fullEntry: LedgerEntry = {
    ...entry,
    details: entry.details ? redactLedgerRecord(entry.details) : undefined,
    id: generateId(),
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(ledgerPath, JSON.stringify(fullEntry) + "\n", "utf-8");
  return fullEntry;
}

export function appendRepairAttempt(
  repair: Omit<RepairAttempt, "id" | "timestamp">,
  config?: OpenClawConfig,
): RepairAttempt {
  const ledgerPath = resolveLedgerPath(config);
  const fullRepair: RepairAttempt = {
    ...repair,
    error: repair.error ? REDACTED_SENTINEL : undefined,
    beforeState: repair.beforeState ? redactLedgerRecord(repair.beforeState) : undefined,
    afterState: repair.afterState ? redactLedgerRecord(repair.afterState) : undefined,
    id: generateId(),
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(ledgerPath, JSON.stringify(fullRepair) + "\n", "utf-8");
  return fullRepair;
}

export function readLedger(config?: OpenClawConfig): {
  incidents: LedgerEntry[];
  repairs: RepairAttempt[];
} {
  const ledgerPath = resolveLedgerPath(config);
  const incidents: LedgerEntry[] = [];
  const repairs: RepairAttempt[] = [];

  if (!fs.existsSync(ledgerPath)) {
    return { incidents, repairs };
  }

  const content = fs.readFileSync(ledgerPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = parseJsonlLine(trimmed);
    if (!parsed) {
      continue;
    }

    if ("incidentId" in parsed) {
      repairs.push(parsed);
    } else {
      incidents.push(parsed);
    }
  }

  return { incidents, repairs };
}

export function getIncident(id: string, config?: OpenClawConfig): IncidentWithRepairs | null {
  const { incidents, repairs } = readLedger(config);
  const incident = incidents.find((i) => i.id === id);
  if (!incident) {
    return null;
  }

  const incidentRepairs = repairs.filter((r) => r.incidentId === id);
  const attemptCount = incidentRepairs.length;
  const lastAttemptAt =
    incidentRepairs.length > 0 ? incidentRepairs[incidentRepairs.length - 1].timestamp : undefined;

  // Circuit breaker: freeze after 3 consecutive failed repairs.
  const consecutiveFailedAttempts = incidentRepairs
    .toReversed()
    .findIndex((repair) => repair.status !== "failed");
  const failedAttemptRun =
    consecutiveFailedAttempts === -1 ? incidentRepairs.length : consecutiveFailedAttempts;
  const circuitBreakerTripped = failedAttemptRun >= 3;

  return {
    ...incident,
    repairs: incidentRepairs,
    attemptCount,
    lastAttemptAt,
    circuitBreakerTripped,
  };
}

export function getOpenIncidents(config?: OpenClawConfig): IncidentWithRepairs[] {
  const { incidents } = readLedger(config);
  const closedIncidentIds = new Set(
    incidents
      .filter((incident) => incident.status === "resolved" || incident.status === "frozen")
      .map((incident) => {
        const details = incident.details ?? {};
        return typeof details.resolvedIncidentId === "string"
          ? details.resolvedIncidentId
          : typeof details.frozenIncidentId === "string"
            ? details.frozenIncidentId
            : undefined;
      })
      .filter((id): id is string => Boolean(id)),
  );
  return incidents
    .filter((i) => i.status === "open" && !closedIncidentIds.has(i.id))
    .map((i) => getIncident(i.id, config))
    .filter((i): i is IncidentWithRepairs => i !== null);
}

export function resolveIncident(id: string, config?: OpenClawConfig): boolean {
  const incident = getIncident(id, config);
  if (!incident) {
    return false;
  }

  appendLedgerEntry(
    {
      type: incident.type,
      severity: incident.severity,
      status: "resolved",
      summary: `Resolved: ${incident.summary}`,
      source: "incident-ledger",
      details: { resolvedIncidentId: id },
    },
    config,
  );
  return true;
}

export function freezeIncident(id: string, reason: string, config?: OpenClawConfig): boolean {
  const incident = getIncident(id, config);
  if (!incident) {
    return false;
  }

  appendLedgerEntry(
    {
      type: incident.type,
      severity: incident.severity,
      status: "frozen",
      summary: `Frozen: ${incident.summary}`,
      source: "incident-ledger",
      details: { frozenIncidentId: id, reason },
    },
    config,
  );
  return true;
}

export function createIncident(
  params: {
    type: IncidentType;
    severity: IncidentSeverity;
    summary: string;
    details?: Record<string, unknown>;
    agentId?: string;
    sessionId?: string;
    source: string;
  },
  config?: OpenClawConfig,
): LedgerEntry {
  return appendLedgerEntry(
    {
      ...params,
      status: "open",
    },
    config,
  );
}

export function recordRepairAttempt(
  params: {
    incidentId: string;
    action: string;
    status: RepairStatus;
    durationMs?: number;
    error?: string;
    beforeState?: Record<string, unknown>;
    afterState?: Record<string, unknown>;
  },
  config?: OpenClawConfig,
): RepairAttempt {
  return appendRepairAttempt(params, config);
}

export { resolveLedgerDir, resolveLedgerPath };
