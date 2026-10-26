import path from "node:path";
import type {
  PluginStateOperationModule,
  PluginStateOperationModuleSource,
} from "../plugin-state/plugin-state-store.native-binding.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import {
  isTypeScriptPackageEntry,
  PUBLIC_SURFACE_SOURCE_EXTENSIONS,
} from "./package-entrypoints.js";
import { relativePluginPathInsideRootSync } from "./path-safety.js";
import type { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import type { PluginModuleLoaderOwner } from "./plugin-instance.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

const sources = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginStateOperationModuleSources"),
  () => new WeakMap<PluginModuleLoaderOwner, PluginStateOperationModuleSource>(),
);

/** The instance's captured package, never a later registry selection, owns operation code. */
export function bindPluginStateOperationModuleSource(params: {
  instance: PluginModuleLoaderOwner;
  rootDir: string;
  source: string;
  origin: PluginOrigin;
  artifact: Pick<
    ReturnType<typeof capturePluginGenerationArtifact>,
    "rootDir" | "hasSource" | "resolve" | "prepareModule"
  >;
  assertCodeCurrent?: () => void;
}) {
  const { instance, artifact, origin } = params;
  const rejectHardlinks = shouldRejectHardlinkedPluginFiles({ origin, rootDir: params.rootDir });
  const sourceFamily = isTypeScriptPackageEntry(params.source);
  const rootDir = path.resolve(params.rootDir);
  // Windows can spell the root and its source differently (8.3 aliases); the
  // captured artifact is keyed by the root's spelling.
  const familyRelative = sourceFamily
    ? ""
    : relativePluginPathInsideRootSync(rootDir, path.dirname(path.resolve(params.source)));
  if (familyRelative === undefined) {
    throw new Error("Plugin operation source family is outside its plugin root");
  }
  const familyDirectory = path.join(rootDir, familyRelative);
  const extensions = PUBLIC_SURFACE_SOURCE_EXTENSIONS.filter(
    (extension) => isTypeScriptPackageEntry(`module${extension}`) === sourceFamily,
  );
  const modules = new Map<string, PluginStateOperationModule>();
  sources.set(instance, {
    resolve(moduleName) {
      instance.lifecycle.signal.throwIfAborted();
      params.assertCodeCurrent?.();
      const existing = modules.get(moduleName);
      if (existing) {
        return existing;
      }
      const match = /^([a-z0-9][a-z0-9.-]*-operation-api)\.[cm]?[jt]s$/u.exec(moduleName);
      if (!match) {
        throw new Error("Plugin state operations require a top-level operation-api filename");
      }
      const requestedExtension = path.extname(moduleName);
      const candidates = [
        ...(extensions.some((extension) => extension === requestedExtension)
          ? [requestedExtension]
          : []),
        ...extensions.filter((extension) => extension !== requestedExtension),
      ];
      for (const extension of candidates) {
        const selected = path.join(familyDirectory, `${match[1]}${extension}`);
        if (!artifact.hasSource(selected)) {
          continue;
        }
        const modulePath = artifact.resolve(selected, rejectHardlinks);
        artifact.prepareModule(modulePath);
        const captured = Object.freeze({
          modulePath,
          boundaryRoot: artifact.rootDir,
          origin,
          pluginId: instance.pluginId,
        });
        modules.set(moduleName, captured);
        return captured;
      }
      throw new Error("Plugin state operation module is absent from its captured source family");
    },
  });
  instance.onModuleDispose(() => {
    sources.delete(instance);
    modules.clear();
  });
}

/** Bind one store to the already-selected instance before its caller can yield. */
export function capturePluginStateOperationModuleSource(
  instance: PluginModuleLoaderOwner | undefined,
  assertCurrent: () => void,
): PluginStateOperationModuleSource | undefined {
  const source = instance && sources.get(instance);
  if (!source) {
    return undefined;
  }
  assertCurrent();
  return {
    resolve(moduleName) {
      assertCurrent();
      return source.resolve(moduleName);
    },
  };
}
