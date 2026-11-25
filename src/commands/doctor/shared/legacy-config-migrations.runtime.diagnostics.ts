// Legacy diagnostics migrations are currently folded into the tuning-knob purge,
// except compatibility repairs that need value-aware behavior.
import { getRecord, type LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";

function hasLegacyGrpcOtlpSignals(otel: Record<string, unknown>): boolean {
  return (
    otel.traces !== false ||
    otel.metrics !== false ||
    (otel.logs === true && otel.logsExporter !== "stdout")
  );
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_DIAGNOSTICS: LegacyConfigMigrationSpec[] = [
  {
    id: "diagnostics.otel.grpc-protocol",
    legacyRules: [
      {
        path: ["diagnostics", "otel", "protocol"],
        message:
          'diagnostics.otel.protocol = "grpc" is no longer accepted because gRPC export is not implemented. Run "openclaw doctor --fix", then configure an OTLP/HTTP collector before re-enabling telemetry.',
        match: (value) => value === "grpc",
      },
    ],
    apply: (raw, changes, context) => {
      const otel = getRecord(getRecord(raw.diagnostics)?.otel);
      const resolvedRoot = getRecord(context?.resolvedRaw ?? raw);
      const resolvedOtel = getRecord(getRecord(resolvedRoot?.diagnostics)?.otel);
      if (!otel || resolvedOtel?.protocol !== "grpc") {
        return;
      }

      delete otel.protocol;
      changes.push(
        'Removed unsupported diagnostics.otel.protocol "grpc"; use "http/protobuf" with an OTLP/HTTP collector.',
      );
      if (resolvedOtel.enabled === true && hasLegacyGrpcOtlpSignals(resolvedOtel)) {
        otel.enabled = false;
        changes.push(
          "Disabled diagnostics.otel.enabled because legacy grpc configs with OTLP signals cannot export telemetry; re-enable it after choosing an OTLP/HTTP collector.",
        );
      }
    },
  },
];
