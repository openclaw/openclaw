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

type SessionMaintenanceDurationKey = "pruneAfter" | "resetArchiveRetention";

function getZeroDurationValue(raw: unknown, key: SessionMaintenanceDurationKey): string | null {
  const maintenance = getRecord(raw);
  if (!maintenance || !Object.hasOwn(maintenance, key)) {
    return null;
  }
  const normalized = normalizeStringifiedOptionalString(maintenance[key]);
  if (!normalized) {
    return null;
  }
  try {
    return parseDurationMs(normalized, { defaultUnit: "d" }) <= 0 ? normalized : null;
  } catch {
    return null;
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

const SESSION_MAINTENANCE_PRUNE_AFTER_ZERO_RULE: LegacyConfigRule = {
  path: ["session", "maintenance"],
  message:
    'session.maintenance.pruneAfter is a zero duration, which immediately deletes eligible session entries. Run "openclaw doctor --fix" to remove it so the documented 30d default applies.',
  match: (value) => getZeroDurationValue(value, "pruneAfter") !== null,
};

const SESSION_MAINTENANCE_RESET_ARCHIVE_RETENTION_ZERO_RULE: LegacyConfigRule = {
  path: ["session", "maintenance"],
  message:
    'session.maintenance.resetArchiveRetention is a zero duration, which immediately deletes reset and deleted transcript archives. Run "openclaw doctor --fix" to replace it with false and keep archives.',
  match: (value) => getZeroDurationValue(value, "resetArchiveRetention") !== null,
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
    id: "session.maintenance.zero-duration-retention",
    describe: "Repair zero-duration session maintenance retention values",
    legacyRules: [
      SESSION_MAINTENANCE_PRUNE_AFTER_ZERO_RULE,
      SESSION_MAINTENANCE_RESET_ARCHIVE_RETENTION_ZERO_RULE,
    ],
    apply: (raw, changes) => {
      const maintenance = getRecord(getRecord(raw.session)?.maintenance);
      if (!maintenance) {
        return;
      }

      const pruneAfter = getZeroDurationValue(maintenance, "pruneAfter");
      if (pruneAfter !== null) {
        delete maintenance.pruneAfter;
        changes.push(
          `Removed session.maintenance.pruneAfter "${pruneAfter}" (zero duration); documented 30d default applies.`,
        );
      }

      const resetArchiveRetention = getZeroDurationValue(maintenance, "resetArchiveRetention");
      if (resetArchiveRetention !== null) {
        // False is the canonical keep-archives setting. Deleting the field also
        // keeps archives today, but explicit false preserves operator intent.
        maintenance.resetArchiveRetention = false;
        changes.push(
          `Replaced session.maintenance.resetArchiveRetention "${resetArchiveRetention}" with false (zero duration); archives are kept.`,
        );
      }
    },
  }),
];
