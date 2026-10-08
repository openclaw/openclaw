import { isDeepStrictEqual } from "node:util";
import { normalizeCronJobPatch } from "../../cron/normalize.js";
import { isRecord } from "../../utils.js";
import {
  canonicalizeCronToolObject,
  hasCronCreateSignal,
  isEmptyRecoveredCronPatch,
  recoverCronObjectFromFlatParams,
} from "./cron-tool-canonicalize.js";

function normalizeStringArrayHint(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  // This runs before validateToolArguments, whose array coercion would
  // otherwise decode a JSON-encoded list; wrapping it would hide that list.
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not a JSON array; treat it as a single scalar entry.
    }
  }
  return [trimmed];
}

function normalizePayloadArrayHints(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  if (Object.hasOwn(value, "toolsAllow")) {
    value.toolsAllow = normalizeStringArrayHint(value.toolsAllow);
  }
  if (Object.hasOwn(value, "fallbacks")) {
    value.fallbacks = normalizeStringArrayHint(value.fallbacks);
  }
}

function hasNestedJob(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function rejectTopLevelMode(): never {
  throw new Error(
    'Remove the top-level "mode" field and retry. "mode" is only valid for action="wake".',
  );
}

// Per-kind schedule contract. `allowed[0]` is the defining field required by
// the Gateway's complete discriminated union; `inputs` includes flat aliases.
const FLAT_SCHEDULE_FIELDS_BY_KIND: Record<
  string,
  { inputs: readonly string[]; allowed: readonly string[] }
> = {
  at: { inputs: ["at", "atMs"], allowed: ["at"] },
  every: { inputs: ["everyMs", "every"], allowed: ["everyMs", "anchorMs"] },
  cron: { inputs: ["expr", "cron"], allowed: ["expr", "tz", "staggerMs"] },
  "on-exit": { inputs: [], allowed: ["command", "cwd"] },
  stream: { inputs: [], allowed: ["command", "cwd", "mode", "match", "batchMs", "maxBatchBytes"] },
};

function assertFlatContractInvariants(
  action: "add" | "update",
  next: Record<string, unknown>,
  recovered: Record<string, unknown>,
): void {
  const schedules = Object.values(FLAT_SCHEDULE_FIELDS_BY_KIND)
    .flatMap((entry) => entry.inputs)
    .filter((key) => next[key] !== undefined);
  if (schedules.length > 1) {
    throw new Error("Send only one of at, everyMs, or expr.");
  }
  const schedule = isRecord(recovered.schedule) ? recovered.schedule : undefined;
  const kind = typeof schedule?.kind === "string" ? schedule.kind : undefined;
  const contract = kind ? FLAT_SCHEDULE_FIELDS_BY_KIND[kind] : undefined;
  if (schedule?.tz !== undefined && kind !== "cron") {
    throw new Error("tz needs expr. Put the offset in at, or drop tz.");
  }
  const mismatched = contract
    ? Object.values(FLAT_SCHEDULE_FIELDS_BY_KIND)
        .flatMap((entry) => entry.allowed)
        .filter((key) => schedule?.[key] !== undefined && !contract.allowed.includes(key))
    : [];
  if (contract && mismatched.length > 0) {
    throw new Error(`Use ${contract.allowed[0]} without ${mismatched.join(", ")}.`);
  }
  if (schedule && Object.keys(schedule).length > 0) {
    const required = contract?.allowed[0];
    if (!kind || (required && schedule[required] === undefined)) {
      throw new Error(
        action === "add"
          ? "Add expr, at, or everyMs."
          : "Send a complete expr, at, or everyMs schedule.",
      );
    }
  }
}

function assertUnambiguousPayload(job: Record<string, unknown>): void {
  if (!isRecord(job.payload)) {
    return;
  }
  const { message, text } = job.payload;
  if (
    typeof message === "string" &&
    message.trim() &&
    typeof text === "string" &&
    text.trim() &&
    message.trim() !== text.trim()
  ) {
    throw new Error("Send only text (reminder) or only message (task).");
  }
  if (job.payload.kind === "agentTurn" && typeof text === "string" && text.trim()) {
    if (typeof message !== "string" || !message.trim()) {
      job.payload.message = text;
    }
    delete job.payload.text;
  }
}

// Merge only the two canonical subobjects; arrays and other values are atomic.
// Define own data properties so literal unsafe keys survive validation without invoking setters.
function mergeFlatJob(
  nested: Record<string, unknown>,
  flat: Record<string, unknown>,
): Record<string, unknown> {
  const job = { ...nested };
  for (const [key, value] of Object.entries(flat)) {
    const existing = Object.hasOwn(job, key) ? job[key] : undefined;
    if (existing === undefined) {
      Object.defineProperty(job, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else if ((key === "schedule" || key === "payload") && isRecord(existing) && isRecord(value)) {
      const merged = { ...existing };
      for (const [field, entry] of Object.entries(value)) {
        if (
          Object.hasOwn(merged, field) &&
          merged[field] !== undefined &&
          !isDeepStrictEqual(merged[field], entry)
        ) {
          throw new Error(`${field} is set twice; keep one.`);
        }
        Object.defineProperty(merged, field, {
          value: entry,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      job[key] = merged;
    } else if (!isDeepStrictEqual(existing, value)) {
      throw new Error(`${key} is set twice; keep one.`);
    }
  }
  return job;
}

/** Normalizes recoverable cron add/update arguments before provider schema validation. */
export function prepareCronToolArguments(args: unknown): Record<string, unknown> {
  const next = isRecord(args) ? { ...args } : {};
  if (next.action !== "add" && next.action !== "update") {
    return next;
  }
  if (typeof next.job === "string") {
    try {
      const decoded: unknown = JSON.parse(next.job);
      if (isRecord(decoded)) {
        next.job = decoded;
      }
    } catch {
      // Weak models also send junk job strings; retain ordinary flat recovery.
    }
  }
  const nestedJob = hasNestedJob(next.job) ? next.job : undefined;
  const hasTopLevelMode = Object.hasOwn(next, "mode");
  if (nestedJob && hasTopLevelMode) {
    rejectTopLevelMode();
  }

  for (const key of ["toolsAllow", "fallbacks"] as const) {
    if (Object.hasOwn(next, key)) {
      next[key] = normalizeStringArrayHint(next[key]);
    }
  }

  const recovered = recoverCronObjectFromFlatParams(next, next.action !== "update");
  normalizePayloadArrayHints(recovered.value.payload);
  if (nestedJob) {
    const job = canonicalizeCronToolObject(nestedJob, next.action !== "update");
    normalizePayloadArrayHints(job.payload);
    // A text alias can fill an explicit task prompt, but must not change its kind.
    if (
      isRecord(job.payload) &&
      isRecord(recovered.value.payload) &&
      job.payload.kind === "agentTurn" &&
      recovered.value.payload.kind === "systemEvent" &&
      next.kind === undefined &&
      (!isRecord(next.payload) || next.payload.kind === undefined)
    ) {
      delete recovered.value.payload.kind;
    }
    const merged = mergeFlatJob(job, recovered.value);
    assertUnambiguousPayload(merged);
    assertFlatContractInvariants(next.action, next, merged);
    next.job = merged;
    return next;
  }

  if (hasTopLevelMode) {
    const schedule = isRecord(recovered.value.schedule) ? recovered.value.schedule : undefined;
    if (schedule?.kind !== "stream") {
      rejectTopLevelMode();
    }
    // `mode` is already copied into the recovered stream schedule. Remove the
    // wake-only top-level field before provider validation sees its wake enum.
    delete next.mode;
  }

  assertUnambiguousPayload(recovered.value);
  assertFlatContractInvariants(next.action, next, recovered.value);

  if (!recovered.found) {
    return next;
  }
  normalizePayloadArrayHints(recovered.value.payload);
  if (next.action === "add" && !hasCronCreateSignal(recovered.value)) {
    return next;
  }
  if (
    next.action === "add" &&
    recovered.value.payload !== undefined &&
    recovered.value.schedule === undefined
  ) {
    throw new Error("Add expr, at, or everyMs.");
  }
  if (next.action === "update") {
    const normalizedPatch = normalizeCronJobPatch(recovered.value) ?? recovered.value;
    if (isEmptyRecoveredCronPatch(normalizedPatch)) {
      return next;
    }
  }
  next.job = recovered.value;
  return next;
}
