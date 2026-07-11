// Legacy session runtime config migrations for retired maintenance/fork sizing keys.
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

/** Returns `true` when `resetArchiveRetention` is a string that `parseDurationMs` evaluates to ≤ 0. */
function isZeroDurationResetArchiveRetention(raw: unknown): boolean {
  const maintenance = getRecord(raw);
  if (!maintenance || !Object.hasOwn(maintenance, "resetArchiveRetention")) {
    return false;
  }
  const val = maintenance.resetArchiveRetention;
  if (typeof val !== "string") {
    return false;
  }
  try {
    const ms = parseDurationMs(val, { defaultUnit: "d" });
    return ms <= 0;
  } catch {
    return false;
  }
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
      if (!maintenance || !Object.hasOwn(maintenance, "resetArchiveRetention")) {
        return;
      }
      const val = maintenance.resetArchiveRetention;
      if (val === false) {
        return;
      }
      if (typeof val !== "string") {
        return;
      }
      let ms: number;
      try {
        ms = parseDurationMs(val, { defaultUnit: "d" });
      } catch {
        return;
      }
      if (ms > 0) {
        return;
      }
      delete maintenance.resetArchiveRetention;
      changes.push(
        `Removed session.maintenance.resetArchiveRetention "${val}" (zero duration); documented pruneAfter default applies.`,
      );
    },
  }),
];
