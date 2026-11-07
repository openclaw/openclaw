import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.types.js";
import { capturePluginSnapshotGeneration } from "./plugin-generation-capture.js";
import { PluginSnapshotDependencyError } from "./plugin-snapshot-dependency-error.js";
import type { AcquiredPluginSharedSourceSnapshot } from "./plugin-source-snapshot-shared.js";

/** One execution owner borrows authenticated source without copying the shared closure. */
export function createPluginSharedSnapshotGeneration(
  snapshot: AcquiredPluginSharedSourceSnapshot,
): PluginGenerationArtifact {
  const aliases = Object.entries(snapshot.sourceAliases).toSorted(
    ([left], [right]) => right.length - left.length,
  );
  let disposed = false;
  let privateArtifact: PluginGenerationArtifact | undefined;
  const assertLive = () => {
    if (disposed) {
      throw new Error("Plugin shared source custody has closed");
    }
  };
  const resolve = (filename: string, rejectHardlinks = false): string => {
    assertLive();
    let selected = path.resolve(filename);
    const alias = aliases.find(([original]) => isPathInside(original, selected));
    if (alias) {
      selected = path.join(alias[1], path.relative(alias[0], selected));
    }
    for (let pass = 0; pass <= snapshot.sourceLinks.size; pass++) {
      const link = [...snapshot.sourceLinks].find(([from]) => isPathInside(from, selected));
      if (!link) {
        if (!snapshot.sourcePaths.has(selected)) {
          throw new PluginSnapshotDependencyError(filename);
        }
        if (rejectHardlinks && snapshot.sourceHardlinks.has(selected)) {
          throw new PluginSnapshotDependencyError(filename);
        }
        return selected;
      }
      selected = path.join(link[1], path.relative(link[0], selected));
    }
    throw new PluginSnapshotDependencyError(filename);
  };
  const originalFor = (filename: string) => {
    const alias = aliases.find(([, captured]) => isPathInside(captured, filename));
    return alias ? path.join(alias[0], path.relative(alias[1], filename)) : undefined;
  };
  const privateGeneration = () => {
    assertLive();
    // Recovery and native admission retain the existing per-instance custody contract.
    // The reader does not use this path for ordinary source-module loading.
    privateArtifact ??= capturePluginSnapshotGeneration(snapshot);
    return privateArtifact;
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    try {
      privateArtifact?.dispose();
    } finally {
      snapshot.release();
    }
  };
  return {
    rootDir: snapshot.rootDir,
    boundaryRoot: snapshot.payloadRoot,
    sourceRoot: snapshot.sourceRoot,
    sourceAliases: { ...snapshot.sourceAliases },
    sourceDigest: snapshot.sourceDigest,
    frozenSource: true,
    sharedSnapshot: snapshot,
    assertFrozenModule: (filename) => void resolve(filename),
    linkHost: (hostRoot) => privateGeneration().linkHost(hostRoot),
    hasSource: (filename) => {
      try {
        resolve(filename);
        return true;
      } catch (error) {
        if (error instanceof PluginSnapshotDependencyError) {
          return false;
        }
        throw error;
      }
    },
    resolve,
    sourceForCaptured: originalFor,
    moduleRoot: (filename) => {
      try {
        resolve(filename);
        return snapshot.rootDir;
      } catch (error) {
        if (error instanceof PluginSnapshotDependencyError) {
          return undefined;
        }
        throw error;
      }
    },
    moduleFacts: (filename) => privateGeneration().moduleFacts(resolve(filename)),
    assertModuleAvailable: (filename) => snapshot.assertMemberPath(resolve(filename)),
    prepareModule: (filename) => privateGeneration().prepareModule(resolve(filename)),
    prepareDependency: (filename, specifier) =>
      privateGeneration().prepareDependency(resolve(filename), specifier),
    prepareNativeScopes: (filename) =>
      privateGeneration().prepareNativeScopes(filename && resolve(filename)),
    prepareNativeModule: (filename, specifier) =>
      privateGeneration().prepareNativeModule(resolve(filename), specifier),
    captureModule: (filename, specifier, conditions) =>
      privateGeneration().captureModule(resolve(filename), specifier, conditions),
    captureResolvedModule: (filename) => resolve(filename),
    captureRecoverySource: () => privateGeneration().captureRecoverySource(),
    retainSourceCustody: () => privateGeneration().retainSourceCustody(),
    dispose,
    async disposeAsync() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        await privateArtifact?.disposeAsync();
      } finally {
        await snapshot.releaseAsync();
      }
    },
  };
}
