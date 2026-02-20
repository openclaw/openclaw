import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "../infra/json-files.js";
import { safeEqualSecret } from "../security/secret-equal.js";

const TOOL_INTERRUPTS_FILE_VERSION = 2;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_INTERRUPT_TIMEOUT_MS = 1_000;
const MAX_INTERRUPT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_STORED_INTERRUPTS = 2_000;
const SETTLED_PENDING_GRACE_MS = 15_000;
const RESUMED_RECORD_RETENTION_MS = 15 * 60 * 1000;
const EXPIRED_RECORD_RETENTION_MS = 15 * 60 * 1000;

export type ToolInterruptBinding = {
  approvalRequestId: string;
  runId: string;
  sessionKey: string;
  toolCallId: string;
};

type StoredToolInterruptRecord = ToolInterruptBinding & {
  interrupt: Record<string, unknown>;
  toolName?: string;
  normalizedArgsHash?: string;
  createdAtMs: number;
  expiresAtMs: number;
  resumeToken?: string;
  resumeTokenHash: string;
  resumedAtMs?: number;
  resumedBy?: string | null;
  decisionReason?: string | null;
  policyRuleId?: string | null;
  decisionAtMs?: number;
  decisionMeta?: Record<string, unknown>;
  resumedResult?: unknown;
  expiredAtMs?: number;
};

type ToolInterruptsFile = {
  version: number;
  interrupts: Record<string, StoredToolInterruptRecord>;
};

export type ToolInterruptRequested = ToolInterruptBinding & {
  interrupt: Record<string, unknown>;
  createdAtMs: number;
  expiresAtMs: number;
  resumeToken: string;
};

export type ToolInterruptPendingSnapshot = ToolInterruptBinding & {
  interrupt: Record<string, unknown>;
  toolName?: string;
  normalizedArgsHash?: string;
  createdAtMs: number;
  expiresAtMs: number;
  resumeToken: string;
};

export type ToolInterruptWaitResult =
  | (ToolInterruptBinding & {
      status: "resumed";
      resumedAtMs: number;
      resumedBy: string | null;
      result: unknown;
    })
  | (ToolInterruptBinding & {
      status: "expired";
      expiresAtMs: number;
    });

export type ToolInterruptResumeResult =
  | {
      ok: true;
      alreadyResolved: boolean;
      waitResult: Extract<ToolInterruptWaitResult, { status: "resumed" }>;
    }
  | {
      ok: false;
      code: "not_found" | "binding_mismatch" | "already_resumed" | "expired" | "invalid_token";
      message: string;
    };

export type ToolInterruptEmitResult = {
  created: boolean;
  requested: ToolInterruptRequested;
  wait: Promise<ToolInterruptWaitResult>;
};

type PendingInterruptEntry = {
  record: StoredToolInterruptRecord;
  promise: Promise<ToolInterruptWaitResult>;
  resolve: (result: ToolInterruptWaitResult) => void;
  timer: NodeJS.Timeout;
  settled: ToolInterruptWaitResult | null;
};

function resolveDefaultInterruptsPath() {
  const stateDir = resolveStateDir(process.env);
  return path.join(stateDir, "gateway", "tool-interrupts.json");
}

function hashResumeToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function mintResumeToken() {
  return randomBytes(32).toString("base64url");
}

function normalizeTimeoutMs(timeoutMs: number | undefined) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_INTERRUPT_TIMEOUT_MS;
  }
  const rounded = Math.floor(timeoutMs);
  return Math.max(MIN_INTERRUPT_TIMEOUT_MS, Math.min(MAX_INTERRUPT_TIMEOUT_MS, rounded));
}

function sameBinding(a: ToolInterruptBinding, b: ToolInterruptBinding) {
  return (
    a.approvalRequestId === b.approvalRequestId &&
    a.runId === b.runId &&
    a.sessionKey === b.sessionKey &&
    a.toolCallId === b.toolCallId
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseStoredRecord(value: unknown): StoredToolInterruptRecord | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  if (typeof record.approvalRequestId !== "string" || !record.approvalRequestId.trim()) {
    return null;
  }
  if (typeof record.runId !== "string" || !record.runId.trim()) {
    return null;
  }
  if (typeof record.sessionKey !== "string" || !record.sessionKey.trim()) {
    return null;
  }
  if (typeof record.toolCallId !== "string" || !record.toolCallId.trim()) {
    return null;
  }
  if (typeof record.createdAtMs !== "number" || !Number.isFinite(record.createdAtMs)) {
    return null;
  }
  if (typeof record.expiresAtMs !== "number" || !Number.isFinite(record.expiresAtMs)) {
    return null;
  }
  const resumeTokenRaw = typeof record.resumeToken === "string" ? record.resumeToken.trim() : "";
  const resumeTokenHashRaw =
    typeof record.resumeTokenHash === "string" ? record.resumeTokenHash.trim() : "";
  const resumeTokenHash =
    resumeTokenHashRaw || (resumeTokenRaw ? hashResumeToken(resumeTokenRaw) : "");
  if (!resumeTokenHash) {
    return null;
  }
  const interrupt = asRecord(record.interrupt);
  if (!interrupt) {
    return null;
  }
  const resumedAtMs =
    typeof record.resumedAtMs === "number" && Number.isFinite(record.resumedAtMs)
      ? record.resumedAtMs
      : undefined;
  const expiredAtMs =
    typeof record.expiredAtMs === "number" && Number.isFinite(record.expiredAtMs)
      ? record.expiredAtMs
      : undefined;

  const resumedResult = (record as { resumedResult?: unknown }).resumedResult;
  const decisionMeta = asRecord((record as { decisionMeta?: unknown }).decisionMeta);

  return {
    approvalRequestId: record.approvalRequestId.trim(),
    runId: record.runId.trim(),
    sessionKey: record.sessionKey.trim(),
    toolCallId: record.toolCallId.trim(),
    interrupt: { ...interrupt },
    toolName:
      typeof record.toolName === "string" && record.toolName.trim()
        ? record.toolName.trim()
        : undefined,
    normalizedArgsHash:
      typeof record.normalizedArgsHash === "string" &&
      /^[a-f0-9]{64}$/.test(record.normalizedArgsHash)
        ? record.normalizedArgsHash
        : undefined,
    createdAtMs: Math.floor(record.createdAtMs),
    expiresAtMs: Math.floor(record.expiresAtMs),
    resumeToken: resumeTokenRaw || undefined,
    resumeTokenHash,
    resumedAtMs: resumedAtMs ? Math.floor(resumedAtMs) : undefined,
    resumedBy:
      typeof record.resumedBy === "string" || record.resumedBy === null
        ? record.resumedBy
        : undefined,
    decisionReason:
      typeof record.decisionReason === "string" || record.decisionReason === null
        ? record.decisionReason
        : undefined,
    policyRuleId:
      typeof record.policyRuleId === "string" || record.policyRuleId === null
        ? record.policyRuleId
        : undefined,
    decisionAtMs:
      typeof record.decisionAtMs === "number" && Number.isFinite(record.decisionAtMs)
        ? Math.floor(record.decisionAtMs)
        : undefined,
    decisionMeta: decisionMeta ? { ...decisionMeta } : undefined,
    resumedResult,
    expiredAtMs: expiredAtMs ? Math.floor(expiredAtMs) : undefined,
  };
}

export type ToolInterruptManagerOptions = {
  filePath?: string;
  nowMs?: () => number;
};

export class ToolInterruptManager {
  private readonly filePath: string;
  private readonly nowMs: () => number;
  private readonly withLock = createAsyncLock();
  private records = new Map<string, StoredToolInterruptRecord>();
  private pending = new Map<string, PendingInterruptEntry>();

  constructor(options: ToolInterruptManagerOptions = {}) {
    this.filePath = options.filePath ?? resolveDefaultInterruptsPath();
    this.nowMs = options.nowMs ?? Date.now;
  }

  async load(): Promise<void> {
    await this.withLock(async () => {
      this.clearPendingEntries();
      const parsed = await readJsonFile<ToolInterruptsFile>(this.filePath);
      const rawInterrupts = asRecord(parsed)?.interrupts;
      const nextRecords = new Map<string, StoredToolInterruptRecord>();
      const now = this.nowMs();

      if (rawInterrupts) {
        for (const raw of Object.values(rawInterrupts)) {
          const parsedRecord = parseStoredRecord(raw);
          if (!parsedRecord) {
            continue;
          }
          if (this.shouldDropRecord(parsedRecord, now)) {
            continue;
          }
          if (
            !parsedRecord.resumedAtMs &&
            !parsedRecord.expiredAtMs &&
            now >= parsedRecord.expiresAtMs
          ) {
            parsedRecord.expiredAtMs = now;
          }
          nextRecords.set(parsedRecord.approvalRequestId, parsedRecord);
          if (!parsedRecord.resumedAtMs && !parsedRecord.expiredAtMs) {
            const entry = this.createPendingEntry(parsedRecord);
            this.pending.set(parsedRecord.approvalRequestId, entry);
            this.schedulePendingTimer(entry);
          }
        }
      }

      this.records = nextRecords;
      this.pruneRecordsLocked(now);
      await this.persistLocked();
    });
  }

  stop() {
    this.clearPendingEntries();
  }

  getSnapshot(
    approvalRequestId: string,
  ): Omit<StoredToolInterruptRecord, "resumeTokenHash"> | null {
    const id = approvalRequestId.trim();
    if (!id) {
      return null;
    }
    const record = this.records.get(id);
    if (!record) {
      return null;
    }
    return {
      approvalRequestId: record.approvalRequestId,
      runId: record.runId,
      sessionKey: record.sessionKey,
      toolCallId: record.toolCallId,
      interrupt: { ...record.interrupt },
      toolName: record.toolName,
      normalizedArgsHash: record.normalizedArgsHash,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
      resumedAtMs: record.resumedAtMs,
      resumedBy: record.resumedBy,
      decisionReason: record.decisionReason,
      policyRuleId: record.policyRuleId,
      decisionAtMs: record.decisionAtMs,
      decisionMeta: record.decisionMeta ? { ...record.decisionMeta } : undefined,
      resumedResult: record.resumedResult,
      expiredAtMs: record.expiredAtMs,
    };
  }

  listPending(): ToolInterruptPendingSnapshot[] {
    const now = this.nowMs();
    const snapshots: ToolInterruptPendingSnapshot[] = [];
    for (const record of this.records.values()) {
      if (record.resumedAtMs || record.expiredAtMs || now >= record.expiresAtMs) {
        continue;
      }
      if (!record.resumeToken) {
        continue;
      }
      snapshots.push({
        approvalRequestId: record.approvalRequestId,
        runId: record.runId,
        sessionKey: record.sessionKey,
        toolCallId: record.toolCallId,
        interrupt: { ...record.interrupt },
        toolName: record.toolName,
        normalizedArgsHash: record.normalizedArgsHash,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
        resumeToken: record.resumeToken,
      });
    }
    return snapshots.toSorted((a, b) => a.createdAtMs - b.createdAtMs);
  }

  async emit(
    params: ToolInterruptBinding & {
      interrupt: Record<string, unknown>;
      timeoutMs?: number;
      toolName?: string;
      normalizedArgsHash?: string;
    },
  ) {
    const id = params.approvalRequestId.trim();
    if (!id) {
      throw new Error("approvalRequestId is required");
    }
    const binding: ToolInterruptBinding = {
      approvalRequestId: id,
      runId: params.runId.trim(),
      sessionKey: params.sessionKey.trim(),
      toolCallId: params.toolCallId.trim(),
    };
    if (!binding.runId || !binding.sessionKey || !binding.toolCallId) {
      throw new Error("runId, sessionKey, and toolCallId are required");
    }

    const timeoutMs = normalizeTimeoutMs(params.timeoutMs);
    const toolName =
      typeof params.toolName === "string" && params.toolName.trim()
        ? params.toolName.trim()
        : undefined;
    const normalizedArgsHash =
      typeof params.normalizedArgsHash === "string" &&
      /^[a-f0-9]{64}$/.test(params.normalizedArgsHash)
        ? params.normalizedArgsHash
        : undefined;
    const resumeToken = mintResumeToken();
    const resumeTokenHash = hashResumeToken(resumeToken);
    let created = false;
    let pending: PendingInterruptEntry | null = null;
    let requested: ToolInterruptRequested | null = null;

    await this.withLock(async () => {
      const now = this.nowMs();
      let record = this.records.get(binding.approvalRequestId);
      if (record && record.resumedAtMs) {
        throw new Error("interrupt already resumed");
      }
      if (record && !this.isExpiredRecord(record, now) && !sameBinding(record, binding)) {
        throw new Error("approvalRequestId is already bound to a different tool call");
      }

      if (!record || this.isExpiredRecord(record, now)) {
        created = true;
        record = {
          ...binding,
          interrupt: { ...params.interrupt },
          toolName,
          normalizedArgsHash,
          createdAtMs: now,
          expiresAtMs: now + timeoutMs,
          resumeToken,
          resumeTokenHash,
          resumedAtMs: undefined,
          resumedBy: undefined,
          expiredAtMs: undefined,
        };
        this.records.set(binding.approvalRequestId, record);
      } else {
        record.interrupt = { ...params.interrupt };
        record.toolName = toolName;
        record.normalizedArgsHash = normalizedArgsHash;
        record.expiresAtMs = now + timeoutMs;
        record.resumeToken = resumeToken;
        record.resumeTokenHash = resumeTokenHash;
        record.expiredAtMs = undefined;
      }

      const existingPending = this.pending.get(binding.approvalRequestId);
      let nextPending: PendingInterruptEntry;
      if (!existingPending || existingPending.settled) {
        nextPending = this.createPendingEntry(record);
        this.pending.set(binding.approvalRequestId, nextPending);
      } else {
        nextPending = existingPending;
        nextPending.record = record;
      }
      pending = nextPending;
      this.schedulePendingTimer(nextPending);
      this.pruneRecordsLocked(now);
      await this.persistLocked();

      requested = {
        approvalRequestId: record.approvalRequestId,
        runId: record.runId,
        sessionKey: record.sessionKey,
        toolCallId: record.toolCallId,
        interrupt: { ...record.interrupt },
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
        resumeToken,
      };
    });

    if (!pending || !requested) {
      throw new Error("failed to create tool interrupt");
    }

    const pendingEntry = pending as PendingInterruptEntry;
    const requestedEntry = requested as ToolInterruptRequested;

    return {
      created,
      requested: requestedEntry,
      wait: pendingEntry.promise,
    } satisfies ToolInterruptEmitResult;
  }

  async resume(
    params: ToolInterruptBinding & {
      resumeToken: string;
      result: unknown;
      resumedBy?: string | null;
      toolName?: string;
      normalizedArgsHash?: string;
      decisionReason?: string | null;
      policyRuleId?: string | null;
      decisionAtMs?: number;
      decisionMeta?: Record<string, unknown>;
    },
  ): Promise<ToolInterruptResumeResult> {
    const binding: ToolInterruptBinding = {
      approvalRequestId: params.approvalRequestId.trim(),
      runId: params.runId.trim(),
      sessionKey: params.sessionKey.trim(),
      toolCallId: params.toolCallId.trim(),
    };
    const resumeToken = params.resumeToken.trim();
    if (
      !binding.approvalRequestId ||
      !binding.runId ||
      !binding.sessionKey ||
      !binding.toolCallId
    ) {
      return {
        ok: false,
        code: "binding_mismatch",
        message: "run/session/tool binding is required",
      };
    }
    if (!resumeToken) {
      return { ok: false, code: "invalid_token", message: "resume token is required" };
    }

    let result: ToolInterruptResumeResult = {
      ok: false,
      code: "not_found",
      message: "unknown approvalRequestId",
    };

    await this.withLock(async () => {
      const now = this.nowMs();
      const record = this.records.get(binding.approvalRequestId);
      if (!record) {
        result = { ok: false, code: "not_found", message: "unknown approvalRequestId" };
        return;
      }
      if (!sameBinding(record, binding)) {
        result = {
          ok: false,
          code: "binding_mismatch",
          message: "interrupt binding mismatch",
        };
        return;
      }
      if (record.resumedAtMs) {
        const providedHash = hashResumeToken(resumeToken);
        if (!safeEqualSecret(providedHash, record.resumeTokenHash)) {
          result = { ok: false, code: "invalid_token", message: "invalid resume token" };
          return;
        }
        result = {
          ok: true,
          alreadyResolved: true,
          waitResult: {
            status: "resumed",
            approvalRequestId: record.approvalRequestId,
            runId: record.runId,
            sessionKey: record.sessionKey,
            toolCallId: record.toolCallId,
            resumedAtMs: record.resumedAtMs,
            resumedBy: record.resumedBy ?? null,
            result: record.resumedResult,
          },
        };
        return;
      }
      if (record.toolName || record.normalizedArgsHash) {
        const toolName = typeof params.toolName === "string" ? params.toolName.trim() : "";
        if (!record.toolName || toolName !== record.toolName) {
          result = {
            ok: false,
            code: "binding_mismatch",
            message: "interrupt tool binding mismatch",
          };
          return;
        }
        const argsHash =
          typeof params.normalizedArgsHash === "string" ? params.normalizedArgsHash : "";
        if (!record.normalizedArgsHash || argsHash !== record.normalizedArgsHash) {
          result = {
            ok: false,
            code: "binding_mismatch",
            message: "interrupt args binding mismatch",
          };
          return;
        }
      }
      if (record.expiredAtMs || now >= record.expiresAtMs) {
        record.expiredAtMs = record.expiredAtMs ?? now;
        record.resumeToken = undefined;
        this.settlePendingLocked(binding.approvalRequestId, {
          status: "expired",
          approvalRequestId: record.approvalRequestId,
          runId: record.runId,
          sessionKey: record.sessionKey,
          toolCallId: record.toolCallId,
          expiresAtMs: record.expiresAtMs,
        });
        await this.persistLocked();
        result = { ok: false, code: "expired", message: "interrupt expired" };
        return;
      }

      const providedHash = hashResumeToken(resumeToken);
      if (!safeEqualSecret(providedHash, record.resumeTokenHash)) {
        result = { ok: false, code: "invalid_token", message: "invalid resume token" };
        return;
      }

      const resumedAtMs = now;
      const waitResult: Extract<ToolInterruptWaitResult, { status: "resumed" }> = {
        status: "resumed",
        approvalRequestId: record.approvalRequestId,
        runId: record.runId,
        sessionKey: record.sessionKey,
        toolCallId: record.toolCallId,
        resumedAtMs,
        resumedBy: params.resumedBy ?? null,
        result: params.result,
      };
      record.resumedAtMs = resumedAtMs;
      record.resumeToken = undefined;
      record.resumedBy = params.resumedBy ?? null;
      record.decisionReason =
        typeof params.decisionReason === "string" || params.decisionReason === null
          ? params.decisionReason
          : undefined;
      record.policyRuleId =
        typeof params.policyRuleId === "string" || params.policyRuleId === null
          ? params.policyRuleId
          : undefined;
      record.decisionAtMs =
        typeof params.decisionAtMs === "number" && Number.isFinite(params.decisionAtMs)
          ? Math.floor(params.decisionAtMs)
          : resumedAtMs;
      record.decisionMeta = params.decisionMeta ? { ...params.decisionMeta } : undefined;
      record.resumedResult = params.result;
      this.pruneRecordsLocked(now);
      await this.persistLocked();
      this.settlePendingLocked(binding.approvalRequestId, waitResult);
      result = {
        ok: true,
        alreadyResolved: false,
        waitResult,
      };
    });

    return result;
  }

  private createPendingEntry(record: StoredToolInterruptRecord): PendingInterruptEntry {
    let resolve!: (result: ToolInterruptWaitResult) => void;
    const promise = new Promise<ToolInterruptWaitResult>((res) => {
      resolve = res;
    });
    return {
      record,
      promise,
      resolve,
      timer: setTimeout(() => {}, 0),
      settled: null,
    };
  }

  private schedulePendingTimer(entry: PendingInterruptEntry) {
    clearTimeout(entry.timer);
    const delay = Math.max(0, entry.record.expiresAtMs - this.nowMs());
    entry.timer = setTimeout(() => {
      void this.expirePending(entry.record.approvalRequestId);
    }, delay);
    entry.timer.unref?.();
  }

  private settlePendingLocked(approvalRequestId: string, waitResult: ToolInterruptWaitResult) {
    const entry = this.pending.get(approvalRequestId);
    if (!entry || entry.settled) {
      return;
    }
    clearTimeout(entry.timer);
    entry.settled = waitResult;
    entry.resolve(waitResult);
    entry.timer = setTimeout(() => {
      const current = this.pending.get(approvalRequestId);
      if (current === entry) {
        this.pending.delete(approvalRequestId);
      }
    }, SETTLED_PENDING_GRACE_MS);
    entry.timer.unref?.();
  }

  private async expirePending(approvalRequestId: string) {
    await this.withLock(async () => {
      const entry = this.pending.get(approvalRequestId);
      if (!entry || entry.settled) {
        return;
      }
      const record = this.records.get(approvalRequestId) ?? entry.record;
      const now = this.nowMs();
      if (record.resumedAtMs) {
        this.pending.delete(approvalRequestId);
        return;
      }
      if (now < record.expiresAtMs) {
        this.schedulePendingTimer(entry);
        return;
      }
      record.expiredAtMs = record.expiredAtMs ?? now;
      record.resumeToken = undefined;
      this.records.set(record.approvalRequestId, record);
      this.settlePendingLocked(approvalRequestId, {
        status: "expired",
        approvalRequestId: record.approvalRequestId,
        runId: record.runId,
        sessionKey: record.sessionKey,
        toolCallId: record.toolCallId,
        expiresAtMs: record.expiresAtMs,
      });
      this.pruneRecordsLocked(now);
      await this.persistLocked();
    });
  }

  private isExpiredRecord(record: StoredToolInterruptRecord, now: number) {
    if (record.expiredAtMs) {
      return true;
    }
    return now >= record.expiresAtMs;
  }

  private shouldDropRecord(record: StoredToolInterruptRecord, now: number) {
    if (record.resumedAtMs && now - record.resumedAtMs > RESUMED_RECORD_RETENTION_MS) {
      return true;
    }
    if (record.expiredAtMs && now - record.expiredAtMs > EXPIRED_RECORD_RETENTION_MS) {
      return true;
    }
    if (!record.resumedAtMs && now >= record.expiresAtMs + EXPIRED_RECORD_RETENTION_MS) {
      return true;
    }
    return false;
  }

  private pruneRecordsLocked(now: number) {
    for (const [id, record] of this.records) {
      if (this.shouldDropRecord(record, now)) {
        this.records.delete(id);
      }
    }
    if (this.records.size <= MAX_STORED_INTERRUPTS) {
      return;
    }
    const records = [...this.records.values()].toSorted((a, b) => {
      const aSettled = a.resumedAtMs ?? a.expiredAtMs ?? Number.POSITIVE_INFINITY;
      const bSettled = b.resumedAtMs ?? b.expiredAtMs ?? Number.POSITIVE_INFINITY;
      if (aSettled !== bSettled) {
        return aSettled - bSettled;
      }
      return a.createdAtMs - b.createdAtMs;
    });
    while (this.records.size > MAX_STORED_INTERRUPTS && records.length > 0) {
      const next = records.shift();
      if (!next) {
        break;
      }
      this.records.delete(next.approvalRequestId);
      this.pending.delete(next.approvalRequestId);
    }
  }

  private clearPendingEntries() {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }

  private async persistLocked() {
    const interrupts: Record<string, StoredToolInterruptRecord> = {};
    for (const record of this.records.values()) {
      interrupts[record.approvalRequestId] = {
        approvalRequestId: record.approvalRequestId,
        runId: record.runId,
        sessionKey: record.sessionKey,
        toolCallId: record.toolCallId,
        interrupt: { ...record.interrupt },
        toolName: record.toolName,
        normalizedArgsHash: record.normalizedArgsHash,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
        resumeToken: record.resumeToken,
        resumeTokenHash: record.resumeTokenHash,
        resumedAtMs: record.resumedAtMs,
        resumedBy: record.resumedBy,
        decisionReason: record.decisionReason,
        policyRuleId: record.policyRuleId,
        decisionAtMs: record.decisionAtMs,
        decisionMeta: record.decisionMeta ? { ...record.decisionMeta } : undefined,
        resumedResult: record.resumedResult,
        expiredAtMs: record.expiredAtMs,
      };
    }
    const payload: ToolInterruptsFile = {
      version: TOOL_INTERRUPTS_FILE_VERSION,
      interrupts,
    };
    await writeJsonAtomic(this.filePath, payload);
  }
}
