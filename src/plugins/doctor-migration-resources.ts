import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryResolveConfiguredAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  isUpdateRehearsalReadOnlyPath,
  resolveUpdateRehearsalRoot,
} from "../infra/update-rehearsal-paths.js";
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

/** Select one whole-plugin data scope for both rehearsal inventory and execution. */
export async function preparePluginDoctorMigrationResources(
  entries: readonly { pluginId: string; migration: PluginDoctorStateMigration }[],
  params: PluginDoctorMigrationResourceCollectionParams,
) {
  const rehearsalRoot = resolveUpdateRehearsalRoot(params.env);
  const resources = new Map<string, PluginDoctorMigrationBackupResource>();
  const pluginResources = new Map<string, Set<string>>();
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
      const paths = pluginResources.get(pluginId) ?? new Set<string>();
      paths.add(resourcePath);
      pluginResources.set(pluginId, paths);
    }
  }
  const deferredPluginIds = new Set(
    rehearsalRoot
      ? [...pluginResources].flatMap(([pluginId, paths]) =>
          [...paths].some((file) => isUpdateRehearsalReadOnlyPath(file, params.env))
            ? [pluginId]
            : [],
        )
      : [],
  );
  const selectedPaths = new Set(
    [...pluginResources].flatMap(([pluginId, paths]) =>
      deferredPluginIds.has(pluginId) ? [] : [...paths],
    ),
  );
  const selectedResources = [...resources.values()]
    .filter((resource) => selectedPaths.has(resource.path))
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const assertCurrent = () => {
    if (!rehearsalRoot) {
      return;
    }
    if (resolveUpdateRehearsalRoot(params.env) !== rehearsalRoot) {
      throw new Error("Plugin migration rehearsal scope changed during preparation");
    }
    for (const resource of selectedResources) {
      if (isUpdateRehearsalReadOnlyPath(resource.path, params.env)) {
        throw new Error(`Plugin migration data escaped the rehearsal root: ${resource.path}`);
      }
    }
  };
  assertCurrent();
  return {
    resources: selectedResources,
    deferredPluginIds,
    notices: [...deferredPluginIds].map(
      (pluginId) =>
        `rehearsal: ${pluginId} state migrations deferred; declared data outside the rehearsal root left untouched`,
    ),
    assertCurrent,
  };
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
