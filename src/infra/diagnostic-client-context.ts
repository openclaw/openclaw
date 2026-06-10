import { isBlockedObjectKey } from "./prototype-keys.js";

/**
 * Bounds for an opaque, caller-supplied diagnostic context bag. A gateway client
 * (e.g. an upstream orchestrator) can attach a small JSON object to a run; it is
 * carried verbatim onto diagnostic events for plugins to interpret. Core never
 * inspects the contents — these caps only protect the event stream and
 * prompt-cache determinism from unbounded or hostile input.
 */
export const CLIENT_CONTEXT_MAX_DEPTH = 4;
export const CLIENT_CONTEXT_MAX_KEYS = 64;
export const CLIENT_CONTEXT_MAX_BYTES = 8192;

export type DiagnosticJsonPrimitive = string | number | boolean | null;
export type DiagnosticJsonValue =
  | DiagnosticJsonPrimitive
  | DiagnosticJsonValue[]
  | { [key: string]: DiagnosticJsonValue };
export type DiagnosticClientContext = Readonly<{ [key: string]: DiagnosticJsonValue }>;

type KeyBudget = { count: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively validate + copy a value into a JSON-only shape. Returns `undefined`
 * to reject the entire bag (null is a valid value and is distinct from this
 * reject signal). Object keys are sorted for deterministic serialization, and
 * prototype-polluting keys are dropped.
 */
function normalizeValue(
  value: unknown,
  depth: number,
  budget: KeyBudget,
): DiagnosticJsonValue | undefined {
  if (value === null) {
    return null;
  }
  const valueType = typeof value;
  if (valueType === "string") {
    return value as string;
  }
  if (valueType === "boolean") {
    return value as boolean;
  }
  if (valueType === "number") {
    return Number.isFinite(value) ? (value as number) : undefined;
  }

  if (Array.isArray(value)) {
    if (depth >= CLIENT_CONTEXT_MAX_DEPTH) {
      return undefined;
    }
    const out: DiagnosticJsonValue[] = [];
    for (const item of value) {
      budget.count += 1;
      if (budget.count > CLIENT_CONTEXT_MAX_KEYS) {
        return undefined;
      }
      const normalized = normalizeValue(item, depth + 1, budget);
      if (normalized === undefined) {
        return undefined;
      }
      out.push(normalized);
    }
    return out;
  }

  if (isPlainObject(value)) {
    if (depth >= CLIENT_CONTEXT_MAX_DEPTH) {
      return undefined;
    }
    const out: Record<string, DiagnosticJsonValue> = {};
    for (const key of Object.keys(value).toSorted()) {
      if (isBlockedObjectKey(key)) {
        continue;
      }
      budget.count += 1;
      if (budget.count > CLIENT_CONTEXT_MAX_KEYS) {
        return undefined;
      }
      const normalized = normalizeValue(value[key], depth + 1, budget);
      if (normalized === undefined) {
        return undefined;
      }
      out[key] = normalized;
    }
    return out;
  }

  // function / undefined / symbol / bigint — not JSON-serializable.
  return undefined;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Normalize a caller-supplied context bag into a bounded, deterministic,
 * frozen JSON object, or `undefined` when the input is not a usable object or
 * exceeds the size/depth/key caps. The whole bag is dropped rather than
 * truncated mid-structure, so consumers never see a partial bag.
 */
export function normalizeDiagnosticClientContext(
  input: unknown,
): DiagnosticClientContext | undefined {
  if (!isPlainObject(input)) {
    return undefined;
  }
  const normalized = normalizeValue(input, 0, { count: 0 });
  if (!isPlainObject(normalized)) {
    return undefined;
  }
  if (Object.keys(normalized).length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > CLIENT_CONTEXT_MAX_BYTES) {
    return undefined;
  }
  return deepFreeze(normalized) as DiagnosticClientContext;
}

/**
 * Retained attribution bags, keyed by the run's unique `runId`. A runId — unlike
 * a session id/key — is never reused, so a run's `model.call` spans resolve their
 * own seed even while a sibling run for the same session is concurrently active.
 * Insertion-ordered eviction bounds memory: a long-lived gateway process retains
 * at most the most-recent {@link MAX_RETAINED_RUN_CLIENT_CONTEXTS} runs without
 * needing explicit per-run teardown.
 */
const MAX_RETAINED_RUN_CLIENT_CONTEXTS = 1024;
const runClientContexts = new Map<string, DiagnosticClientContext>();

/**
 * Seed (or clear) the attribution bag for a single run. Passing `undefined`
 * removes any entry, so a reused runId slot never resolves a stale bag.
 */
export function setDiagnosticRunClientContext(
  runId: string,
  clientContext: DiagnosticClientContext | undefined,
): void {
  if (!clientContext) {
    runClientContexts.delete(runId);
    return;
  }
  // Refresh insertion order so the most-recently-seeded run survives eviction.
  runClientContexts.delete(runId);
  runClientContexts.set(runId, clientContext);
  while (runClientContexts.size > MAX_RETAINED_RUN_CLIENT_CONTEXTS) {
    const oldest = runClientContexts.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    runClientContexts.delete(oldest);
  }
}

/** Resolve the attribution bag seeded for a run, or `undefined` when none. */
export function getDiagnosticRunClientContext(runId: string): DiagnosticClientContext | undefined {
  return runClientContexts.get(runId);
}

/** Test-only: drop all retained run attribution bags. */
export function resetDiagnosticRunClientContextForTest(): void {
  runClientContexts.clear();
}
