// Legacy retry.jitter boolean migration: coerce boolean jitter to numeric so the
// runtime schema stays numeric-only (repo policy keeps malformed/legacy config
// repair in doctor/migration, not in the runtime zod schema). See #52130.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const RETRY_JITTER_RULE: LegacyConfigRule = {
  path: ["retry", "jitter"],
  message:
    'retry.jitter must be a number in [0, 1]; boolean values (true/false) are legacy. Run "openclaw doctor --fix" to coerce (true → 0.1, false → 0).',
  // Match root-level retry.jitter OR any nested retry.jitter (e.g.
  // channels.telegram.retry.jitter) by walking the config tree.
  match: (value, root) => {
    if (value === true || value === false) {
      return true;
    }
    return hasAnyNestedBooleanRetryJitter(root);
  },
};

/** Walk the config tree and return true if any retry.jitter is a boolean. */
function hasAnyNestedBooleanRetryJitter(node: unknown): boolean {
  const record = getRecord(node);
  if (!record) {
    return false;
  }
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (key === "retry") {
      const retry = getRecord(child);
      if (retry && (retry.jitter === true || retry.jitter === false)) {
        return true;
      }
    }
    if (hasAnyNestedBooleanRetryJitter(child)) {
      return true;
    }
  }
  return false;
}

/** Coerce a legacy boolean jitter to its numeric equivalent. */
function coerceLegacyBooleanJitter(value: unknown): number | null {
  if (value === true) {
    return 0.1;
  }
  if (value === false) {
    return 0;
  }
  return null;
}

/**
 * Recursively walk the config tree and coerce any `retry.jitter` boolean value
 * to its numeric equivalent. RetryConfigSchema is shared across providers, so
 * the migration walks the whole tree rather than pinning to one provider path.
 */
function coerceRetryJitterBooleans(node: unknown, changes: string[]): void {
  const record = getRecord(node);
  if (!record) {
    return;
  }
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (key === "retry") {
      const retry = getRecord(child);
      if (retry && (retry.jitter === true || retry.jitter === false)) {
        const coerced = coerceLegacyBooleanJitter(retry.jitter);
        if (coerced !== null) {
          retry.jitter = coerced;
          changes.push(`retry.jitter: coerced legacy boolean to ${coerced}`);
        }
      }
    }
    // Recurse into nested records to reach provider retry configs.
    coerceRetryJitterBooleans(child, changes);
  }
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETRY: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "retry-jitter-boolean",
    describe: "Coerce legacy boolean retry.jitter values (true/false) to numbers.",
    apply: (raw, changes) => {
      coerceRetryJitterBooleans(raw, changes);
    },
    legacyRules: [RETRY_JITTER_RULE],
  }),
];
