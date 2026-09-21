// Update-channel config repair for legacy config files before normal command startup.
import { readConfigFileSnapshot, replaceConfigFile } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.types.js";
import { resolveConfigIncludeWriteBoundary } from "../../config/mutate.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateConfigObjectRawWithPlugins } from "../../config/validation.js";
import { containsAuthoredInclude } from "./shared/include-migration-ownership.js";
import { migrateLegacyConfig } from "./shared/legacy-config-migrate.js";

type ConfigSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;

export type LegacyConfigUpdatePlan = {
  snapshot: ConfigSnapshot;
  config: OpenClawConfig;
  nextConfig: OpenClawConfig;
  changes: string[];
  warnings?: string[];
  includeIdentity: Pick<
    ConfigWriteOptions,
    "includeFileHashesForWrite" | "includeFileTargetsForWrite"
  >;
};

/** Plan without replacing the source: update checkpoints must retain the authored bytes. */
export function planLegacyConfigForUpdateChannel(
  configSnapshot: ConfigSnapshot,
  includeIdentity: LegacyConfigUpdatePlan["includeIdentity"] = {},
): LegacyConfigUpdatePlan | undefined {
  const hasAuthoredIncludes = containsAuthoredInclude(configSnapshot.parsed);
  const migrated = migrateLegacyConfig(configSnapshot.sourceConfig, {
    sourceConfigBeforeMigrations: configSnapshot.sourceConfigBeforeMigrations,
    context: {
      authoredRaw: configSnapshot.parsed,
      resolvedRaw: configSnapshot.sourceConfig,
    },
  });
  if (!migrated.config && !migrated.warnings?.length) {
    return undefined;
  }

  const nextConfig = migrated.sourceConfig ?? migrated.config ?? configSnapshot.sourceConfig;
  const validated = validateConfigObjectRawWithPlugins(migrated.config ?? nextConfig);
  if (!validated.ok) {
    return undefined;
  }

  if (
    hasAuthoredIncludes &&
    !resolveConfigIncludeWriteBoundary({ snapshot: configSnapshot, nextConfig })
  ) {
    return undefined;
  }

  return {
    snapshot: configSnapshot,
    config: validated.config,
    nextConfig,
    changes: migrated.changes,
    ...(migrated.warnings?.length ? { warnings: migrated.warnings } : {}),
    // Snapshot-for-write exposes canonical hashes/targets without performing a write.
    // Only these data fields cross admission, never its live writer callbacks.
    includeIdentity: {
      includeFileHashesForWrite: { ...includeIdentity.includeFileHashesForWrite },
      includeFileTargetsForWrite: { ...includeIdentity.includeFileTargetsForWrite },
    },
  };
}

/**
 * Persist the prepared migration without rebasing it onto later source edits.
 * Deferred callers seal/bind their checkpoint before invoking this writer;
 * the plan itself is source data, not proof of exclusion or write authority.
 */
export async function repairLegacyConfigForUpdateChannel(params: {
  configSnapshot: ConfigSnapshot;
  plan?: LegacyConfigUpdatePlan;
  configWriteOptions?: ConfigWriteOptions;
  jsonMode: boolean;
}): Promise<{ snapshot: ConfigSnapshot; repaired: boolean; warnings?: string[] }> {
  const plan = params.plan ?? planLegacyConfigForUpdateChannel(params.configSnapshot);
  if (!plan) {
    return { snapshot: params.configSnapshot, repaired: false };
  }
  const diagnostics = plan.warnings?.length ? { warnings: plan.warnings } : {};
  if (plan.changes.length === 0) {
    return { snapshot: params.configSnapshot, repaired: false, ...diagnostics };
  }
  if (params.plan && containsAuthoredInclude(plan.snapshot.parsed)) {
    const paths = plan.snapshot.includedPaths ?? [];
    if (
      paths.length === 0 ||
      paths.some(
        (includePath) =>
          !plan.includeIdentity.includeFileHashesForWrite?.[includePath] ||
          !plan.includeIdentity.includeFileTargetsForWrite?.[includePath],
      )
    ) {
      throw new Error("Legacy config plan is missing include write identities.");
    }
  }
  await replaceConfigFile({
    sourceConfig: plan.nextConfig,
    baseHash: plan.snapshot.hash,
    writeOptions: {
      // Reuse the canonical writer's fresh lock/path check and original include fences.
      // Immediate repair still uses its fresh writer snapshot; deferred plans must
      // supply the data captured by readConfigFileSnapshotForWrite at planning time.
      ...(params.plan ? plan.includeIdentity : params.configWriteOptions),
      expectedConfigPath: plan.snapshot.path,
      auditOrigin: "doctor",
      allowConfigSizeDrop: true,
      skipOutputLogs: params.jsonMode,
    },
  });

  const snapshot = await readConfigFileSnapshot();
  return { snapshot, repaired: snapshot.valid, ...diagnostics };
}
