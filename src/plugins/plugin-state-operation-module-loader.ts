import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { isTypeScriptPackageEntry } from "./package-entrypoints.js";
import {
  capturePluginGenerationArtifact,
  type PluginGenerationArtifact,
} from "./plugin-generation-artifact.js";
import type {
  PluginModuleLoaderOwner,
  PluginModuleLoaderRecovery,
} from "./plugin-instance.types.js";
import { getSharedPluginCodeReloadWarning } from "./plugin-shared-module-loader.js";
import { bindPluginStateOperationModuleSource } from "./plugin-state-operation-source.js";
import {
  preparePluginLoaderAliases,
  resolveLoaderPackageRoot,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";

/** Select the same operation closure for inline and worker preparation. */
export function resolveBundledPluginStateOperationCapture(params: {
  rootDir: string;
  source: string;
}) {
  const sourceFamily = isTypeScriptPackageEntry(params.source);
  const operationDirectory = sourceFamily ? params.rootDir : path.dirname(params.source);
  const entries = fs
    .readdirSync(operationDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /-operation-api\.[cm]?[jt]s$/u.test(entry.name) &&
        isTypeScriptPackageEntry(entry.name) === sourceFamily,
    )
    .map((entry) => path.join(operationDirectory, entry.name))
    .toSorted();
  if (entries.length === 0) {
    return undefined;
  }
  // Keep shared build chunks in scope without making the capture an SDK host package.
  const hostRoot = !sourceFamily && resolveLoaderPackageRoot({ modulePath: params.source });
  const buildRoot =
    hostRoot &&
    ["dist", "dist-runtime"]
      .map((directory) => path.join(hostRoot, directory))
      .find((directory) => isPathInside(path.join(directory, "extensions"), operationDirectory));
  return { rootDir: buildRoot || params.rootDir, source: entries, standalone: true as const };
}

/** Bundled worker modules share captured bytes across logical recovery of the same host code. */
export function captureBundledPluginStateOperationModules(params: {
  rootDir: string;
  source: string;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  preparedArtifact?: PluginGenerationArtifact;
}) {
  const capture = params.preparedArtifact
    ? undefined
    : resolveBundledPluginStateOperationCapture(params);
  const artifact =
    params.preparedArtifact ??
    (capture && capturePluginGenerationArtifact(capture.rootDir, capture.source));
  if (!artifact) {
    return undefined;
  }
  try {
    const aliases = preparePluginLoaderAliases({
      modulePath: params.source,
      moduleUrl: import.meta.url,
      devSourceRoot: params.devSourceRoot,
      pluginSdkResolution: params.pluginSdkResolution,
    });
    if (aliases.packageRoot) {
      artifact.linkHost(aliases.packageRoot);
    }
  } catch (error) {
    artifact.dispose();
    throw error;
  }
  let references = 0;
  let disposed = false;
  const retain = () => {
    if (disposed) {
      throw new Error("Plugin state operation source is no longer available");
    }
    references++;
  };
  const release = () => {
    if (--references === 0) {
      disposed = true;
      return artifact.disposeAsync();
    }
    return undefined;
  };
  const bind = (instance: PluginModuleLoaderOwner) => {
    instance.onModuleDispose(release);
    bindPluginStateOperationModuleSource({
      instance,
      rootDir: params.rootDir,
      source: params.source,
      origin: "bundled",
      artifact,
      assertCodeCurrent: () => {
        if (getSharedPluginCodeReloadWarning(instance)) {
          throw new Error(
            "Bundled plugin code changed; restart the Gateway before using state operations",
          );
        }
      },
    });
  };
  return {
    bind(instance: PluginModuleLoaderOwner) {
      retain();
      bind(instance);
    },
    capture(): PluginModuleLoaderRecovery {
      retain();
      let available = true;
      let disposal: Promise<void> | undefined;
      return {
        bind(instance) {
          if (!available) {
            throw new Error("Plugin operation module recovery was already consumed or released");
          }
          available = false;
          bind(instance);
        },
        async dispose() {
          if (available) {
            available = false;
            disposal = release();
          }
          await disposal;
        },
      };
    },
  };
}
