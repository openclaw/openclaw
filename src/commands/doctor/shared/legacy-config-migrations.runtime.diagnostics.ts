// Legacy diagnostics config migrations for renamed runtime diagnostic options.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

function isLegacyMemoryPressureBundleConfig(value: unknown): boolean {
  return typeof value === "boolean" || getRecord(value) !== null;
}

const MEMORY_PRESSURE_BUNDLE_RULE: LegacyConfigRule = {
  path: ["diagnostics", "memoryPressureBundle"],
  message:
    'diagnostics.memoryPressureBundle was renamed; use diagnostics.memoryPressureSnapshot instead. Run "openclaw doctor --fix".',
  match: isLegacyMemoryPressureBundleConfig,
  requireSourceLiteral: true,
};

const UNSUPPORTED_OTEL_GRPC_PROTOCOL_RULE: LegacyConfigRule = {
  path: ["diagnostics", "otel", "protocol"],
  message:
    'diagnostics.otel.protocol = "grpc" is no longer accepted because gRPC export is not implemented. Run "openclaw doctor --fix", then configure an OTLP/HTTP collector before re-enabling telemetry.',
  match: (value) => value === "grpc",
  requireSourceLiteral: true,
};

function hasLegacyGrpcOtlpSignals(otel: Record<string, unknown>): boolean {
  const logsExporter = typeof otel.logsExporter === "string" ? otel.logsExporter : undefined;
  return (
    otel.traces !== false ||
    otel.metrics !== false ||
    (otel.logs === true && logsExporter !== "stdout")
  );
}

/** Legacy config migration specs for diagnostics runtime config. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_DIAGNOSTICS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "diagnostics.memoryPressureBundle->memoryPressureSnapshot",
    describe: "Move diagnostics.memoryPressureBundle to diagnostics.memoryPressureSnapshot",
    legacyRules: [MEMORY_PRESSURE_BUNDLE_RULE],
    apply: (raw, changes) => {
      const diagnostics = getRecord(raw.diagnostics);
      if (!diagnostics || !isLegacyMemoryPressureBundleConfig(diagnostics.memoryPressureBundle)) {
        return;
      }
      if (Object.hasOwn(diagnostics, "memoryPressureSnapshot")) {
        delete diagnostics.memoryPressureBundle;
        changes.push(
          "Removed diagnostics.memoryPressureBundle (memoryPressureSnapshot already set).",
        );
        return;
      }
      const legacy = getRecord(diagnostics.memoryPressureBundle);
      diagnostics.memoryPressureSnapshot =
        typeof diagnostics.memoryPressureBundle === "boolean"
          ? diagnostics.memoryPressureBundle
          : legacy?.enabled !== false;
      delete diagnostics.memoryPressureBundle;
      changes.push("Moved diagnostics.memoryPressureBundle → memoryPressureSnapshot.");
    },
  }),
  defineLegacyConfigMigration({
    id: "diagnostics.otel.grpc-protocol",
    describe: "Remove unsupported diagnostics.otel.protocol grpc configs",
    legacyRules: [UNSUPPORTED_OTEL_GRPC_PROTOCOL_RULE],
    apply: (raw, changes) => {
      const otel = getRecord(getRecord(raw.diagnostics)?.otel);
      if (!otel || otel.protocol !== "grpc") {
        return;
      }

      delete otel.protocol;
      changes.push(
        'Removed unsupported diagnostics.otel.protocol "grpc"; use "http/protobuf" with an OTLP/HTTP collector.',
      );
      if (otel.enabled === true && hasLegacyGrpcOtlpSignals(otel)) {
        otel.enabled = false;
        changes.push(
          "Disabled diagnostics.otel.enabled because legacy grpc configs with OTLP signals cannot export telemetry; re-enable it after choosing an OTLP/HTTP collector.",
        );
      }
    },
  }),
];
