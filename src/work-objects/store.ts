import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ProofPacket,
  WorkObject,
  WorkObjectCreate,
  WorkObjectEvidence,
  WorkObjectWorkerRun,
  WorkObjectPatch,
  WorkObjectStatus,
  WorkObjectStoreFile,
} from "./types.js";
import { STATE_DIR } from "../config/paths.js";

const STORE_VERSION = 1 as const;

type WorkObjectEvidenceInput = NonNullable<WorkObjectCreate["evidence"]>[number];
type WorkObjectWorkerRunInput = NonNullable<WorkObjectCreate["workerRuns"]>[number];

function compactText(value: string, max = 20_000): string {
  const normalized = value.replace(/\r\n/g, "\n");
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}\n... (truncated)`;
}

function normalizeOptionalText(value: unknown, max?: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? compactText(trimmed, max) : undefined;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeEvidence(
  items: WorkObjectEvidenceInput[] | undefined,
  nowMs: number,
): WorkObjectEvidence[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const out: WorkObjectEvidence[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const label = normalizeOptionalText(item.label, 500);
    if (!label) {
      continue;
    }
    out.push({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : newId("ev"),
      kind: item.kind,
      label,
      value: normalizeOptionalText(item.value),
      path: normalizeOptionalText(item.path, 2_000),
      url: normalizeOptionalText(item.url, 2_000),
      atMs: typeof item.atMs === "number" && Number.isFinite(item.atMs) ? item.atMs : nowMs,
      metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : undefined,
    });
  }
  return out;
}

function normalizeWorkerRuns(
  items: WorkObjectWorkerRunInput[] | WorkObjectWorkerRun[] | undefined,
  nowMs: number,
): WorkObjectWorkerRun[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const out: WorkObjectWorkerRun[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    out.push({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : newId("worker"),
      role: item.role,
      engine: item.engine,
      label: normalizeOptionalText(item.label, 500),
      model: normalizeOptionalText(item.model, 500),
      modelStrategy: item.modelStrategy,
      status: item.status,
      runId: normalizeOptionalText(item.runId, 500),
      sessionKey: normalizeOptionalText(item.sessionKey, 1_000),
      startedAtMs:
        typeof item.startedAtMs === "number" && Number.isFinite(item.startedAtMs)
          ? item.startedAtMs
          : undefined,
      endedAtMs:
        typeof item.endedAtMs === "number" && Number.isFinite(item.endedAtMs)
          ? item.endedAtMs
          : undefined,
      output: normalizeOptionalText(item.output),
      verdict: item.verdict,
      evidence: normalizeEvidence(item.evidence, nowMs),
    });
  }
  return out;
}

export function resolveWorkObjectStorePath(): string {
  return path.join(STATE_DIR, "work-objects", "objects.json");
}

function emptyStore(): WorkObjectStoreFile {
  return { version: STORE_VERSION, objects: {} };
}

function normalizeLoadedStore(raw: unknown): WorkObjectStoreFile {
  if (!raw || typeof raw !== "object") {
    return emptyStore();
  }
  const candidate = raw as Partial<WorkObjectStoreFile>;
  if (
    candidate.version !== STORE_VERSION ||
    !candidate.objects ||
    typeof candidate.objects !== "object"
  ) {
    return emptyStore();
  }
  const objects: Record<string, WorkObject> = {};
  for (const [id, value] of Object.entries(candidate.objects)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const obj = value;
    if (typeof obj.id !== "string" || obj.id !== id) {
      continue;
    }
    if (!obj.title || !obj.goal || !obj.kind || !obj.status) {
      continue;
    }
    objects[id] = {
      ...obj,
      evidence: Array.isArray(obj.evidence) ? obj.evidence : [],
      workerRuns: normalizeWorkerRuns(obj.workerRuns, Date.now()),
      recovery: {
        policy: obj.recovery?.policy ?? "manual",
        attempts: Number.isFinite(obj.recovery?.attempts) ? obj.recovery.attempts : 0,
        lastRecoveredAtMs: obj.recovery?.lastRecoveredAtMs,
        lastReason: obj.recovery?.lastReason,
      },
    };
  }
  return { version: STORE_VERSION, objects };
}

export function loadWorkObjectStore(): WorkObjectStoreFile {
  const pathname = resolveWorkObjectStorePath();
  try {
    if (!fs.existsSync(pathname)) {
      return emptyStore();
    }
    const raw = JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
    return normalizeLoadedStore(raw);
  } catch {
    return emptyStore();
  }
}

export function saveWorkObjectStore(store: WorkObjectStoreFile): void {
  const pathname = resolveWorkObjectStorePath();
  const dir = path.dirname(pathname);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.objects.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, pathname);
  fs.chmodSync(pathname, 0o600);
}

export function listWorkObjects(): WorkObject[] {
  return Object.values(loadWorkObjectStore().objects).toSorted(
    (a, b) => b.updatedAtMs - a.updatedAtMs,
  );
}

export function getWorkObject(id: string): WorkObject | undefined {
  return loadWorkObjectStore().objects[id];
}

export function createWorkObject(params: WorkObjectCreate): WorkObject {
  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const id = params.id?.trim() || newId("wo");
  const title = normalizeOptionalText(params.title, 500) ?? "Untitled work";
  const goal = normalizeOptionalText(params.goal) ?? title;
  const store = loadWorkObjectStore();
  const existing = store.objects[id];
  if (existing) {
    const patched = patchWorkObject(id, {
      kind: params.kind,
      title,
      goal,
      status: params.status,
      source: params.source,
      actor: params.actor,
      requester: params.requester,
      isolation: params.isolation,
      recovery: params.recovery,
      workerPolicy: params.workerPolicy,
      workerRuns: params.workerRuns,
      evidence: params.evidence,
      nowMs,
    });
    return patched ?? existing;
  }
  const status = params.status ?? "queued";
  const obj: WorkObject = {
    id,
    kind: params.kind,
    title,
    goal,
    status,
    source: params.source,
    actor: params.actor,
    requester: params.requester,
    isolation: params.isolation,
    recovery: {
      policy: params.recovery?.policy ?? "manual",
      attempts: params.recovery?.attempts ?? 0,
      lastRecoveredAtMs: params.recovery?.lastRecoveredAtMs,
      lastReason: params.recovery?.lastReason,
    },
    workerPolicy: params.workerPolicy,
    workerRuns: normalizeWorkerRuns(params.workerRuns, nowMs),
    evidence: normalizeEvidence(params.evidence, nowMs),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    startedAtMs: status === "running" ? nowMs : undefined,
  };
  store.objects[id] = obj;
  saveWorkObjectStore(store);
  return obj;
}

export function patchWorkObject(
  id: string | undefined,
  patch: WorkObjectPatch,
): WorkObject | undefined {
  const key = id?.trim();
  if (!key) {
    return undefined;
  }
  const nowMs =
    typeof patch.nowMs === "number" && Number.isFinite(patch.nowMs) ? patch.nowMs : Date.now();
  const store = loadWorkObjectStore();
  const existing = store.objects[key];
  if (!existing) {
    return undefined;
  }
  const evidence = normalizeEvidence(patch.evidence, nowMs);
  const workerRuns = normalizeWorkerRuns(patch.workerRuns, nowMs);
  const next: WorkObject = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAtMs: existing.createdAtMs,
    updatedAtMs: nowMs,
    evidence: evidence.length > 0 ? [...existing.evidence, ...evidence] : existing.evidence,
    workerRuns:
      workerRuns.length > 0 ? [...existing.workerRuns, ...workerRuns] : existing.workerRuns,
    recovery: patch.recovery ? { ...existing.recovery, ...patch.recovery } : existing.recovery,
    proofPacket: patch.proofPacket ?? existing.proofPacket,
  };
  delete (next as { nowMs?: number }).nowMs;
  store.objects[key] = next;
  saveWorkObjectStore(store);
  return next;
}

export function appendWorkObjectEvidence(
  id: string | undefined,
  evidence: WorkObjectPatch["evidence"],
  nowMs = Date.now(),
): WorkObject | undefined {
  return patchWorkObject(id, { evidence, nowMs });
}

export function addWorkObjectWorkerRun(
  id: string | undefined,
  workerRun: WorkObjectWorkerRunInput,
  nowMs = Date.now(),
): WorkObject | undefined {
  return patchWorkObject(id, { workerRuns: [workerRun], nowMs });
}

export function updateWorkObjectWorkerRun(params: {
  workObjectId?: string;
  workerRunId: string;
  patch: Partial<Omit<WorkObjectWorkerRun, "id" | "evidence">> & {
    evidence?: WorkObjectCreate["evidence"];
  };
  nowMs?: number;
}): WorkObject | undefined {
  const key = params.workObjectId?.trim();
  if (!key) {
    return undefined;
  }
  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const store = loadWorkObjectStore();
  const existing = store.objects[key];
  if (!existing) {
    return undefined;
  }
  const workerRunId = params.workerRunId.trim();
  const workerRuns = existing.workerRuns.map((run) => {
    if (run.id !== workerRunId) {
      return run;
    }
    const evidence = normalizeEvidence(params.patch.evidence, nowMs);
    return {
      ...run,
      ...params.patch,
      id: run.id,
      evidence: evidence.length > 0 ? [...run.evidence, ...evidence] : run.evidence,
    };
  });
  const next = { ...existing, workerRuns, updatedAtMs: nowMs };
  store.objects[key] = next;
  saveWorkObjectStore(store);
  return next;
}

function statusToEndedAt(status: WorkObjectStatus, nowMs: number): number | undefined {
  return status === "queued" || status === "running" ? undefined : nowMs;
}

export function completeWorkObject(params: {
  id?: string;
  status: WorkObjectStatus;
  summary: string;
  output?: string;
  evidence?: WorkObjectPatch["evidence"];
  metrics?: ProofPacket["metrics"];
  nowMs?: number;
}): WorkObject | undefined {
  const key = params.id?.trim();
  if (!key) {
    return undefined;
  }
  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const store = loadWorkObjectStore();
  const existing = store.objects[key];
  if (!existing) {
    return undefined;
  }
  const addedEvidence = normalizeEvidence(params.evidence, nowMs);
  const evidence = [...existing.evidence, ...addedEvidence];
  const endedAtMs = statusToEndedAt(params.status, nowMs);
  const proofPacket: ProofPacket = {
    id: newId("proof"),
    workObjectId: key,
    status: params.status,
    summary: compactText(params.summary.trim() || existing.title, 4_000),
    output: normalizeOptionalText(params.output),
    evidence,
    workerRuns: existing.workerRuns,
    metrics: params.metrics,
    createdAtMs: nowMs,
  };
  const next: WorkObject = {
    ...existing,
    status: params.status,
    endedAtMs: endedAtMs ?? existing.endedAtMs,
    updatedAtMs: nowMs,
    evidence,
    proofPacket,
  };
  store.objects[key] = next;
  saveWorkObjectStore(store);
  return next;
}

export function markInterruptedWorkObjects(params?: {
  reason?: string;
  nowMs?: number;
  statuses?: WorkObjectStatus[];
}): WorkObject[] {
  const nowMs =
    typeof params?.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const statuses = new Set(params?.statuses ?? ["running"]);
  const store = loadWorkObjectStore();
  const changed: WorkObject[] = [];
  for (const [id, obj] of Object.entries(store.objects)) {
    if (!statuses.has(obj.status)) {
      continue;
    }
    const next: WorkObject = {
      ...obj,
      status: "interrupted",
      updatedAtMs: nowMs,
      recovery: {
        ...obj.recovery,
        attempts: obj.recovery.attempts + 1,
        lastRecoveredAtMs: nowMs,
        lastReason: params?.reason ?? "gateway restart recovery",
      },
      evidence: [
        ...obj.evidence,
        {
          id: newId("ev"),
          kind: "text",
          label: "Restart recovery",
          value: params?.reason ?? "Work was running when recovery scanned durable work objects.",
          atMs: nowMs,
        },
      ],
    };
    store.objects[id] = next;
    changed.push(next);
  }
  if (changed.length > 0) {
    saveWorkObjectStore(store);
  }
  return changed;
}
