import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { resolvePluginDoctorContractArtifact } from "./doctor-contract-artifact.js";
import {
  declaresPluginDoctorContractSurface,
  isPluginDoctorMigrationDeferred,
  listPluginDoctorSessionStoreAgentIds,
  loadPluginDoctorStateMigrationEntries,
  resolveLiveDoctorInventoryFromSelection,
  resolvePluginDoctorManifestRecords,
  resolvePluginDoctorStateMigrationRecords,
  type LiveDoctorInventoryParams,
  type PluginDoctorContractSurface,
  type PluginDoctorRegistryParams,
  type PluginDoctorStateMigrationInventory,
} from "./doctor-contract-registry.js";
import type { PluginDoctorMigrationResourceCollectionParams } from "./doctor-migration-resources.js";
import type { PluginManifestRegistry } from "./manifest-registry.types.js";
import {
  preparePluginSetupModuleLoader,
  withPluginSetupPreparation,
} from "./plugin-setup-module.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

type PluginManifestRegistryRecord = PluginManifestRegistry["plugins"][number];

export async function preparePluginDoctorSessionStoreAgentIds(
  params: PluginDoctorRegistryParams,
): Promise<string[]> {
  await preparePluginDoctorContractModules({
    ...params,
    surfaces: ["resolveSessionStoreAgentIds"],
  });
  return listPluginDoctorSessionStoreAgentIds(params);
}

/** Await selected source capture before invoking the synchronous Doctor contracts. */
export async function preparePluginDoctorContractModules(
  params: PluginDoctorRegistryParams & {
    inventory?: PluginDoctorStateMigrationInventory;
    surfaces?: readonly PluginDoctorContractSurface[];
    artifactPreservingReadOnly?: boolean;
    assertCurrent?: () => void;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  return await withPluginSetupPreparation(params, async ({ assertCurrent }) => {
    const surfaces = params.surfaces ?? [
      "configRepair",
      "resolveSessionStoreAgentIds",
      "sessionRouteStateOwners",
      "stateMigrations",
    ];
    for (const surface of surfaces) {
      const records =
        params.inventory?.records ??
        (surface === "stateMigrations"
          ? resolvePluginDoctorStateMigrationRecords(params)
          : resolvePluginDoctorManifestRecords(params, surface === "configRepair"));
      await prepareDoctorContractRecords(
        surface === "sessionRouteStateOwners"
          ? records.filter((record) => record.sessionRouteStateOwners === undefined)
          : records,
        surface,
        assertCurrent,
        params.signal,
      );
      assertCurrent();
      if (surface === "configRepair") {
        // Synchronous config migrations also consume selected channel setup callbacks.
        const { resolveReadOnlyChannelPluginsForConfigAsync } =
          await import("../channels/plugins/read-only.js");
        assertCurrent();
        await resolveReadOnlyChannelPluginsForConfigAsync(params.config ?? {}, {
          env: params.env,
          workspaceDir: params.workspaceDir,
          manifestRecords: records,
          includePersistedAuthState: false,
          includeSetupFallbackPlugins: true,
        });
        assertCurrent();
      }
    }
  });
}

async function prepareDoctorContractRecords(
  records: readonly PluginManifestRegistryRecord[],
  surface: PluginDoctorContractSurface,
  assertCurrent?: () => void,
  signal?: AbortSignal,
): Promise<void> {
  for (const record of records) {
    if (isPluginDoctorMigrationDeferred(record.id)) {
      continue;
    }
    signal?.throwIfAborted();
    assertCurrent?.();
    if (
      !record.doctorContract ||
      declaresPluginDoctorContractSurface(record.doctorContract, surface)
    ) {
      const artifact = resolvePluginDoctorContractArtifact(record);
      if (artifact) {
        await preparePluginSetupModuleLoader(record, artifact.modulePath, artifact.boundaryRoot, {
          stateOperations: false,
          assertCurrent,
          signal,
        });
      }
    }
    if (
      surface === "stateMigrations" &&
      record.origin !== "bundled" &&
      record.channels.length > 0 &&
      !declaresPluginDoctorContractSurface(record.doctorContract, surface) &&
      record.setupSource
    ) {
      await preparePluginSetupModuleLoader(record, record.setupSource, record.rootDir, {
        assertCurrent,
        signal,
      });
    }
    assertCurrent?.();
  }
}

/** Keep the exact selected records through preparation and descriptor validation. */
export async function prepareLivePluginDoctorStateMigrationInventory(
  params: LiveDoctorInventoryParams & { assertCurrent?: () => void },
): Promise<PluginDoctorStateMigrationInventory> {
  return await withPluginSetupPreparation(params, async ({ assertCurrent }) => {
    let records: PluginManifestRegistryRecord[];
    try {
      records = resolvePluginDoctorStateMigrationRecords({
        ...params,
        artifactPreservingReadOnly: true,
      });
    } catch (error) {
      return resolveLiveDoctorInventoryFromSelection(params, () => {
        throw error;
      });
    }
    await prepareDoctorContractRecords(
      records.filter((record) => !Array.isArray(record.doctorContract?.stateMigrations)),
      "stateMigrations",
      assertCurrent,
    );
    assertCurrent();
    return resolveLiveDoctorInventoryFromSelection(params, () => records);
  });
}

/** Inspect plugin-owned migration paths before the updater captures its recovery set. */
export async function preparePluginDoctorMigrationBackupResources(
  params: PluginDoctorMigrationResourceCollectionParams,
) {
  return await withPluginSetupPreparation(params, ({ assertCurrent }) =>
    withArtifactPreservingStateReads(() =>
      withPluginSourceCaptureStorage(
        { stateDir: params.stateDir, placement: "temporary" },
        async () => {
          const records = resolvePluginDoctorStateMigrationRecords({
            ...params,
            artifactPreservingReadOnly: true,
          });
          await prepareDoctorContractRecords(
            records,
            "stateMigrations",
            assertCurrent,
            params.signal,
          );
          assertCurrent();
          const entries = loadPluginDoctorStateMigrationEntries(records);
          const { preparePluginDoctorMigrationResources } =
            await import("./doctor-migration-resources.js");
          assertCurrent();
          return await preparePluginDoctorMigrationResources(entries, { ...params, assertCurrent });
        },
      ),
    ),
  );
}
