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

/** Canonical exports retain file identity across Jiti wrappers and registry replacements. */
export function bindSharedPluginModuleLoader(params: {
  instance: PluginModuleLoaderOwner;
  rootDir: string;
  cache: PluginCache;
  loader: PluginModuleLoader;
  source?: {
    bind(instance: PluginModuleLoaderOwner): void;
    capture(): PluginModuleLoaderRecovery;
  };
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
  createSharedModuleBinding(cache, loader, root, currentIdentity, params.source)(instance);
}

// Recovery keeps loader facts, never the predecessor instance or its invocation frame.
function createSharedModuleBinding(
  cache: PluginCache,
  loader: PluginModuleLoader,
  root: string,
  currentIdentity: string | undefined,
  sourceCustody?: {
    bind(instance: PluginModuleLoaderOwner): void;
    capture(): PluginModuleLoaderRecovery;
  },
) {
  const load = (source: string) => withPluginCache(cache, () => loader(toSafeImportPath(source)));
  const bind = (target: PluginModuleLoaderOwner, recovery?: PluginModuleLoaderRecovery) => {
    target.bindModuleLoader((source) => {
      const value = load(source);
      if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return value;
      }
      const exported: unknown = Reflect.get(value, "default");
      const identity =
        exported && (typeof exported === "object" || typeof exported === "function")
          ? exported
          : value;
      const identities = state.sources.get(identity) ?? new Map<string, string | undefined>();
      state.sources.set(identity, identities);
      if (!identities.has(root)) {
        identities.set(root, currentIdentity);
      } else {
        const loadedIdentity = identities.get(root);
        if (!loadedIdentity || !currentIdentity || loadedIdentity !== currentIdentity) {
          state.warnings.set(
            target,
            !loadedIdentity || !currentIdentity
              ? "Bundled plugin code remains loaded and its files could not be verified. Restart the Gateway to load edited code."
              : "Bundled plugin code remains loaded. Restart the Gateway to load edited code.",
          );
        }
      }
      return value;
    });
    if (recovery) {
      recovery.bind(target);
    } else {
      sourceCustody?.bind(target);
    }
    target.bindModuleLoaderRecovery(captureRecovery);
  };
  const captureRecovery = (): PluginModuleLoaderRecovery => {
    const recovery = sourceCustody?.capture();
    let released = false;
    return {
      bind(target) {
        if (released) {
          throw new Error("Plugin module recovery has already been consumed or released");
        }
        released = true;
        bind(target, recovery);
      },
      dispose() {
        if (!released) {
          released = true;
          recovery?.dispose();
        }
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
