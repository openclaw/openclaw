import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

function isLegacyMemoryPressureBundleConfig(value: unknown): boolean {
  return getRecord(value) !== null;
}

const MEMORY_PRESSURE_BUNDLE_RULE: LegacyConfigRule = {
  path: ["diagnostics", "memoryPressureBundle"],
  message:
    'diagnostics.memoryPressureBundle object form is legacy; use a boolean instead. Run "openclaw doctor --fix".',
  match: isLegacyMemoryPressureBundleConfig,
  requireSourceLiteral: true,
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_DIAGNOSTICS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "diagnostics.memoryPressureBundle.enabled->boolean",
    describe: "Move diagnostics.memoryPressureBundle.enabled to diagnostics.memoryPressureBundle",
    legacyRules: [MEMORY_PRESSURE_BUNDLE_RULE],
    apply: (raw, changes) => {
      const diagnostics = getRecord(raw.diagnostics);
      if (!diagnostics || !isLegacyMemoryPressureBundleConfig(diagnostics.memoryPressureBundle)) {
        return;
      }
      const legacy = getRecord(diagnostics.memoryPressureBundle);
      diagnostics.memoryPressureBundle = legacy?.enabled === false ? false : true;
      changes.push("Moved diagnostics.memoryPressureBundle object → boolean value.");
    },
  }),
];
