import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { preserveDeferredPluginMigrationConfig } from "../config/deferred-plugin-migration-config.js";
import { resolveFutureConfigActionBlock } from "../config/future-version-guard.js";
import {
  createConfigIoContext,
  type ConfigRecoveryCandidateTransform,
} from "../config/io.context.js";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import {
  createConfigIO,
  parseConfigJson5,
  recoverConfigFromJsonRootSuffix,
  type ConfigSnapshotReadMeasure,
} from "../config/io.js";
import { recoverConfigFromLastKnownGoodCore } from "../config/io.observe-recovery.js";
import { prepareConfigRecoveryFromContext } from "../config/io.snapshot.js";
import { resolveCanonicalConfigPath, resolveIsConfigReadOnly } from "../config/paths.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store/paths.js";
import { listRetiredCronStateFiles } from "../infra/state-migrations.retired-cron-files.js";
import { assertNoRetiredStateFiles } from "../infra/state-migrations.retired-files.js";
import type { ConfigPreflightSnapshotRead } from "./config-preflight-snapshot.js";
import type { planAutomaticConfigRepair } from "./doctor/shared/automatic-config-repair.js";
import { classifyOtelGrpcMigrationOwnership } from "./doctor/shared/include-migration-ownership.js";
import { applyLegacyDoctorMigrations } from "./doctor/shared/legacy-config-compat.js";
import { findRetiredConfigUpgradeRequirement } from "./doctor/shared/retired-config-formats.js";

const transformDoctorRecoveryCandidate: ConfigRecoveryCandidateTransform = (params) => {
  const ownership = classifyOtelGrpcMigrationOwnership({
    snapshot: { path: params.configPath, includeProvenance: params.includeProvenance },
    authoredConfig: params.candidate.parsed,
    resolvedConfig: params.resolvedConfig,
  });
  if (ownership && ownership.kind !== "direct") {
    throw createInvalidConfigError(
      params.configPath,
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

export async function migrateLegacyDoctorConfig(params: {
  enabled: boolean;
  measure: ConfigSnapshotReadMeasure;
}): Promise<boolean> {
  if (!params.enabled || resolveIsConfigReadOnly(process.env)) {
    return false;
  }
  const changes = await params.measure("legacy-config-migration", maybeMigrateLegacyConfig);
  if (changes.length > 0) {
    note(changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  return changes.length > 0;
}

/** Repair active legacy bytes before considering an older backup. */
export async function prepareDoctorConfigRecovery(params: {
  enabled: boolean;
  /** Before engine selection only file-backed repair is available. */
  databaseAccess?: "none";
  stateMigrationsRequested: boolean;
  snapshotRead: ConfigPreflightSnapshotRead;
  planRepair: (snapshot: ConfigFileSnapshot) => ReturnType<typeof planAutomaticConfigRepair>;
  readSnapshot: () => Promise<ConfigPreflightSnapshotRead>;
}) {
  let snapshotRead = params.snapshotRead;
  let snapshot = snapshotRead.snapshot;
  // Refuse before backup recovery or unknown-key cleanup can discard authored settings.
  const assertSupportedConfig = (config: unknown) => {
    const retired = findRetiredConfigUpgradeRequirement(config);
    if (retired) {
      throw new Error(`${retired.message} ${retired.nextAction}`);
    }
  };
  assertSupportedConfig(snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig);
  const sourceConfig = snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  // Config-only repair cannot discard the locator before Doctor imports its retained data.
  if (
    params.enabled &&
    !params.stateMigrationsRequested &&
    typeof asOptionalRecord(sourceConfig?.cron)?.store === "string"
  ) {
    assertNoRetiredStateFiles(
      "Cron state (state migration is disabled)",
      await listRetiredCronStateFiles(resolveCronJobsStorePathFromConfig(sourceConfig ?? {})),
    );
  }
  let activeConfigRepair: Awaited<ReturnType<typeof planAutomaticConfigRepair>> = null;
  const recoveryEnabled =
    params.enabled && !resolveFutureConfigActionBlock({ action: "recover config", snapshot });
  if (recoveryEnabled && snapshot.valid && params.databaseAccess !== "none") {
    const recovery = await prepareConfigRecoveryFromContext(
      createConfigIoContext({ configPath: snapshot.path }, transformDoctorRecoveryCandidate),
      snapshot,
    );
    if (recovery) {
      await recovery.apply();
      snapshotRead = await params.readSnapshot();
      snapshot = snapshotRead.snapshot;
    }
  }
  if (recoveryEnabled && snapshot.exists && !snapshot.valid) {
    // One retired key must not discard newer valid settings by restoring an older backup.
    activeConfigRepair =
      typeof snapshot.raw === "string" && parseConfigJson5(snapshot.raw).ok
        ? await params.planRepair(snapshot)
        : null;
    let configRepaired = false;
    const recoverPrefix =
      params.databaseAccess === "none"
        ? createConfigIO({
            configPath: snapshot.path,
            observe: false,
            pluginValidation: "core-only",
          }).recoverConfigFromJsonRootSuffix
        : recoverConfigFromJsonRootSuffix;
    if (!activeConfigRepair && (await recoverPrefix(snapshot, assertSupportedConfig))) {
      note("Removed non-JSON prefix from openclaw.json.", "Config");
      configRepaired = true;
    } else if (
      !activeConfigRepair &&
      // Last-known-good recovery must verify its promotion in the selected database.
      params.databaseAccess !== "none"
    ) {
      const context = createConfigIoContext(
        { configPath: snapshot.path },
        transformDoctorRecoveryCandidate,
      );
      if (
        await recoverConfigFromLastKnownGoodCore({
          snapshot,
          reason: "doctor-invalid-config",
          deps: context.deps,
          prepareCandidate: context.prepareRecoveryBackupCandidate,
        })
      ) {
        note(
          "Restored openclaw.json from last-known-good; original saved as .clobbered.*.",
          "Config",
        );
        configRepaired = true;
      }
    }
    if (configRepaired) {
      snapshotRead = await params.readSnapshot();
      snapshot = snapshotRead.snapshot;
    }
    if (
      params.databaseAccess !== "none" &&
      !snapshot.valid &&
      typeof snapshot.raw === "string" &&
      !parseConfigJson5(snapshot.raw).ok
    ) {
      throw new Error(
        `Config at ${snapshot.path} is not parseable and cannot be repaired automatically. The file remains unchanged. Inspect the exact parse error with ${formatCliCommand("openclaw config validate")}, then hand-edit the file; or move it aside and run ${formatCliCommand("openclaw onboard")} to generate a fresh config.`,
      );
    }
  }
  return { snapshotRead, activeConfigRepair };
}

async function maybeMigrateLegacyConfig(): Promise<string[]> {
  if (
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.OPENCLAW_HOME?.trim() ||
    process.env.OPENCLAW_CONFIG_PATH?.trim()
  ) {
    return [];
  }
  const { renameLegacyConfigFile } = await import("../infra/state-migrations.state-dir.js");
  return renameLegacyConfigFile(path.dirname(resolveCanonicalConfigPath()));
}
