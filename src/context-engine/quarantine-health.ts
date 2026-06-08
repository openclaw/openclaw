// Persists context-engine runtime quarantines so health surfaces can see
// failures recorded in sibling runtime processes.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { ContextEngineRuntimeQuarantine } from "./registry.js";

const QUARANTINE_HEALTH_SCHEMA_VERSION = 1;
const MAX_QUARANTINE_RECORDS = 64;

type PersistedContextEngineQuarantineRecord = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAtMs: number;
  processId: number;
  recordedAtMs: number;
};

type ContextEngineQuarantineHealthFile = {
  schemaVersion: typeof QUARANTINE_HEALTH_SCHEMA_VERSION;
  records: PersistedContextEngineQuarantineRecord[];
};

function quarantineHealthPath(): string {
  return path.join(resolveStateDir(), "context-engine", "runtime-quarantines.json");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeRecord(value: unknown): PersistedContextEngineQuarantineRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<PersistedContextEngineQuarantineRecord>;
  if (
    !isNonEmptyString(record.engineId) ||
    !isNonEmptyString(record.operation) ||
    !isNonEmptyString(record.reason) ||
    typeof record.failedAtMs !== "number" ||
    !Number.isFinite(record.failedAtMs) ||
    typeof record.processId !== "number" ||
    !Number.isInteger(record.processId) ||
    record.processId <= 0 ||
    typeof record.recordedAtMs !== "number" ||
    !Number.isFinite(record.recordedAtMs)
  ) {
    return undefined;
  }
  return {
    engineId: record.engineId,
    operation: record.operation,
    reason: record.reason,
    failedAtMs: record.failedAtMs,
    processId: record.processId,
    recordedAtMs: record.recordedAtMs,
    ...(isNonEmptyString(record.owner) ? { owner: record.owner } : {}),
  };
}

function processLooksLive(processId: number): boolean {
  if (processId === process.pid) {
    return true;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function readPersistedRecords(): PersistedContextEngineQuarantineRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(quarantineHealthPath(), "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as Partial<ContextEngineQuarantineHealthFile>).schemaVersion !==
      QUARANTINE_HEALTH_SCHEMA_VERSION ||
    !Array.isArray((parsed as Partial<ContextEngineQuarantineHealthFile>).records)
  ) {
    return [];
  }

  return (parsed as ContextEngineQuarantineHealthFile).records
    .map(normalizeRecord)
    .filter((record): record is PersistedContextEngineQuarantineRecord => Boolean(record))
    .filter((record) => processLooksLive(record.processId));
}

function writePersistedRecords(records: PersistedContextEngineQuarantineRecord[]): void {
  const filePath = quarantineHealthPath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload: ContextEngineQuarantineHealthFile = {
    schemaVersion: QUARANTINE_HEALTH_SCHEMA_VERSION,
    records: records
      .toSorted((left, right) => left.recordedAtMs - right.recordedAtMs)
      .slice(-MAX_QUARANTINE_RECORDS),
  };
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function recordKey(record: Pick<PersistedContextEngineQuarantineRecord, "engineId" | "processId">) {
  return `${record.engineId}\0${record.processId}`;
}

export function recordPersistedContextEngineQuarantine(
  quarantine: ContextEngineRuntimeQuarantine,
): void {
  const records = readPersistedRecords();
  const key = recordKey({ engineId: quarantine.engineId, processId: process.pid });
  if (records.some((record) => recordKey(record) === key)) {
    return;
  }
  records.push({
    engineId: quarantine.engineId,
    operation: quarantine.operation,
    reason: quarantine.reason,
    failedAtMs: quarantine.failedAt.getTime(),
    processId: process.pid,
    recordedAtMs: Date.now(),
    ...(quarantine.owner ? { owner: quarantine.owner } : {}),
  });
  writePersistedRecords(records);
}

export function listPersistedContextEngineQuarantines(): ContextEngineRuntimeQuarantine[] {
  const byEngineId = new Map<string, PersistedContextEngineQuarantineRecord>();
  for (const record of readPersistedRecords()) {
    const existing = byEngineId.get(record.engineId);
    if (!existing || record.failedAtMs < existing.failedAtMs) {
      byEngineId.set(record.engineId, record);
    }
  }
  return [...byEngineId.values()].map((record) => ({
    engineId: record.engineId,
    operation: record.operation,
    reason: record.reason,
    failedAt: new Date(record.failedAtMs),
    ...(record.owner ? { owner: record.owner } : {}),
  }));
}

function removePersistedContextEngineQuarantineFile(): void {
  try {
    fs.rmSync(quarantineHealthPath(), { force: true });
  } catch {
    // Best-effort cleanup; callers still clear in-memory state.
  }
}

export function clearPersistedContextEngineQuarantineForProcess(
  engineId: string | undefined,
  processId: number,
): void {
  const records = readPersistedRecords().filter((record) => {
    if (record.processId !== processId) {
      return true;
    }
    return engineId !== undefined && record.engineId !== engineId;
  });
  if (records.length === 0) {
    removePersistedContextEngineQuarantineFile();
    return;
  }
  writePersistedRecords(records);
}
