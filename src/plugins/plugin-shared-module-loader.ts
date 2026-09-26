import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { safeRealpathSync } from "./path-safety.js";
import type { PluginModuleLoader } from "./plugin-cache-artifacts.js";
import { withPluginCache, type PluginCache } from "./plugin-cache.js";
import type {
  PluginModuleLoaderOwner,
  PluginModuleLoaderRecovery,
} from "./plugin-instance.types.js";
import { fingerprintPluginRuntimeArtifact } from "./plugin-runtime-artifact-identity.js";

const state = resolveGlobalSingleton(Symbol.for("openclaw.sharedPluginModuleIdentity"), () => ({
  sources: new WeakMap<object, Map<string, string | undefined>>(),
  warnings: new WeakMap<PluginModuleLoaderOwner, string>(),
}));
const log = createSubsystemLogger("plugins");

/** The loaded module owns its original artifact identity across registry replacements. */
export function bindSharedPluginModuleLoader(params: {
  instance: PluginModuleLoaderOwner;
  rootDir: string;
  cache: PluginCache;
  loader: PluginModuleLoader;
}): void {
  const { instance, cache, loader } = params;
  const root = safeRealpathSync(params.rootDir) ?? path.resolve(params.rootDir);
  let currentIdentity: string | undefined;
  try {
    currentIdentity = fingerprintPluginRuntimeArtifact({
      pluginId: instance.pluginId,
      origin: "bundled",
      rootDir: root,
    });
  } catch (error) {
    // Observability must not prevent an otherwise valid plugin from starting.
    log.warn(
      `Bundled plugin ${instance.pluginId} identity unavailable: ${formatErrorMessage(error)}`,
    );
  }
  createSharedModuleBinding(cache, loader, root, currentIdentity)(instance);
}

// Recovery keeps loader facts, never the predecessor instance or its invocation frame.
function createSharedModuleBinding(
  cache: PluginCache,
  loader: PluginModuleLoader,
  root: string,
  currentIdentity: string | undefined,
) {
  const load = (source: string) => withPluginCache(cache, () => loader(toSafeImportPath(source)));
  const bind = (target: PluginModuleLoaderOwner) => {
    target.bindModuleLoader((source) => {
      const value = load(source);
      if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return value;
      }
      let identities = state.sources.get(value);
      if (!identities) {
        identities = new Map();
        state.sources.set(value, identities);
      }
      if (!identities.has(root)) {
        identities.set(root, currentIdentity);
      } else {
        const loadedIdentity = identities.get(root);
        if (!loadedIdentity || !currentIdentity || loadedIdentity !== currentIdentity) {
          state.warnings.set(
            target,
            !loadedIdentity || !currentIdentity
              ? "Compiled bundled plugin code remains loaded and its files could not be verified. Restart the Gateway to load edited code."
              : "Compiled bundled plugin code remains loaded. Restart the Gateway to load edited code.",
          );
        }
      }
      return value;
    });
    target.bindModuleLoaderRecovery(captureRecovery);
  };
  const captureRecovery = (): PluginModuleLoaderRecovery => {
    let released = false;
    return {
      bind(target) {
        if (released) {
          throw new Error("Plugin module recovery has already been consumed or released");
        }
        released = true;
        bind(target);
      },
      dispose() {
        released = true;
      },
    };
  };
  return bind;
}

export function getSharedPluginCodeReloadWarning(
  instance: PluginModuleLoaderOwner,
): string | undefined {
  return state.warnings.get(instance);
}
