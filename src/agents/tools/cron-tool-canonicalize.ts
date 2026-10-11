import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { hasNonEmptyString as isNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "../../utils.js";
import { isStringOption } from "../../utils/string-readers.js";

const CRON_SCHEDULE_KINDS = ["at", "every", "cron", "on-exit", "stream"] as const;
const CRON_PAYLOAD_KINDS = ["systemEvent", "agentTurn", "script", "command"] as const;
const CRON_FLAT_PAYLOAD_KEYS = [
  "message",
  "text",
  "script",
  "model",
  "fallbacks",
  "toolsAllow",
  "thinking",
  "timeoutSeconds",
  "toolBudget",
  "lightContext",
  "allowUnsafeExternalContent",
] as const;
const CRON_FLAT_SCHEDULE_KEYS = [
  "kind",
  "at",
  "atMs",
  "every",
  "everyMs",
  "anchorMs",
  "cron",
  "expr",
  "tz",
  "stagger",
  "staggerMs",
  "exact",
  "command",
  "cwd",
  "mode",
  "match",
  "batchMs",
  "maxBatchBytes",
] as const;
const CRON_RECOVERABLE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "declarationKey",
  "displayName",
  "owner",
  "schedule",
  "pacing",
  "trigger",
  "sessionTarget",
  "wakeMode",
  "payload",
  "delivery",
  "enabled",
  "description",
  "deleteAfterRun",
  "agentId",
  "sessionKey",
  "failureAlert",
  "namePayload",
  "scheduleKind",
  "sessionTargetName",
  ...CRON_FLAT_PAYLOAD_KEYS,
  ...CRON_FLAT_SCHEDULE_KEYS,
]);

// Only object-valued CronJobSchema fields accept dotted paths; scalar names
// such as "nightly.report" must not become nested objects.
const CRON_NESTABLE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "delivery",
  "failureAlert",
  "owner",
  "pacing",
  "payload",
  "schedule",
  "trigger",
]);

/** Path segments that would reach Object.prototype when assigned while nesting. */
const CRON_UNSAFE_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function isCronScheduleKind(value: unknown): value is (typeof CRON_SCHEDULE_KINDS)[number] {
  return isStringOption(value, CRON_SCHEDULE_KINDS);
}

function isCronPayloadKind(value: unknown): value is (typeof CRON_PAYLOAD_KINDS)[number] {
  return isStringOption(value, CRON_PAYLOAD_KINDS);
}

function isStringArrayOrNull(value: unknown): boolean {
  return (
    value === null || (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function moveDefinedField(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  from: string,
  to = from,
): boolean {
  if (source[from] === undefined) {
    return false;
  }
  target[to] = source[from];
  delete source[from];
  return true;
}

function repairConcatenatedCronToolKeys(value: Record<string, unknown>): void {
  // Some small/local tool-call parsers can return valid JSON with adjacent cron
  // key names merged. Recover only the observed schema-specific pairs before
  // strict gateway validation sees the malformed property names.
  if (!isRecord(value.payload) && isRecord(value.namePayload)) {
    value.payload = { ...value.namePayload };
  }
  const rawScheduleKind = value.scheduleKind;
  if (!isRecord(value.schedule)) {
    if (isRecord(rawScheduleKind)) {
      value.schedule = { ...rawScheduleKind };
    } else if (isCronScheduleKind(rawScheduleKind)) {
      value.schedule = { kind: rawScheduleKind };
    }
  } else if (isCronScheduleKind(rawScheduleKind) && !isCronScheduleKind(value.schedule.kind)) {
    value.schedule = { ...value.schedule, kind: rawScheduleKind };
  }
  if (!isNonEmptyString(value.name) && isNonEmptyString(value.sessionTargetName)) {
    value.name = value.sessionTargetName;
  }
  delete value.namePayload;
  delete value.scheduleKind;
  delete value.sessionTargetName;
}

function setScheduleAtMs(schedule: Record<string, unknown>, value: unknown): void {
  const atMs = typeof value === "number" ? value : Number(value);
  // Invalid/out-of-range timestamps stay raw so cron gateway validation reports the user error.
  schedule.at = Number.isFinite(atMs) ? (timestampMsToIsoString(Math.floor(atMs)) ?? value) : value;
  if (!isCronScheduleKind(schedule.kind)) {
    schedule.kind = "at";
  }
}

function canonicalizeCronToolSchedule(value: Record<string, unknown>): void {
  const schedule = isRecord(value.schedule) ? { ...value.schedule } : {};

  if (schedule.atMs !== undefined) {
    setScheduleAtMs(schedule, schedule.atMs);
    delete schedule.atMs;
  }
  for (const [from, to] of [
    ["every", "everyMs"],
    ["cron", "expr"],
    ["stagger", "staggerMs"],
  ] as const) {
    if (schedule[to] === undefined) {
      moveDefinedField(schedule, schedule, from, to);
    }
  }
  if (schedule.exact === true && schedule.staggerMs === undefined) {
    schedule.staggerMs = 0;
  }
  delete schedule.exact;

  if (isCronScheduleKind(value.kind) && !isCronScheduleKind(schedule.kind)) {
    schedule.kind = value.kind;
    delete value.kind;
  }

  const movedAt = moveDefinedField(value, schedule, "at");
  if (movedAt && !isCronScheduleKind(schedule.kind)) {
    schedule.kind = "at";
  }

  if (value.atMs !== undefined) {
    setScheduleAtMs(schedule, value.atMs);
    delete value.atMs;
  }

  for (const [kind, target, sources] of [
    ["every", "everyMs", ["everyMs", "every"]],
    ["cron", "expr", ["cron", "expr"]],
    ["on-exit", "command", ["command"]],
  ] as const) {
    // Consume only the first alias; conflicting fields remain for Gateway validation.
    const moved = sources.some((source) => moveDefinedField(value, schedule, source, target));
    if (moved && !isCronScheduleKind(schedule.kind)) {
      schedule.kind = kind;
    }
  }

  for (const key of [
    "anchorMs",
    "tz",
    "staggerMs",
    "cwd",
    "mode",
    "match",
    "batchMs",
    "maxBatchBytes",
  ] as const) {
    moveDefinedField(value, schedule, key);
  }
  moveDefinedField(value, schedule, "stagger", "staggerMs");

  if (value.exact === true && schedule.staggerMs === undefined) {
    schedule.staggerMs = 0;
  }
  delete value.exact;

  if (!isCronScheduleKind(schedule.kind)) {
    if (schedule.at !== undefined) {
      schedule.kind = "at";
    } else if (schedule.everyMs !== undefined) {
      schedule.kind = "every";
    } else if (schedule.expr !== undefined) {
      schedule.kind = "cron";
    } else if (schedule.command !== undefined) {
      schedule.kind = "on-exit";
    }
  }

  if (isRecord(value.schedule) || Object.keys(schedule).length > 0) {
    value.schedule = schedule;
  }
}

function canonicalizeCronToolPayload(value: Record<string, unknown>): void {
  const payload = isRecord(value.payload) ? { ...value.payload } : {};

  for (const key of CRON_FLAT_PAYLOAD_KEYS) {
    moveDefinedField(value, payload, key);
  }

  if (isCronPayloadKind(value.kind) && !isCronPayloadKind(payload.kind)) {
    payload.kind = value.kind;
    delete value.kind;
  }

  if (!isCronPayloadKind(payload.kind)) {
    if (isNonEmptyString(payload.script)) {
      payload.kind = "script";
    } else {
      // Timeout alone inherits the stored kind; text+timeout is an agent prompt shorthand.
      const hasAgentTurnSignal =
        isNonEmptyString(payload.message) ||
        isNonEmptyString(payload.model) ||
        payload.model === null ||
        isNonEmptyString(payload.thinking) ||
        (typeof payload.timeoutSeconds === "number" && isNonEmptyString(payload.text)) ||
        typeof payload.lightContext === "boolean" ||
        typeof payload.allowUnsafeExternalContent === "boolean" ||
        (payload.fallbacks !== undefined && isStringArrayOrNull(payload.fallbacks));
      if (hasAgentTurnSignal) {
        payload.kind = "agentTurn";
      } else if (isNonEmptyString(payload.text)) {
        payload.kind = "systemEvent";
      }
    }
  }

  if (isRecord(value.payload) || Object.keys(payload).length > 0) {
    value.payload = payload;
  }
}

// Repair only recognized padded keys; keep canonical/padded conflicts for Gateway rejection.
function repairPaddedCronKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    const trimmed = key.trim();
    if (trimmed !== key && CRON_RECOVERABLE_OBJECT_KEYS.has(trimmed) && !(trimmed in value)) {
      value[trimmed] = value[key];
      delete value[key];
    }
  }
}

// Strip only paired quotes around the whole dotted key, before splitting it.
function stripCronKeyQuotes(segment: string): string {
  if (segment.length >= 2) {
    const first = segment[0];
    if ((first === '"' || first === "'") && segment.endsWith(first)) {
      return segment.slice(1, -1);
    }
  }
  return segment;
}

// Recover dotted fields without overwriting canonical objects or hiding conflicts.
function nestDottedCronKey(
  value: Record<string, unknown>,
  key: string,
  entry: unknown,
  canonicalRoots: ReadonlySet<string>,
): "recovered" | "conflict" | "ignored" {
  const segments = stripCronKeyQuotes(key.trim())
    .split(".")
    .map((segment) => segment.trim());
  if (segments[0] === "job") {
    segments.shift();
  }
  const [root, ...rest] = segments;
  if (rest.length === 0 || !root || !CRON_NESTABLE_OBJECT_KEYS.has(root)) {
    return "ignored";
  }
  if (segments.some((segment) => !segment || CRON_UNSAFE_KEY_SEGMENTS.has(segment))) {
    return "ignored";
  }
  let cursor = value;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment in cursor) {
      if (last) {
        return "conflict";
      }
      const child = cursor[segment];
      if (!isRecord(child)) {
        return "conflict";
      }
      // Drop keys shadowed by explicit canonical objects. Newly recovered
      // objects still accept sibling dotted fields from this pass.
      if (canonicalRoots.has(root)) {
        return "recovered";
      }
      cursor = child;
      continue;
    }
    if (last) {
      cursor[segment] = entry;
      return "recovered";
    }
    const child: Record<string, unknown> = {};
    cursor[segment] = child;
    cursor = child;
  }
  return "recovered";
}

/** Converts model-friendly cron tool shorthands into the nested gateway job/patch shape. */
export function canonicalizeCronToolObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const unwrapped = isRecord(value.data) ? value.data : isRecord(value.job) ? value.job : value;
  const next = { ...unwrapped };
  repairPaddedCronKeys(next);
  repairConcatenatedCronToolKeys(next);
  canonicalizeCronToolSchedule(next);
  canonicalizeCronToolPayload(next);
  return next;
}

// cron.add accepts these nulls, and a null sessionKey intentionally suppresses
// default creator-session binding on create.
const CRON_CREATE_NULLABLE_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["agentId", "sessionKey"]);

function deleteNullFields(record: Record<string, unknown>, keep?: ReadonlySet<string>): void {
  for (const [key, entry] of Object.entries(record)) {
    if (entry === null && !keep?.has(key)) {
      delete record[key];
    } else if (isRecord(entry)) {
      deleteNullFields(entry);
    }
  }
}

/**
 * Drops null-valued fields from a create job in place. The model-facing job
 * schema is shared with update, where null means "clear this field"; on create
 * there is nothing to clear, and the strict gateway cron.add contract rejects
 * the nulls its update patch accepts.
 */
export function stripCronCreateNullClears(value: Record<string, unknown>): Record<string, unknown> {
  deleteNullFields(value, CRON_CREATE_NULLABLE_TOP_LEVEL_KEYS);
  return value;
}

/** Detects recovered update patches that contain no meaningful cron fields after normalization. */
export function isEmptyRecoveredCronPatch(value: unknown): boolean {
  if (!isRecord(value)) {
    return true;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 0 ||
    (keys.length === 1 &&
      keys[0] === "payload" &&
      isRecord(value.payload) &&
      Object.keys(value.payload).length === 0)
  );
}

/** Recovers cron job or patch fields that a model flattened beside the action arguments. */
export function recoverCronObjectFromFlatParams(params: Record<string, unknown>): {
  found: boolean;
  value: Record<string, unknown>;
} {
  const value: Record<string, unknown> = {};
  for (const key of Object.keys(params)) {
    if (CRON_RECOVERABLE_OBJECT_KEYS.has(key) && params[key] !== undefined) {
      value[key] = params[key];
    }
  }
  // Dotted keys run as a second pass so a canonical sibling always wins,
  // whatever the key order the model happened to emit.
  const canonicalRoots = new Set(Object.keys(value));
  for (const key of Object.keys(params)) {
    if (CRON_RECOVERABLE_OBJECT_KEYS.has(key) || params[key] === undefined) {
      continue;
    }
    const outcome = nestDottedCronKey(value, key, params[key], canonicalRoots);
    if (outcome === "conflict") {
      // Ambiguous input: preserve the literal key so strict gateway validation
      // rejects the conflict instead of one value silently winning.
      value[key] = params[key];
    }
  }
  return { found: Object.keys(value).length > 0, value: canonicalizeCronToolObject(value) };
}

/** Checks whether a recovered flat object has enough schedule/payload signal to create a job. */
export function hasCronCreateSignal(value: Record<string, unknown>): boolean {
  return (
    value.schedule !== undefined ||
    value.at !== undefined ||
    value.atMs !== undefined ||
    value.everyMs !== undefined ||
    value.cron !== undefined ||
    value.expr !== undefined ||
    value.payload !== undefined ||
    value.message !== undefined ||
    value.text !== undefined
  );
}
