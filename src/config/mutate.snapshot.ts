import { createConfigRuntimeEnvBase } from "./config-env-vars.js";
import { GATEWAY_CONFIG_SELECTION_ENV_KEYS } from "./gateway-env-selection.js";
import { createConfigIO, readConfigFileSnapshotForWrite, type ConfigWriteOptions } from "./io.js";
import { resolveManagedRuntimeEnvBaseline } from "./io.runtime-env.js";
import type { ConfigMutationIO } from "./mutate.io.types.js";
import { hasManagedRuntimeConfigWriteOwner } from "./runtime-snapshot.js";

export async function readConfigSnapshotForMutation(params: {
  ownedConfigPathForWrite?: string;
  io?: ConfigMutationIO;
  writeOptions?: ConfigWriteOptions;
}): ReturnType<typeof readConfigFileSnapshotForWrite> {
  const options = {
    ...(params.writeOptions?.skipPluginValidation ? { skipPluginValidation: true } : {}),
    ...(params.writeOptions?.observe === false ? { observe: false } : {}),
    ...(params.writeOptions?.deferredPluginMigrations !== undefined
      ? { deferredPluginMigrations: params.writeOptions.deferredPluginMigrations }
      : {}),
    ...(params.writeOptions?.preservedLegacyRootKeys
      ? { preservedLegacyRootKeys: params.writeOptions.preservedLegacyRootKeys }
      : {}),
  };
  if (params.io) {
    return await params.io.readConfigFileSnapshotForWrite(options);
  }
  if (params.ownedConfigPathForWrite) {
    const { skipPluginValidation, ...readOptions } = options;
    const ioOptions = {
      ...readOptions,
      configPath: params.ownedConfigPathForWrite,
      ...(skipPluginValidation ? { pluginValidation: "skip" as const } : {}),
    };
    const io = hasManagedRuntimeConfigWriteOwner(params.ownedConfigPathForWrite)
      ? createConfigIO({
          ...ioOptions,
          env: createConfigRuntimeEnvBase(
            resolveManagedRuntimeEnvBaseline().sourceConfig,
            process.env,
            {
              preservedKeys: GATEWAY_CONFIG_SELECTION_ENV_KEYS,
            },
          ),
        })
      : createConfigIO(ioOptions);
    return await io.readConfigFileSnapshotForWrite();
  }
  return await readConfigFileSnapshotForWrite(options);
}
