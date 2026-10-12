import { readConfigWritePendingMigrations } from "../infra/deferred-plugin-migrations.js";
import { resolveManagedUnsetPathsForWrite } from "./config-path-mutation.js";
import { preserveDeferredPluginMigrationConfig } from "./deferred-plugin-migration-config.js";
import { createConfigIoContext } from "./io.context.js";
import { createManagedRuntimeEnvBase } from "./io.runtime-env.js";
import type { ConfigWriteOptions } from "./io.types.js";
import { prepareConfigWritePayload } from "./io.write-payload.js";
import { resolveConfigWriteBlockingReasons } from "./io.write-safety.js";
import { prepareConfigWriteTopology } from "./io.write-topology.js";
import { resolveIncludeOwnedWriteCandidate } from "./mutate.js";
import { hasManagedRuntimeConfigWriteOwner } from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

/** Assess root-file safety without publishing config, audit, or rejection artifacts. */
export async function previewConfigFileWriteSafety(params: {
  sourceConfig: OpenClawConfig;
  snapshot: ConfigFileSnapshot;
  writeOptions: ConfigWriteOptions;
}): Promise<string[]> {
  const { snapshot } = params;
  const options: ConfigWriteOptions = { ...params.writeOptions, inputBase: "source" };
  options.assertConfigPathForWrite?.();
  const env = hasManagedRuntimeConfigWriteOwner(snapshot.path)
    ? createManagedRuntimeEnvBase()
    : process.env;
  const deferredPluginMigrations = readConfigWritePendingMigrations(snapshot.path, env);
  const nextConfig = preserveDeferredPluginMigrationConfig({
    sourceConfig: snapshot.sourceConfig,
    nextConfig: params.sourceConfig,
    pending: deferredPluginMigrations,
    writeOptions: options,
  });
  // Include-only mutations do not publish a root payload or run its size guard.
  const includeWrite = resolveIncludeOwnedWriteCandidate({
    snapshot,
    nextConfig,
    writeOptions: options,
  });
  if (includeWrite && options.assertConfigPathForWrite) {
    return [];
  }
  const context = createConfigIoContext({ configPath: snapshot.path, env, observe: false });
  const topology = await prepareConfigWriteTopology({
    snapshot,
    pluginMetadataSnapshot: options.basePluginMetadataSnapshot,
    nextConfig,
    options,
    unsetPaths: resolveManagedUnsetPathsForWrite(options.unsetPaths),
    env: context.deps.env,
    lowerPrecedenceEnv: context.deps.lowerPrecedenceEnv,
    homedir: context.deps.homedir,
  });
  const prepared = prepareConfigWritePayload(
    context,
    snapshot,
    topology,
    options,
    deferredPluginMigrations,
  );
  return options.allowDestructiveWrite === true
    ? []
    : resolveConfigWriteBlockingReasons(prepared.suspiciousReasons, options);
}
