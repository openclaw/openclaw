import { getRecord, type LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON: LegacyConfigMigrationSpec[] = [
  {
    id: "cron.webhook-remove",
    legacyRules: [
      {
        path: ["cron", "webhook"],
        message:
          'cron.webhook was retired after per-job delivery migration. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      const cron = getRecord(raw.cron);
      if (!cron || !Object.hasOwn(cron, "webhook")) {
        return;
      }
      delete cron.webhook;
      changes.push("Removed retired cron.webhook after stored jobs migrated to per-job delivery.");
    },
  },
  {
    id: "cron.runLog-remove",
    legacyRules: [
      {
        path: ["cron", "runLog"],
        message:
          'cron.runLog is retired; run history now has fixed per-job retention. Run "openclaw doctor --fix".',
      },
    ],
    apply: (raw, changes) => {
      const cron = getRecord(raw.cron);
      if (!cron || !Object.hasOwn(cron, "runLog")) {
        return;
      }
      delete cron.runLog;
      if (Object.keys(cron).length === 0) {
        delete raw.cron;
      }
      changes.push("Removed retired cron.runLog config; cron history now keeps 2000 runs per job.");
    },
  },
];
