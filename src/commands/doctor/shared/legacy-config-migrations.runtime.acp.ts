import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const LEGACY_ACP_STREAM_RULES: LegacyConfigRule[] = [
  {
    path: ["acp", "stream", "maxTurnChars"],
    message:
      "acp.stream.maxTurnChars was renamed; use acp.stream.maxOutputChars instead (auto-migrated or removed on load).",
  },
  {
    path: ["acp", "stream", "maxToolSummaryChars"],
    message:
      "acp.stream.maxToolSummaryChars was renamed; use acp.stream.maxSessionUpdateChars instead (auto-migrated or removed on load).",
  },
  {
    path: ["acp", "stream", "maxStatusChars"],
    message: "acp.stream.maxStatusChars was removed with no replacement (auto-removed on load).",
  },
  {
    path: ["acp", "stream", "maxMetaEventsPerTurn"],
    message:
      "acp.stream.maxMetaEventsPerTurn was removed with no replacement (auto-removed on load).",
  },
  {
    path: ["acp", "stream", "metaMode"],
    message: "acp.stream.metaMode was removed with no replacement (auto-removed on load).",
  },
  {
    path: ["acp", "stream", "showUsage"],
    message: "acp.stream.showUsage was removed with no replacement (auto-removed on load).",
  },
];

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function migrateLegacyAcpStream(stream: Record<string, unknown>, changes: string[]): void {
  if (hasOwn(stream, "maxTurnChars")) {
    if (isPositiveInteger(stream.maxTurnChars) && stream.maxOutputChars === undefined) {
      stream.maxOutputChars = stream.maxTurnChars;
      changes.push("Moved acp.stream.maxTurnChars → acp.stream.maxOutputChars.");
    } else if (stream.maxOutputChars !== undefined) {
      changes.push("Removed acp.stream.maxTurnChars (acp.stream.maxOutputChars already set).");
    } else {
      changes.push("Removed acp.stream.maxTurnChars (legacy value was not a positive integer).");
    }
    delete stream.maxTurnChars;
  }

  if (hasOwn(stream, "maxToolSummaryChars")) {
    if (
      isPositiveInteger(stream.maxToolSummaryChars) &&
      stream.maxSessionUpdateChars === undefined
    ) {
      stream.maxSessionUpdateChars = stream.maxToolSummaryChars;
      changes.push("Moved acp.stream.maxToolSummaryChars → acp.stream.maxSessionUpdateChars.");
    } else if (stream.maxSessionUpdateChars !== undefined) {
      changes.push(
        "Removed acp.stream.maxToolSummaryChars (acp.stream.maxSessionUpdateChars already set).",
      );
    } else {
      changes.push(
        "Removed acp.stream.maxToolSummaryChars (legacy value was not a positive integer).",
      );
    }
    delete stream.maxToolSummaryChars;
  }

  for (const key of ["maxStatusChars", "maxMetaEventsPerTurn", "metaMode", "showUsage"] as const) {
    if (!hasOwn(stream, key)) {
      continue;
    }
    delete stream[key];
    changes.push(`Removed acp.stream.${key} (no replacement).`);
  }
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_ACP: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "acp.stream-v2026.3.2-keys",
    describe: "Migrate removed ACP stream keys from v2026.3.2 to supported config",
    legacyRules: LEGACY_ACP_STREAM_RULES,
    apply: (raw, changes) => {
      const acp = getRecord(raw.acp);
      const stream = getRecord(acp?.stream);
      if (!stream) {
        return;
      }
      migrateLegacyAcpStream(stream, changes);
    },
  }),
];
