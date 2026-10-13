import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/config.js";
import {
  resolveConfigWidePluginMetadataSnapshot,
  resolveConfigWidePluginMetadataSnapshotAsync,
} from "../../config/io.plugin-metadata.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePluginActivationSourceConfig } from "../activation-source-config.js";
import { prepareBundledDiscoveryMode } from "../bundled-discovery-state.js";
import { resolvePluginControlPlaneWorkspace } from "../control-plane-workspace.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../installed-plugin-index-install-records.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import {
  projectPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
  resolvePluginMetadataSnapshotAsync,
} from "../plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import type { PluginLogger } from "../types.js";
import { createPluginRuntimeLoaderLogger, type PluginRuntimeLoadContext } from "./load-context.js";

type PluginRuntimeLoadContextOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: readonly string[];
  logger?: PluginLogger;
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: PluginMetadataSnapshot;
  preferBuiltPluginArtifacts?: boolean;
  expectedSourceDigests?: PluginRuntimeLoadContext["expectedSourceDigests"];
};

/** Prepare persisted policy before the existing synchronous runtime projection. */
export async function resolvePluginRuntimeLoadContextAsync(
  options?: PluginRuntimeLoadContextOptions,
): Promise<PluginRuntimeLoadContext> {
  const env = options?.env ?? process.env;
  const config = options?.config ?? (await captureRuntimeConfigAsyncReader()());
  await prepareBundledDiscoveryMode(env);
  if (options?.metadataSnapshot || options?.manifestRegistry) {
    return resolvePluginRuntimeLoadContext({ ...options, config, env });
  }
  const metadataSnapshot =
    options?.workspaceDir === undefined
      ? projectPluginMetadataSnapshot(
          await resolveConfigWidePluginMetadataSnapshotAsync({ config, env }),
          options?.onlyPluginIds,
        )
      : await resolvePluginMetadataSnapshotAsync({
          config,
          env,
          workspaceDir: resolvePluginControlPlaneWorkspace({
            config,
            env,
            workspaceDir: options.workspaceDir,
          }).workspaceDir,
          allowWorkspaceScopedCurrent: true,
          ...(options.onlyPluginIds !== undefined ? { pluginIds: options.onlyPluginIds } : {}),
        });
  return resolvePluginRuntimeLoadContext({ ...options, config, env, metadataSnapshot });
}

export function resolvePluginRuntimeLoadContext(
  options?: PluginRuntimeLoadContextOptions,
): PluginRuntimeLoadContext {
  const env = options?.env ?? process.env;
  const rawConfig = options?.config ?? getRuntimeConfig();
  const rawWorkspaceDir = resolvePluginControlPlaneWorkspace({
    config: rawConfig,
    env,
    workspaceDir: options?.workspaceDir,
  }).workspaceDir;
  const metadataSnapshot =
    options?.metadataSnapshot ??
    (options?.manifestRegistry !== undefined
      ? undefined
      : options?.workspaceDir === undefined
        ? projectPluginMetadataSnapshot(
            resolveConfigWidePluginMetadataSnapshot({ config: rawConfig, env }),
            options?.onlyPluginIds,
          )
        : resolvePluginMetadataSnapshot({
            config: rawConfig,
            env,
            workspaceDir: rawWorkspaceDir,
            allowWorkspaceScopedCurrent: true,
            ...(options?.onlyPluginIds !== undefined ? { pluginIds: options.onlyPluginIds } : {}),
          }));
  const manifestRegistry = options?.manifestRegistry ?? metadataSnapshot?.manifestRegistry;
  const activationSourceConfig = resolvePluginActivationSourceConfig({
    config: rawConfig,
    activationSourceConfig: options?.activationSourceConfig,
  });
  const autoEnabled = applyPluginAutoEnable({
    config: rawConfig,
    env,
    manifestRegistry,
    discovery: metadataSnapshot?.discovery,
  });
  const config = autoEnabled.config;
  const workspaceDir = resolvePluginControlPlaneWorkspace({
    config,
    env,
    workspaceDir: options?.workspaceDir,
  }).workspaceDir;
  const installRecords = metadataSnapshot
    ? extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index)
    : undefined;
  return {
    rawConfig,
    config,
    activationSourceConfig,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    env,
    logger: options?.logger ?? createPluginRuntimeLoaderLogger(),
    ...(manifestRegistry ? { manifestRegistry } : {}),
    ...(metadataSnapshot ? { metadataSnapshot } : {}),
    installRecords,
    preferBuiltPluginArtifacts: options?.preferBuiltPluginArtifacts,
    expectedSourceDigests: options?.expectedSourceDigests,
  };
}
