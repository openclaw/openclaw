import { resolveOAuthDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { listDatabaseEngineStores } from "../infra/database-engine/registry.js";
import type { DatabaseEngineFamily } from "../infra/database-engine/types.js";
import { createPluginDoctorStateMigrationInput } from "../infra/state-migrations.plugin-doctor.js";
import {
  listPluginDoctorStateMigrationEntries,
  resolvePluginDoctorStateMigrationRecords,
} from "../plugins/doctor-contract-registry.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";

export type DoctorDatabaseLegacyInspection = {
  state: "pending" | "none" | "unknown";
  pending: string[];
};

/** Inspect the same retained SQLite imports that gate database port, on either engine. */
export async function inspectDoctorDatabaseLegacyMigrations(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): Promise<Partial<Record<DatabaseEngineFamily, DoctorDatabaseLegacyInspection>>> {
  const families = listDatabaseEngineStores().filter((store) => store.postgres);
  const result: Partial<Record<DatabaseEngineFamily, DoctorDatabaseLegacyInspection>> = {};
  for (const family of families) {
    result[family.id] = { state: "none", pending: [] };
  }
  const markUnknown = () => {
    for (const family of families) {
      result[family.id]!.state = "unknown";
    }
  };
  try {
    await withArtifactPreservingStateReads(
      async () => {
        const records = resolvePluginDoctorStateMigrationRecords({
          ...params,
          includeDisabled: true,
          artifactPreservingReadOnly: true,
        });
        const inspected = new Set<string>();
        const entries = listPluginDoctorStateMigrationEntries({
          ...params,
          includeDisabled: true,
          inventory: {
            records,
            knownPluginIds: records.map((record) => record.id),
            sessionStoreOwnerPluginIds: [],
            descriptors: [],
            unresolvedPluginIds: [],
          },
          onInspectedPlugin: (id) => inspected.add(id),
          onInspectedStatelessPlugin: (id) => inspected.add(id),
        });
        // A missing contract cannot establish which family its imports would target.
        if (
          records.some((record) => {
            const declaration = record.doctorContract?.stateMigrations;
            return (
              (declaration === true || (Array.isArray(declaration) && declaration.length > 0)) &&
              !inspected.has(record.id)
            );
          })
        ) {
          markUnknown();
        }
        for (const entry of entries) {
          const family = entry.migration.sqliteOnly?.family;
          if (!family) {
            continue;
          }
          const inspection = result[family]!;
          try {
            const detected = await entry.migration.detectLegacyState(
              createPluginDoctorStateMigrationInput(
                { ...params, oauthDir: resolveOAuthDir(params.env, params.stateDir) },
                entry,
              ),
            );
            if (detected !== null) {
              inspection.pending.push(
                `${entry.pluginId}/${entry.migration.id} (${entry.migration.label})`,
              );
              if (inspection.state !== "unknown") {
                inspection.state = "pending";
              }
            }
          } catch {
            inspection.state = "unknown";
          }
        }
      },
      { agentDatabases: true },
    );
  } catch {
    markUnknown();
  }
  return result;
}
