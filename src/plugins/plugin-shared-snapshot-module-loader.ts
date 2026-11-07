import {
  preparePluginModuleLoaderRecovery,
  type PluginInstanceModuleLoaderParams,
} from "./plugin-module-loader-recovery.js";
import { createPluginSnapshotChildHost } from "./plugin-snapshot-child-host.js";
import { createPluginSharedSnapshotModuleLoader } from "./plugin-source-snapshot-loader.js";
import { createPluginSharedSnapshotNativeLoader } from "./plugin-source-snapshot-native.js";
import { preparePluginLoaderAliases } from "./sdk-alias.js";

/** Bind one verified module namespace to the installation and instance owners. */
export function bindPluginSharedSnapshotModuleLoader(
  params: PluginInstanceModuleLoaderParams,
  rebind: (params: PluginInstanceModuleLoaderParams) => void,
): boolean {
  const sharedArtifact = params.preparedArtifact?.artifact;
  if (!sharedArtifact?.sharedSnapshot) {
    return false;
  }
  {
    if (
      params.expectedSourceDigest !== undefined &&
      params.expectedSourceDigest !== sharedArtifact.sourceDigest
    ) {
      throw new Error(
        `Plugin ${params.instance.pluginId} source changed after installation; inspect it before reloading.`,
      );
    }
    const snapshot = sharedArtifact.sharedSnapshot;
    const aliases = preparePluginLoaderAliases({
      modulePath: params.source,
      moduleUrl: import.meta.url,
      devSourceRoot: params.devSourceRoot,
      pluginSdkResolution: params.pluginSdkResolution,
    });
    const report = params.preparedArtifact?.onInvalidSnapshot;
    const child = createPluginSnapshotChildHost({
      snapshot,
      hostAliasContext: aliases.context,
      onInvalidSnapshot: report,
    });
    let native: ReturnType<typeof createPluginSharedSnapshotNativeLoader> | undefined;
    const loader = createPluginSharedSnapshotModuleLoader({
      snapshot,
      onInvalidSnapshot: (error) => void report?.(error),
      resolveHostModule: (specifier) => aliases.resolveAlias(specifier),
      loadBuiltin: (specifier) => child.loadBuiltin(specifier),
      loadNativeModule: (filename) =>
        (native ??= createPluginSharedSnapshotNativeLoader(snapshot)).load(filename),
    });
    params.instance.sourceDigest = sharedArtifact.sourceDigest;
    params.instance.onModuleDispose(async () => {
      try {
        await child.disposeAsync();
      } finally {
        loader.dispose();
        try {
          await native?.disposeAsync();
        } finally {
          await sharedArtifact.disposeAsync();
        }
      }
    });
    const bind = preparePluginModuleLoaderRecovery(params, sharedArtifact, rebind);
    bind(
      (source) => loader.requireModule(sharedArtifact.resolve(source)),
      (source) => sharedArtifact.hasSource(source),
    );
    return true;
  }
}
