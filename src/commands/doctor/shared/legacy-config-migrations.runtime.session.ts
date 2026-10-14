import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseDurationMs } from "../../../cli/parse-duration.js";
import { getRecord, type LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import { moveLegacyConfigKey } from "./legacy-config-record-shared.js";

/** Match only parser-valid values that resolve to an unsafe zero-duration cutoff. */
function isZeroDuration(val: unknown): boolean {
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

function hasZeroDuration(raw: unknown, key: "pruneAfter" | "resetArchiveRetention"): boolean {
  const maintenance = getRecord(raw);
  if (!maintenance || !Object.hasOwn(maintenance, key)) {
    return false;
  }
  return isZeroDuration(maintenance[key]);
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION: LegacyConfigMigrationSpec[] = [
  {
    id: "session.canonical-aliases",
    legacyRules: [
      {
        path: ["session", "maintenance", "pruneDays"],
        message:
          'session.maintenance.pruneDays was renamed to pruneAfter. Run "openclaw doctor --fix".',
      },
      {
        path: ["session", "resetByType", "dm"],
        message: 'session.resetByType.dm was renamed to direct. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      for (const [section, legacy, canonical] of [
        ["maintenance", "pruneDays", "pruneAfter"],
        ["resetByType", "dm", "direct"],
      ] as const) {
        const owner = getRecord(session?.[section]);
        moveLegacyConfigKey(owner, legacy, canonical, `session.${section}`, changes);
      }
    },
  },
  {
    id: "session.maintenance.rotateBytes",
    legacyRules: [
      {
        path: ["session", "maintenance"],
        message:
          'session.maintenance.rotateBytes is deprecated and ignored; run "openclaw doctor --fix" to remove it.',
        match: (value) => Object.hasOwn(getRecord(value) ?? {}, "rotateBytes"),
      },
    ],
    apply: (raw, changes) => {
      const maintenance = getRecord(getRecord(raw.session)?.maintenance);
      if (!maintenance || !Object.hasOwn(maintenance, "rotateBytes")) {
        return;
      }
      delete maintenance.rotateBytes;
      changes.push("Removed deprecated session.maintenance.rotateBytes.");
    },
  },
  {
    id: "session.maintenance.zero-duration-retention",
    legacyRules: [
      {
        path: ["session", "maintenance"],
        message:
          'session.maintenance.pruneAfter is a zero duration — this causes immediate deletion of eligible stale/non-preserved session entries. Run "openclaw doctor --fix" to remove it so the documented 30d default applies.',
        match: (raw) => hasZeroDuration(raw, "pruneAfter"),
      },
      {
        path: ["session", "maintenance"],
        message:
          'session.maintenance.resetArchiveRetention is a zero duration — this causes immediate deletion of all reset transcript archives. Run "openclaw doctor --fix" to remove it so the keep-by-default archive retention applies.',
        match: (raw) => hasZeroDuration(raw, "resetArchiveRetention"),
      },
    ],
    apply: (raw, changes) => {
      const maintenance = getRecord(getRecord(raw.session)?.maintenance);
      if (!maintenance) {
        return;
      }
      for (const key of ["resetArchiveRetention", "pruneAfter"] as const) {
        if (!hasZeroDuration(maintenance, key)) {
          continue;
        }
        const label = String(maintenance[key]);
        delete maintenance[key];
        const outcome =
          key === "resetArchiveRetention"
            ? "keep-by-default archive retention applies"
            : "30d session-pruning default applies";
        changes.push(`Removed session.maintenance.${key} "${label}" (zero duration); ${outcome}.`);
      }
    },
  },
];
