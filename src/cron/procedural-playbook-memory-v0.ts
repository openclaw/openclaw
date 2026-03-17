import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import type { CronPayload, CronRunStatus, CronSessionTarget } from "./types.js";

export const CRON_PROCEDURAL_PLAYBOOK_MEMORY_V0_ENABLE_ENV = "OPENCLAW_CRON_PLAYBOOK_MEMORY_V0";
export const CRON_PROCEDURAL_PLAYBOOK_MEMORY_V0_KILL_SWITCH_ENV =
  "OPENCLAW_CRON_PLAYBOOK_MEMORY_V0_DISABLE";

export type CronProceduralPlaybookFailureKind =
  | "delivery-target"
  | "tool-validation"
  | "runtime-validation"
  | "timeout"
  | "unknown";

export type CronProceduralPlaybookSignalV0 = {
  jobId: string;
  jobName?: string;
  sessionTarget: CronSessionTarget;
  payloadKind: CronPayload["kind"];
  status: CronRunStatus;
  error?: string;
  errorKind?: string;
  occurredAtMs?: number;
};

export type CronProceduralPlaybookEntryV0 = {
  signature: string;
  sessionTarget: CronSessionTarget;
  payloadKind: CronPayload["kind"];
  failureKind: CronProceduralPlaybookFailureKind;
  rootCause: string;
  steps: string[];
  safeDefault: true;
  failureCount: number;
  successCount: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  lastError?: string;
  lastJobName?: string;
  jobIds: string[];
};

export type CronProceduralPlaybookMemoryStateV0 = {
  version: 1;
  updatedAtMs: number;
  entries: Record<string, CronProceduralPlaybookEntryV0>;
};

export type CronProceduralPlaybookGuidanceV0 = {
  signature: string;
  failureKind: CronProceduralPlaybookFailureKind;
  rootCause: string;
  steps: string[];
  failureCount: number;
  successCount: number;
  lastSeenAtMs: number;
};

export interface CronProceduralPlaybookMemoryStoreV0 {
  load(): CronProceduralPlaybookMemoryStateV0 | undefined;
  save(state: CronProceduralPlaybookMemoryStateV0): void;
  resolvePath?(): string;
}

const MAX_TRACKED_JOB_IDS = 12;

const DELIVERY_TARGET_ERROR_RE =
  /(delivery target|delivery\.to|delivery channel|delivery target is missing|delivery channel is missing|invalid telegram delivery target)/i;
const TOOL_VALIDATION_ERROR_RE = /^invalid\s+[a-z0-9_.-]+\s+params\b/i;
const RUNTIME_VALIDATION_ERROR_RE =
  /(requires payload\.kind|requires non-empty|invalid model reference|main cron jobs require payload|isolated cron jobs require payload)/i;
const TIMEOUT_ERROR_RE = /(timed out|timeout|deadline exceeded|aborterror)/i;

const DEFAULT_PLAYBOOK: Record<
  CronProceduralPlaybookFailureKind,
  { rootCause: string; steps: string[] }
> = {
  "delivery-target": {
    rootCause: "delivery-target-resolution-failed",
    steps: [
      "Set explicit delivery.channel and delivery.to so cron resolves one deterministic destination.",
      "Dry-run once with `openclaw cron run <jobId>` and confirm the resolved target/account.",
      "If delivery is optional, use delivery.bestEffort=true to avoid hard scheduling failures.",
    ],
  },
  "tool-validation": {
    rootCause: "cron-tool-input-validation-failed",
    steps: [
      "Validate schedule/payload/delivery fields before saving job edits.",
      "Prefer `openclaw cron add` / `openclaw cron edit` over manual JSON patches.",
      "Re-run the job once manually after schema-changing edits.",
    ],
  },
  "runtime-validation": {
    rootCause: "cron-runtime-validation-failed",
    steps: [
      "Verify sessionTarget/payload.kind pairing and non-empty message fields.",
      "Check model and auth-profile overrides for the target agent.",
      "Apply the smallest safe fix and validate with one isolated run before recurrence.",
    ],
  },
  timeout: {
    rootCause: "cron-job-execution-timeout",
    steps: [
      "Reduce prompt scope or split long work into multiple jobs.",
      "Increase payload.timeoutSeconds only when runtime is predictably bounded.",
      "Use retry/backoff policies instead of rapid immediate retries.",
    ],
  },
  unknown: {
    rootCause: "cron-unknown-failure",
    steps: [
      "Capture exact error text and recent job config changes.",
      "Reproduce with `openclaw cron run <jobId>` to separate transient vs deterministic errors.",
      "Ship the narrowest mitigation first; avoid broad retries until root cause is clear.",
    ],
  },
};

export function isCronProceduralPlaybookMemoryV0Enabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isTruthyEnvValue(env[CRON_PROCEDURAL_PLAYBOOK_MEMORY_V0_KILL_SWITCH_ENV])) {
    return false;
  }
  return isTruthyEnvValue(env[CRON_PROCEDURAL_PLAYBOOK_MEMORY_V0_ENABLE_ENV]);
}

export function resolveCronProceduralPlaybookFailureKind(params: {
  errorKind?: string;
  error?: string;
}): CronProceduralPlaybookFailureKind {
  const errorKind = normalizeToken(params.errorKind);
  const error = params.error?.trim() ?? "";

  if (
    errorKind === "delivery-target" ||
    errorKind === "delivery_target" ||
    errorKind === "delivery"
  ) {
    return "delivery-target";
  }
  if (errorKind === "tool-validation" || errorKind === "tool_validation") {
    return "tool-validation";
  }
  if (errorKind === "runtime-validation" || errorKind === "runtime_validation") {
    return "runtime-validation";
  }
  if (errorKind === "timeout") {
    return "timeout";
  }

  if (!error) {
    return "unknown";
  }
  if (DELIVERY_TARGET_ERROR_RE.test(error)) {
    return "delivery-target";
  }
  if (TOOL_VALIDATION_ERROR_RE.test(error)) {
    return "tool-validation";
  }
  if (RUNTIME_VALIDATION_ERROR_RE.test(error)) {
    return "runtime-validation";
  }
  if (TIMEOUT_ERROR_RE.test(error)) {
    return "timeout";
  }
  return "unknown";
}

export function buildCronProceduralPlaybookSignature(params: {
  sessionTarget: CronSessionTarget;
  payloadKind: CronPayload["kind"];
  failureKind: CronProceduralPlaybookFailureKind;
}): string {
  return `${params.sessionTarget}:${params.payloadKind}:${params.failureKind}`;
}

export function createEmptyCronProceduralPlaybookMemoryStateV0(
  nowMs: number = Date.now(),
): CronProceduralPlaybookMemoryStateV0 {
  return {
    version: 1,
    updatedAtMs: nowMs,
    entries: {},
  };
}

export class CronProceduralPlaybookMemoryLayerV0 {
  private readonly store: CronProceduralPlaybookMemoryStoreV0;
  private readonly nowMs: () => number;
  private state: CronProceduralPlaybookMemoryStateV0;

  constructor(params: { store: CronProceduralPlaybookMemoryStoreV0; nowMs?: () => number }) {
    this.store = params.store;
    this.nowMs = params.nowMs ?? (() => Date.now());
    this.state = this.loadState();
  }

  getStateSnapshot(): CronProceduralPlaybookMemoryStateV0 {
    return cloneState(this.state);
  }

  recordSignal(signal: CronProceduralPlaybookSignalV0): CronProceduralPlaybookEntryV0 | undefined {
    const now = signal.occurredAtMs ?? this.nowMs();
    if (signal.status !== "error") {
      return this.recordNonErrorSignal(signal, now);
    }

    const failureKind = resolveCronProceduralPlaybookFailureKind({
      errorKind: signal.errorKind,
      error: signal.error,
    });
    const signature = buildCronProceduralPlaybookSignature({
      sessionTarget: signal.sessionTarget,
      payloadKind: signal.payloadKind,
      failureKind,
    });

    const existing = this.state.entries[signature];
    const entry = existing
      ? { ...existing }
      : this.createDefaultEntry({
          signature,
          sessionTarget: signal.sessionTarget,
          payloadKind: signal.payloadKind,
          failureKind,
          now,
        });

    entry.failureCount += 1;
    entry.lastSeenAtMs = now;
    entry.lastError = signal.error?.trim() || entry.lastError;
    entry.lastJobName = signal.jobName?.trim() || entry.lastJobName;
    entry.jobIds = appendJobId(entry.jobIds, signal.jobId);

    this.state.entries[signature] = entry;
    this.state.updatedAtMs = now;
    this.persistState();
    return cloneEntry(entry);
  }

  getGuidance(params?: {
    sessionTarget?: CronSessionTarget;
    payloadKind?: CronPayload["kind"];
    limit?: number;
    includeUnknown?: boolean;
  }): CronProceduralPlaybookGuidanceV0[] {
    const limit = clampLimit(params?.limit);
    const includeUnknown = params?.includeUnknown ?? false;

    const entries = Object.values(this.state.entries).filter((entry) => {
      if (!includeUnknown && entry.failureKind === "unknown") {
        return false;
      }
      if (params?.sessionTarget && entry.sessionTarget !== params.sessionTarget) {
        return false;
      }
      if (params?.payloadKind && entry.payloadKind !== params.payloadKind) {
        return false;
      }
      return true;
    });

    entries.sort((a, b) => {
      if (b.failureCount !== a.failureCount) {
        return b.failureCount - a.failureCount;
      }
      return b.lastSeenAtMs - a.lastSeenAtMs;
    });

    return entries.slice(0, limit).map((entry) => ({
      signature: entry.signature,
      failureKind: entry.failureKind,
      rootCause: entry.rootCause,
      steps: [...entry.steps],
      failureCount: entry.failureCount,
      successCount: entry.successCount,
      lastSeenAtMs: entry.lastSeenAtMs,
    }));
  }

  buildPromptSnippet(params?: {
    sessionTarget?: CronSessionTarget;
    payloadKind?: CronPayload["kind"];
    limit?: number;
  }): string | undefined {
    const guidance = this.getGuidance({
      sessionTarget: params?.sessionTarget,
      payloadKind: params?.payloadKind,
      limit: params?.limit,
    });

    if (guidance.length === 0) {
      return undefined;
    }

    const lines: string[] = ["Procedural playbook (safe defaults from prior failures):"];
    for (const item of guidance) {
      lines.push(
        `- ${item.failureKind} (${item.failureCount} failures / ${item.successCount} recoveries)`,
      );
      for (const step of item.steps) {
        lines.push(`  - ${step}`);
      }
    }
    return lines.join("\n");
  }

  private loadState(): CronProceduralPlaybookMemoryStateV0 {
    const raw = this.store.load();
    const parsed = toState(raw);
    if (parsed) {
      return parsed;
    }
    return createEmptyCronProceduralPlaybookMemoryStateV0(this.nowMs());
  }

  private createDefaultEntry(params: {
    signature: string;
    sessionTarget: CronSessionTarget;
    payloadKind: CronPayload["kind"];
    failureKind: CronProceduralPlaybookFailureKind;
    now: number;
  }): CronProceduralPlaybookEntryV0 {
    const defaults = DEFAULT_PLAYBOOK[params.failureKind];
    return {
      signature: params.signature,
      sessionTarget: params.sessionTarget,
      payloadKind: params.payloadKind,
      failureKind: params.failureKind,
      rootCause: defaults.rootCause,
      steps: [...defaults.steps],
      safeDefault: true,
      failureCount: 0,
      successCount: 0,
      firstSeenAtMs: params.now,
      lastSeenAtMs: params.now,
      jobIds: [],
    };
  }

  private recordNonErrorSignal(
    signal: CronProceduralPlaybookSignalV0,
    now: number,
  ): CronProceduralPlaybookEntryV0 | undefined {
    if (!signal.errorKind && !signal.error) {
      return undefined;
    }
    const failureKind = resolveCronProceduralPlaybookFailureKind({
      errorKind: signal.errorKind,
      error: signal.error,
    });
    const signature = buildCronProceduralPlaybookSignature({
      sessionTarget: signal.sessionTarget,
      payloadKind: signal.payloadKind,
      failureKind,
    });
    const existing = this.state.entries[signature];
    if (!existing) {
      return undefined;
    }
    const entry = {
      ...existing,
      successCount: existing.successCount + 1,
      lastSeenAtMs: now,
      jobIds: appendJobId(existing.jobIds, signal.jobId),
      lastJobName: signal.jobName?.trim() || existing.lastJobName,
    } satisfies CronProceduralPlaybookEntryV0;
    this.state.entries[signature] = entry;
    this.state.updatedAtMs = now;
    this.persistState();
    return cloneEntry(entry);
  }

  private persistState() {
    this.store.save(this.state);
  }
}

export function resolveDefaultCronProceduralPlaybookMemoryPathV0(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "cron", "playbook-memory-v0.json");
}

export class FileCronProceduralPlaybookMemoryStoreV0 implements CronProceduralPlaybookMemoryStoreV0 {
  private readonly env: NodeJS.ProcessEnv;
  private readonly explicitPath?: string;

  constructor(params?: { env?: NodeJS.ProcessEnv; path?: string }) {
    this.env = params?.env ?? process.env;
    this.explicitPath = params?.path;
  }

  resolvePath(): string {
    if (this.explicitPath?.trim()) {
      return path.resolve(this.explicitPath.trim());
    }
    return resolveDefaultCronProceduralPlaybookMemoryPathV0(this.env);
  }

  load(): CronProceduralPlaybookMemoryStateV0 | undefined {
    const parsed = toState(loadJsonFile(this.resolvePath()));
    return parsed ?? undefined;
  }

  save(state: CronProceduralPlaybookMemoryStateV0): void {
    saveJsonFile(this.resolvePath(), state);
  }
}

export function createInMemoryCronProceduralPlaybookMemoryStoreV0(
  seed?: CronProceduralPlaybookMemoryStateV0,
): CronProceduralPlaybookMemoryStoreV0 {
  let state = seed ? cloneState(seed) : undefined;
  return {
    load() {
      return state ? cloneState(state) : undefined;
    },
    save(next) {
      state = cloneState(next);
    },
    resolvePath() {
      return "in-memory://cron/playbook-memory-v0";
    },
  };
}

export function recordCronProceduralPlaybookSignalV0(params: {
  signal: CronProceduralPlaybookSignalV0;
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  store?: CronProceduralPlaybookMemoryStoreV0;
  nowMs?: () => number;
  onError?: (error: string) => void;
}): CronProceduralPlaybookEntryV0 | undefined {
  const enabled = params.enabled ?? isCronProceduralPlaybookMemoryV0Enabled(params.env);
  if (!enabled) {
    return undefined;
  }
  try {
    const layer = new CronProceduralPlaybookMemoryLayerV0({
      store: params.store ?? new FileCronProceduralPlaybookMemoryStoreV0({ env: params.env }),
      nowMs: params.nowMs,
    });
    return layer.recordSignal(params.signal);
  } catch (err) {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    params.onError?.(`cron procedural playbook memory v0: ${text}`);
    return undefined;
  }
}

function normalizeToken(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

function appendJobId(jobIds: string[], nextJobId: string): string[] {
  const trimmed = nextJobId.trim();
  if (!trimmed) {
    return jobIds.slice(0, MAX_TRACKED_JOB_IDS);
  }
  const deduped = [trimmed, ...jobIds.filter((value) => value !== trimmed)];
  return deduped.slice(0, MAX_TRACKED_JOB_IDS);
}

function clampLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return 3;
  }
  const floored = Math.floor(limit);
  if (floored <= 0) {
    return 1;
  }
  return Math.min(floored, 20);
}

function cloneEntry(value: CronProceduralPlaybookEntryV0): CronProceduralPlaybookEntryV0 {
  return {
    ...value,
    steps: [...value.steps],
    jobIds: [...value.jobIds],
  };
}

function cloneState(
  value: CronProceduralPlaybookMemoryStateV0,
): CronProceduralPlaybookMemoryStateV0 {
  const entries: Record<string, CronProceduralPlaybookEntryV0> = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    entries[key] = cloneEntry(entry);
  }
  return {
    version: 1,
    updatedAtMs: value.updatedAtMs,
    entries,
  };
}

function toState(value: unknown): CronProceduralPlaybookMemoryStateV0 | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<CronProceduralPlaybookMemoryStateV0>;
  if (raw.version !== 1) {
    return undefined;
  }
  if (typeof raw.updatedAtMs !== "number" || !Number.isFinite(raw.updatedAtMs)) {
    return undefined;
  }
  if (!raw.entries || typeof raw.entries !== "object") {
    return undefined;
  }

  const entries: Record<string, CronProceduralPlaybookEntryV0> = {};
  for (const [signature, entryRaw] of Object.entries(raw.entries)) {
    const parsed = toEntry(signature, entryRaw);
    if (parsed) {
      entries[signature] = parsed;
    }
  }

  return {
    version: 1,
    updatedAtMs: raw.updatedAtMs,
    entries,
  };
}

function toEntry(signature: string, value: unknown): CronProceduralPlaybookEntryV0 | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<CronProceduralPlaybookEntryV0>;

  if (typeof raw.signature !== "string" || raw.signature !== signature) {
    return undefined;
  }
  if (raw.sessionTarget !== "main" && raw.sessionTarget !== "isolated") {
    return undefined;
  }
  if (raw.payloadKind !== "systemEvent" && raw.payloadKind !== "agentTurn") {
    return undefined;
  }
  if (
    raw.failureKind !== "delivery-target" &&
    raw.failureKind !== "tool-validation" &&
    raw.failureKind !== "runtime-validation" &&
    raw.failureKind !== "timeout" &&
    raw.failureKind !== "unknown"
  ) {
    return undefined;
  }
  if (typeof raw.rootCause !== "string" || !Array.isArray(raw.steps) || raw.safeDefault !== true) {
    return undefined;
  }
  if (
    typeof raw.failureCount !== "number" ||
    typeof raw.successCount !== "number" ||
    typeof raw.firstSeenAtMs !== "number" ||
    typeof raw.lastSeenAtMs !== "number"
  ) {
    return undefined;
  }

  const steps = raw.steps.filter(
    (item): item is string => typeof item === "string" && Boolean(item),
  );
  const jobIds =
    Array.isArray(raw.jobIds) && raw.jobIds.length > 0
      ? raw.jobIds.filter((item): item is string => typeof item === "string" && Boolean(item))
      : [];

  return {
    signature,
    sessionTarget: raw.sessionTarget,
    payloadKind: raw.payloadKind,
    failureKind: raw.failureKind,
    rootCause: raw.rootCause,
    steps,
    safeDefault: true,
    failureCount: Math.max(0, Math.floor(raw.failureCount)),
    successCount: Math.max(0, Math.floor(raw.successCount)),
    firstSeenAtMs: raw.firstSeenAtMs,
    lastSeenAtMs: raw.lastSeenAtMs,
    lastError: typeof raw.lastError === "string" && raw.lastError ? raw.lastError : undefined,
    lastJobName:
      typeof raw.lastJobName === "string" && raw.lastJobName ? raw.lastJobName : undefined,
    jobIds: jobIds.slice(0, MAX_TRACKED_JOB_IDS),
  };
}
