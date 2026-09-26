import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryResolveConfiguredAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  PluginDoctorMigrationBackupResource,
  PluginDoctorMigrationBackupWarning,
  PluginDoctorStateMigration,
} from "./doctor-contract-module.js";
export type PluginDoctorMigrationResourceCollectionParams = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  workspaceDir?: string;
  warnings: PluginDoctorMigrationBackupWarning[];
  requireLocalResources?: boolean;
};

/** Validate and combine data footprints after registry discovery selects the migrations. */
export async function collectPluginDoctorMigrationResources(
  entries: readonly { pluginId: string; migration: PluginDoctorStateMigration }[],
  params: PluginDoctorMigrationResourceCollectionParams,
): Promise<PluginDoctorMigrationBackupResource[]> {
  const resources = new Map<string, PluginDoctorMigrationBackupResource>();
  for (const { pluginId, migration } of entries) {
    if (migration.collectBackupResources === undefined) {
      if (!params.warnings.some((warning) => warning.pluginId === pluginId)) {
        params.warnings.push({
          kind: "undeclared-migration-resources",
          pluginId,
          message: `${pluginId} migration declares no data resources; its private state is not in the recovery set`,
        });
      }
      continue;
    }
    const resolved: unknown = await migration.collectBackupResources({
      config: params.config,
      env: params.env,
      stateDir: params.stateDir,
      serviceWorkspaceDir:
        tryResolveConfiguredAgentWorkspaceDir(params.config, params.env) ??
        resolveDefaultAgentWorkspaceDir(params.env),
      ...(params.requireLocalResources ? { requireLocalResources: true } : {}),
    });
    if (!Array.isArray(resolved)) {
      throw new Error(`Invalid migration backup inventory from ${pluginId}/${migration.id}`);
    }
    const candidates: readonly unknown[] = resolved;
    for (const resource of candidates) {
      if (!isMigrationBackupResource(resource)) {
        throw new Error(`Invalid migration backup resource from ${pluginId}/${migration.id}`);
      }
      const resourcePath = resource.path;
      const previous = resources.get(resourcePath);
      if (previous && previous.kind !== resource.kind) {
        throw new Error(`Conflicting migration backup resource kinds for ${resourcePath}`);
      }
      resources.set(resourcePath, { path: resourcePath, kind: resource.kind });
    }
  }
  return [...resources.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

function isMigrationBackupResource(value: unknown): value is PluginDoctorMigrationBackupResource {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    path.isAbsolute(value.path) &&
    // Normalization must not erase traversal through a filesystem link.
    path.normalize(value.path) === value.path &&
    (value.kind === "sqlite" || value.kind === "file" || value.kind === "directory")
  );
}
