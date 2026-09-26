import { preserveDeferredPluginMigrationConfig } from "../../../config/deferred-plugin-migration-config.js";
import {
  createConfigIoContext,
  type ConfigRecoveryCandidateTransform,
} from "../../../config/io.context.js";
import { recoverConfigFromLastKnownGoodCore } from "../../../config/io.observe-recovery.js";
import { prepareConfigRecoveryFromContext } from "../../../config/io.snapshot.js";
import type { ConfigIoFactoryOptions } from "../../../config/io.types.js";
import type { ConfigFileSnapshot } from "../../../config/types.js";
import { classifyOtelGrpcMigrationOwnership } from "./include-migration-ownership.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

const transformDoctorRecoveryCandidate: ConfigRecoveryCandidateTransform = (params) => {
  const ownership = classifyOtelGrpcMigrationOwnership({
    snapshot: { path: params.configPath, includeProvenance: params.includeProvenance },
    authoredConfig: params.candidate.parsed,
    resolvedConfig: params.resolvedConfig,
  });
  if (ownership && ownership.kind !== "direct") {
    throw new Error(
      ownership.kind === "resolved-only"
        ? "candidate migration cannot persist an env-resolved diagnostics.otel.protocol repair"
        : "candidate migration requires an include-owned diagnostics.otel.protocol repair",
    );
  }
  const migration = applyLegacyDoctorMigrations(params.candidate.parsed, {
    sourceConfigBeforeMigrations: params.resolvedConfig,
    context: {
      authoredRaw: params.candidate.parsed,
      resolvedRaw: params.resolvedConfig,
    },
  });
  return migration.next
    ? preserveDeferredPluginMigrationConfig({
        sourceConfig: params.candidate.parsed,
        nextConfig: migration.next,
        pending: params.deferredPluginMigrations,
      })
    : params.candidate.parsed;
};

export function prepareDoctorConfigRecoverySnapshot(
  options: ConfigIoFactoryOptions,
  snapshot: ConfigFileSnapshot,
) {
  return prepareConfigRecoveryFromContext(
    createConfigIoContext(options, transformDoctorRecoveryCandidate),
    snapshot,
  );
}

export function recoverDoctorConfigFromLastKnownGood(params: {
  snapshot: ConfigFileSnapshot;
  reason: string;
}) {
  const context = createConfigIoContext(
    { configPath: params.snapshot.path },
    transformDoctorRecoveryCandidate,
  );
  return recoverConfigFromLastKnownGoodCore({
    ...params,
    deps: context.deps,
    prepareCandidate: context.prepareRecoveryBackupCandidate,
  });
}
