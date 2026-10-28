import type { InspectionNativeEsmRetention, PluginModuleLoader } from "./plugin-cache-artifacts.js";
import type {
  capturePluginGenerationArtifact,
  PluginGenerationArtifact,
} from "./plugin-generation-artifact.js";
import type { PluginRecoverySource } from "./plugin-generation-source-lookup.js";
import type {
  PluginModuleLoaderOwner,
  PluginModuleLoaderRecovery,
} from "./plugin-instance.types.js";
import type { PluginNativeRecovery } from "./plugin-native-admission.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";

export type PluginInstanceModuleLoaderParams = {
  instance: PluginModuleLoaderOwner;
  origin: PluginOrigin;
  source: string;
  rootDir: string;
  devSourceRoot?: string | null;
  standalone?: boolean;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  expectedSourceDigest?: string;
  createHostModuleLoader?: () => PluginModuleLoader;
  recoverySourceMap?: (source: string) => string;
  nativeRecovery?: PluginNativeRecovery;
  /**
   * Installer-proven identity of an immutable install, set only when the owner registry
   * is an uncached inspection. Loads with the same identity may share evaluated code.
   */
  inspectionSourceIdentity?: string;
  inspectionRetention?: InspectionNativeEsmRetention;
  /**
   * False when no caller can run plugin state operations through this instance, so bundled
   * operation modules are never captured for it.
   */
  stateOperations?: false;
  preparedArtifact?: {
    artifact: PluginGenerationArtifact;
    attachModuleSource: (resolve: (filename: string) => string) => void;
  };
};

type RecoveryLoadFacts = Pick<
  PluginInstanceModuleLoaderParams,
  "origin" | "source" | "devSourceRoot" | "standalone" | "pluginSdkResolution" | "recoverySourceMap"
> & { sourceDigest?: string };

function createRecoverySourceMap(
  resolve: PluginRecoverySource["resolve"],
  previous: RecoveryLoadFacts["recoverySourceMap"],
) {
  return (source: string) => resolve(previous?.(source) ?? source);
}

// This custody is transferred to another instance. Keep its lexical scope free
// of the predecessor instance, registry, artifact, and host-loader factory.
function createSourceModuleRecovery(
  facts: RecoveryLoadFacts,
  recovery: PluginRecoverySource,
  bindInstance: (params: PluginInstanceModuleLoaderParams) => void,
): PluginModuleLoaderRecovery {
  let state: "available" | "bound" | "disposed" = "available";
  let disposal: Promise<void> | undefined;
  return {
    bind(instance) {
      if (state !== "available") {
        throw new Error("Plugin module recovery has already been consumed or released");
      }
      instance.onModuleDispose(recovery.disposeAsync);
      state = "bound";
      bindInstance({
        instance,
        origin: facts.origin,
        source: recovery.resolve(facts.source),
        rootDir: recovery.rootDir,
        devSourceRoot: facts.devSourceRoot,
        standalone: facts.standalone,
        pluginSdkResolution: facts.pluginSdkResolution,
        recoverySourceMap: createRecoverySourceMap(recovery.resolve, facts.recoverySourceMap),
        nativeRecovery: recovery.native,
      });
      instance.sourceDigest = facts.sourceDigest;
    },
    async dispose() {
      if (state === "available") {
        state = "disposed";
        disposal = recovery.disposeAsync();
      }
      await disposal;
    },
  };
}

/** Transfers a recovery snapshot to a fresh instance and maps its original entry paths. */
export function preparePluginModuleLoaderRecovery(
  params: PluginInstanceModuleLoaderParams,
  artifact: Pick<ReturnType<typeof capturePluginGenerationArtifact>, "captureRecoverySource">,
  bindInstance: (params: PluginInstanceModuleLoaderParams) => void,
): PluginModuleLoaderOwner["bindModuleLoader"] {
  const facts: RecoveryLoadFacts = {
    origin: params.origin,
    source: params.source,
    devSourceRoot: params.devSourceRoot,
    standalone: params.standalone,
    pluginSdkResolution: params.pluginSdkResolution,
    recoverySourceMap: params.recoverySourceMap,
  };
  params.instance.bindModuleLoaderRecovery(async () =>
    createSourceModuleRecovery(
      { ...facts, sourceDigest: params.instance.sourceDigest },
      await artifact.captureRecoverySource(),
      bindInstance,
    ),
  );
  return (load, hasSource) => {
    const mapSource = params.recoverySourceMap;
    params.instance.bindModuleLoader(
      mapSource ? (source) => load(mapSource(source)) : load,
      mapSource && hasSource
        ? (source) => {
            let mapped: string;
            try {
              mapped = mapSource(source);
            } catch {
              return false;
            }
            return hasSource(mapped);
          }
        : hasSource,
    );
  };
}
