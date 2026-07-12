// Legacy session runtime config migrations for retired maintenance/fork sizing keys.
import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseDurationMs } from "../../../cli/parse-duration.js";
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

function hasLegacyRotateBytes(value: unknown): boolean {
  const maintenance = getRecord(value);
  return Boolean(maintenance && Object.hasOwn(maintenance, "rotateBytes"));
}

function hasLegacyParentForkMaxTokens(value: unknown): boolean {
  const session = getRecord(value);
  return Boolean(session && Object.hasOwn(session, "parentForkMaxTokens"));
}

/** Returns `true` when `val` normalizes to a string that `parseDurationMs` evaluates to ≤ 0. */
function parseZeroDuration(val: unknown): boolean {
  if (val === false) {
    return false;
  }
  const normalized = normalizeStringifiedOptionalString(val);
  if (!normalized) {
    return false;
  }
  try {
    return parseDurationMs(normalized, { defaultUnit: "d" }) <= 0;
  } catch {
    return false;
  }
}

/** Returns `true` when `resetArchiveRetention` or `pruneAfter` evaluates to ≤ 0. */
function isZeroDurationResetArchiveRetention(raw: unknown): boolean {
  const maintenance = getRecord(raw);
  if (!maintenance) {
    return false;
  }
  if (
    Object.hasOwn(maintenance, "resetArchiveRetention") &&
    parseZeroDuration(maintenance.resetArchiveRetention)
  ) {
    return true;
  }
  if (Object.hasOwn(maintenance, "pruneAfter") && parseZeroDuration(maintenance.pruneAfter)) {
    return true;
  }
  return false;
}

const LEGACY_SESSION_MAINTENANCE_ROTATE_BYTES_RULE: LegacyConfigRule = {
  path: ["session", "maintenance"],
  message:
    'session.maintenance.rotateBytes is deprecated and ignored; run "openclaw doctor --fix" to remove it.',
  match: hasLegacyRotateBytes,
};

const LEGACY_SESSION_PARENT_FORK_MAX_TOKENS_RULE: LegacyConfigRule = {
  path: ["session"],
  message:
    'session.parentForkMaxTokens was removed; parent fork sizing is automatic. Run "openclaw doctor --fix" to remove it.',
  match: hasLegacyParentForkMaxTokens,
};

const SESSION_MAINTENANCE_RESET_ARCHIVE_RETENTION_ZERO_RULE: LegacyConfigRule = {
  path: ["session", "maintenance"],
  message:
    'session.maintenance.resetArchiveRetention is a zero duration — this causes immediate deletion of all reset transcript archives. Run "openclaw doctor --fix" to remove it so the documented pruneAfter default applies.',
  match: isZeroDurationResetArchiveRetention,
};

/** Legacy config migration specs for session runtime config compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "session.maintenance.rotateBytes",
    describe: "Remove deprecated session.maintenance.rotateBytes",
    legacyRules: [LEGACY_SESSION_MAINTENANCE_ROTATE_BYTES_RULE],
    apply: (raw, changes) => {
      const maintenance = getRecord(getRecord(raw.session)?.maintenance);
      if (!maintenance || !Object.hasOwn(maintenance, "rotateBytes")) {
        return;
      }
      delete maintenance.rotateBytes;
      changes.push("Removed deprecated session.maintenance.rotateBytes.");
    },
  }),
  defineLegacyConfigMigration({
    id: "session.parentForkMaxTokens",
    describe: "Remove legacy session.parentForkMaxTokens",
    legacyRules: [LEGACY_SESSION_PARENT_FORK_MAX_TOKENS_RULE],
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (!session || !Object.hasOwn(session, "parentForkMaxTokens")) {
        return;
      }
      delete session.parentForkMaxTokens;
      changes.push("Removed session.parentForkMaxTokens; parent fork sizing is automatic.");
    },
  }),
  defineLegacyConfigMigration({
    id: "session.maintenance.resetArchiveRetention-zero",
    describe:
      "Remove zero-duration session.maintenance.resetArchiveRetention so the documented pruneAfter default applies",
    legacyRules: [SESSION_MAINTENANCE_RESET_ARCHIVE_RETENTION_ZERO_RULE],
    apply: (raw, changes) => {
      const maintenance = getRecord(getRecord(raw.session)?.maintenance);
      if (!maintenance) {
        return;
      }
      for (const key of ["resetArchiveRetention", "pruneAfter"] as const) {
        if (!Object.hasOwn(maintenance, key)) {
          continue;
        }
        const val = maintenance[key];
        const normalized = normalizeStringifiedOptionalString(val);
        if (!normalized) {
          continue;
        }
        let ms: number;
        try {
          ms = parseDurationMs(normalized, { defaultUnit: "d" });
        } catch {
          continue;
        }
        if (ms > 0) {
          continue;
        }
        delete maintenance[key];
        const label = typeof val === "number" ? String(val) : val;
        const fieldPath =
          key === "resetArchiveRetention"
            ? "session.maintenance.resetArchiveRetention"
            : "session.maintenance.pruneAfter";
        changes.push(
          `Removed ${fieldPath} "${label}" (zero duration); documented pruneAfter default applies.`,
        );
      }
    },
  }),
];
