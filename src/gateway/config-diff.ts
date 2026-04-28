const MAX_DIFF_DEPTH = 4;

const SENSITIVE_KEY_PATTERNS = ["key", "token", "secret", "password", "credential"];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function redactIfSensitive(key: string, value: unknown): unknown {
  return isSensitiveKey(key) ? "[redacted]" : value;
}

export type ConfigDiffEntryType = "added" | "removed" | "changed";

export type ConfigDiffEntry = {
  path: string;
  type: ConfigDiffEntryType;
  before?: unknown;
  after?: unknown;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectDiff(
  before: unknown,
  after: unknown,
  path: string,
  depth: number,
  entries: ConfigDiffEntry[],
): void {
  if (depth >= MAX_DIFF_DEPTH) {
    // At max depth, treat any inequality as a single changed entry.
    if (before !== after) {
      entries.push({ path, type: "changed", before, after });
    }
    return;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of allKeys) {
      const childPath = path ? `${path}.${key}` : key;
      const hasInBefore = Object.hasOwn(before, key);
      const hasInAfter = Object.hasOwn(after, key);
      if (!hasInBefore) {
        entries.push({
          path: childPath,
          type: "added",
          after: redactIfSensitive(key, after[key]),
        });
      } else if (!hasInAfter) {
        entries.push({
          path: childPath,
          type: "removed",
          before: redactIfSensitive(key, before[key]),
        });
      } else {
        collectDiff(
          redactIfSensitive(key, before[key]),
          redactIfSensitive(key, after[key]),
          childPath,
          depth + 1,
          entries,
        );
      }
    }
    return;
  }

  // Primitive or array: compare by value.
  if (before !== after) {
    // For arrays or mixed types, emit a single changed entry at this path.
    entries.push({ path, type: "changed", before, after });
  }
}

/**
 * Compute a structured diff between two config objects.
 * Sensitive keys are redacted. Diff is capped at MAX_DIFF_DEPTH levels.
 */
export function diffConfigs(before: unknown, after: unknown): ConfigDiffEntry[] {
  const entries: ConfigDiffEntry[] = [];
  collectDiff(before, after, "", 0, entries);
  return entries;
}
