import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
  type ConfigSnapshotReadMeasure,
} from "../config/io.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type {
  MigrationCheckpointIdentity,
  StartupMigrationLease,
} from "../infra/startup-migration-checkpoint.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { withDeferredPluginDoctorMigrations } from "../plugins/doctor-contract-registry.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-records.js";
import { createPluginCache, getPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveMigrationCheckpointIdentity } from "./doctor-config-preflight-checkpoint.js";
import { addDoctorLegacyIssues } from "./doctor/shared/legacy-config-issues.js";
import { completeDoctorPluginMetadataSnapshot } from "./doctor/shared/plugin-metadata-snapshot-scope.js";

const loadInstalledPluginIndexStoreWrite = createLazyRuntimeModule(
  () => import("../plugins/installed-plugin-index-store-write.js"),
);

export type DoctorConfigPreflightPluginSnapshotRead = {
  snapshot: ConfigFileSnapshot;
  pluginMigrationFingerprint: string | null;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

type MeasurePreflightStep = <T>(name: string, run: () => T | Promise<T>) => Promise<T>;

/** Returns true during updater-managed config rewrites where plugin validation may be stale. */
export function shouldSkipPluginValidationForDoctorConfigPreflight(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS);
}

/** One preflight owns completion; each read still checks the current update phase. */
export function createDoctorRehearsalSnapshotPreparation(
  report: (result: MigrationMessages) => void,
): (enabled: boolean) => ((snapshot: ConfigFileSnapshot) => Promise<void>) | undefined {
  let completed = false;
  const prepareSnapshot = async (snapshot: ConfigFileSnapshot) => {
    if (completed) {
      return;
    }
    const { completeUpdateCandidatePluginRehearsal } =
      await import("../infra/update-candidate-plugin-repair.js");
    const result = await completeUpdateCandidatePluginRehearsal({
      config: snapshot.sourceConfig ?? snapshot.config ?? {},
      env: process.env,
      installRecords: loadInstalledPluginIndexInstallRecordsSync({ env: process.env }),
    });
    completed = true;
    report({
      changes:
        result.copiedFiles > 0
          ? [`Update rehearsal: copied ${result.copiedFiles} missing plugin dependency files.`]
          : [],
      warnings: result.warnings,
    });
  };
  return (enabled) =>
    enabled &&
    resolveUpdateRehearsalRoot(process.env) &&
    process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1"
      ? prepareSnapshot
      : undefined;
}

function throwPluginRegistryPersistenceFailed(
  reason: string,
  repair = 'Run "openclaw doctor --fix" and retry.',
): never {
  throw new Error(
    `OpenClaw refreshed the plugin registry but could not verify the persisted replacement (${reason}); refusing to write the migration checkpoint. ${repair}`,
  );
}

function formatPluginRegistryDifferences(
  snapshot: PluginMetadataSnapshot | undefined,
): string | undefined {
  const differences = new Map(
    snapshot?.registryDiagnostics
      .flatMap((diagnostic) => diagnostic.differences ?? [])
      .map((difference) => [JSON.stringify(difference), difference] as const),
  );
  if (differences.size === 0) {
    return undefined;
  }
  return [...differences.values()]
    .toSorted((left, right) =>
      [left.pluginId, left.persistedSource, left.derivedSource]
        .join("\0")
        .localeCompare([right.pluginId, right.persistedSource, right.derivedSource].join("\0")),
    )
    .map(
      (difference) =>
        `${sanitizeTerminalText(difference.pluginId)} (${difference.changed.join("+")} changed; persisted source: ${JSON.stringify(difference.persistedSource)}; derived source: ${JSON.stringify(difference.derivedSource)})`,
    )
    .join(", ");
}

export async function readDoctorConfigPreflightSnapshot(params: {
  allowCurrentPluginMetadata: boolean;
  includePluginMetadata: boolean;
  measure?: ConfigSnapshotReadMeasure;
  observe?: boolean;
  preparePluginMetadataSnapshot: boolean;
  skipPluginValidation: boolean;
  /** Complete a private update snapshot before Doctor contract modules are inspected. */
  prepareSnapshot?: (snapshot: ConfigFileSnapshot) => Promise<void>;
  preparePluginMigrations?: (
    snapshot: ConfigFileSnapshot,
  ) => Promise<readonly DeferredPluginMigration[]>;
  deferredPluginMigrations?: readonly DeferredPluginMigration[];
}): Promise<DoctorConfigPreflightPluginSnapshotRead> {
  // Explicit management rereads cross a lease or mutation boundary. A resolver's
  // allowCurrent:false still reuses facts within an existing operation generation.
  const cache = params.allowCurrentPluginMetadata ? getPluginCache() : createPluginCache();
  return withPluginCache(cache, async () => {
    const sharedOptions = {
      ...(params.observe === false ? { observe: false } : {}),
      ...(params.measure ? { measure: params.measure } : {}),
      ...(params.allowCurrentPluginMetadata ? {} : { allowCurrentPluginMetadata: false }),
    };
    let deferred = params.deferredPluginMigrations;
    if (params.preparePluginMigrations) {
      const core = await readConfigFileSnapshot({
        ...sharedOptions,
        pluginValidation: "core-only",
        deferredPluginMigrations: deferred,
      });
      await params.prepareSnapshot?.(core);
      deferred = await params.preparePluginMigrations(core);
    }
    const readOptions = {
      ...sharedOptions,
      deferredPluginMigrations: deferred,
    };
    return withDeferredPluginDoctorMigrations(
      deferred?.map((entry) => entry.pluginId) ?? [],
      async () => {
        if (params.includePluginMetadata && !params.skipPluginValidation) {
          const result = await readConfigFileSnapshotWithPluginMetadata(readOptions);
          const pluginMetadataSnapshot = params.preparePluginMetadataSnapshot
            ? completeDoctorPluginMetadataSnapshot({
                snapshot: result.pluginMetadataSnapshot,
                config: result.snapshot.sourceConfig ?? result.snapshot.config ?? {},
              })
            : result.pluginMetadataSnapshot;
          return {
            snapshot: addDoctorLegacyIssues(result.snapshot, pluginMetadataSnapshot),
            pluginMigrationFingerprint: pluginMetadataSnapshot?.configFingerprint?.trim() || null,
            ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
          };
        }
        const snapshot = await readConfigFileSnapshot({
          ...readOptions,
          skipPluginValidation: params.skipPluginValidation,
        });
        if (!params.preparePluginMigrations) {
          await params.prepareSnapshot?.(snapshot);
        }
        return { snapshot: addDoctorLegacyIssues(snapshot), pluginMigrationFingerprint: null };
      },
    );
  });
}

export function needsRefreshedPluginIndexPersistence(
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead,
): boolean {
  return snapshotRead.pluginMetadataSnapshot?.registrySource === "derived";
}

export async function persistRefreshedPluginIndex(params: {
  env: NodeJS.ProcessEnv;
  measure: MeasurePreflightStep;
  readPersistedSnapshot: () => Promise<DoctorConfigPreflightPluginSnapshotRead>;
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead;
  lease: StartupMigrationLease | undefined;
  expectedIdentity: MigrationCheckpointIdentity | null;
}): Promise<{
  snapshotRead: DoctorConfigPreflightPluginSnapshotRead;
  checkpointIdentity: MigrationCheckpointIdentity;
}> {
  const derivedPluginMetadataSnapshot = params.snapshotRead.pluginMetadataSnapshot;
  if (!derivedPluginMetadataSnapshot || !params.snapshotRead.pluginMigrationFingerprint) {
    throwPluginRegistryPersistenceFailed("derived metadata was incomplete");
  }
  const lease = params.lease;
  if (!lease) {
    throwPluginRegistryPersistenceFailed("startup migration lease was not acquired");
  }
  const { writePersistedInstalledPluginIndexWithLeaseSync } = await params.measure(
    "plugin-index-store-import",
    loadInstalledPluginIndexStoreWrite,
  );
  // The checkpoint certifies the persisted inventory, not a process-local replacement.
  // Persist the original workspace scope; a config-wide union cannot pass scoped freshness checks.
  await params.measure("plugin-index-persistence", () =>
    writePersistedInstalledPluginIndexWithLeaseSync(derivedPluginMetadataSnapshot.registryIndex, {
      env: params.env,
      lease,
    }),
  );
  const persistedSnapshotRead = await params.readPersistedSnapshot();
  const persistedPluginMetadataSnapshot = persistedSnapshotRead.pluginMetadataSnapshot;
  // The registry selector owns freshness and returns "persisted" only after accepting the
  // durable index. Persisted parsing intentionally canonicalizes non-runtime package metadata.
  if (persistedPluginMetadataSnapshot?.registrySource !== "persisted") {
    const diagnosticCodes = persistedPluginMetadataSnapshot?.registryDiagnostics.map(
      (diagnostic) => diagnostic.code,
    );
    const differences = formatPluginRegistryDifferences(persistedPluginMetadataSnapshot);
    throwPluginRegistryPersistenceFailed(
      `reread source was ${persistedPluginMetadataSnapshot?.registrySource ?? "missing"}${
        differences ? `; differences: ${differences}` : ""
      }${diagnosticCodes?.length ? `; diagnostics: ${diagnosticCodes.join(", ")}` : ""}`,
      'Stop plugin package changes, run "openclaw plugins registry --refresh", then retry.',
    );
  }
  const persistedBaseConfig =
    persistedSnapshotRead.snapshot.sourceConfig ?? persistedSnapshotRead.snapshot.config ?? {};
  const persistedIdentity = resolveMigrationCheckpointIdentity({
    snapshot: persistedSnapshotRead.snapshot,
    baseConfig: persistedBaseConfig,
    pluginMigrationFingerprint: persistedSnapshotRead.pluginMigrationFingerprint,
  });
  if (
    !params.expectedIdentity ||
    !persistedIdentity ||
    params.expectedIdentity.effectiveConfigFingerprint !==
      persistedIdentity.effectiveConfigFingerprint ||
    params.expectedIdentity.pluginDoctorConfigFingerprint !==
      persistedIdentity.pluginDoctorConfigFingerprint
  ) {
    throw new Error(
      'OpenClaw config identity changed while persisting the refreshed plugin registry; refusing to write the migration checkpoint. Run "openclaw doctor --fix" and retry.',
    );
  }
  // The durable reread supplies both the accepted inventory and its checkpoint identity.
  return { snapshotRead: persistedSnapshotRead, checkpointIdentity: persistedIdentity };
}
