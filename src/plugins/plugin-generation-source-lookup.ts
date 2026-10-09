import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside, relativePluginPathInsideRootSync } from "./path-safety.js";
import { PluginSourceRecoveryUnavailableError } from "./plugin-instance-error.js";
import type { PluginNativeRecovery } from "./plugin-native-admission.js";
import {
  createPluginNativeReferenceValidator,
  linkPluginNativeReference,
} from "./plugin-native-reference.js";
import {
  createPluginSourceCapture,
  findPluginCapturedPackage,
  type PluginPackageCapture,
} from "./plugin-package-metadata-capture.js";
import type { PluginNativeArtifactFact } from "./plugin-source-admission.types.js";

function canonicalSource(rootDir: string, sourceRoot: string, source: string): string {
  const lexical = path.resolve(source);
  const relative = relativePluginPathInsideRootSync(rootDir, lexical);
  return relative === undefined ? lexical : path.join(sourceRoot, relative);
}

function getCapturedSource(
  sources: ReadonlyMap<string, string>,
  rootDir: string,
  sourceRoot: string,
  source: string,
): string | undefined {
  const lexical = path.resolve(source);
  return sources.get(lexical) ?? sources.get(canonicalSource(rootDir, sourceRoot, lexical));
}

// A recovery resolver outlives its producer. Its closure contains copied path
// facts, never the producer's availability callback or live captured graph.
function createRecoverySourceResolver(
  rootDir: string,
  sourceRoot: string,
  sources: ReadonlyMap<string, string>,
) {
  return (source: string) => {
    const captured = getCapturedSource(sources, rootDir, sourceRoot, source);
    if (!captured) {
      throw new Error("Plugin recovery entry is outside its captured source package");
    }
    return captured;
  };
}

function createRecoverySourceDisposal(
  recovery: ReturnType<typeof createPluginSourceCapture>,
  native?: PluginNativeRecovery,
) {
  return {
    dispose: () => {
      try {
        recovery.dispose();
      } finally {
        native?.dispose();
      }
    },
    disposeAsync: async () => {
      await Promise.all([recovery.disposeAsync(), ...(native ? [native.disposeAsync()] : [])]);
    },
  };
}
/** Resolves captured source identities and gives recovery its own copy of their bytes. */
export function createPluginGenerationSourceLookup({
  rootDir,
  sourceRoot,
  capturedRoot,
  boundaryRoot,
  capturedPaths,
  hardlinkedSources,
  assertModuleAvailable,
  captureNativeRecovery,
}: {
  rootDir: string;
  sourceRoot: string;
  capturedRoot: string;
  boundaryRoot: string;
  capturedPaths: ReadonlyMap<string, string>;
  hardlinkedSources: ReadonlySet<string>;
  assertModuleAvailable: (filename: string) => void;
  captureNativeRecovery?: () => PluginNativeRecovery;
}) {
  const resolveCaptured = (source: string) => {
    const captured = getCapturedSource(capturedPaths, rootDir, sourceRoot, source);
    return captured && isPathInside(capturedRoot, captured) ? captured : undefined;
  };
  return {
    hasSource: (source: string) => resolveCaptured(source) !== undefined,
    resolve: (source: string, rejectHardlinks = false) => {
      // Public exports may be loaded for the first time after the original package
      // has been edited or removed. Resolve only through facts captured with it.
      const captured = resolveCaptured(source);
      if (!captured) {
        throw new Error("Plugin entry is outside its captured source package");
      }
      if (rejectHardlinks && hardlinkedSources.has(captured)) {
        throw new Error("Plugin source is hardlinked; use a separate file and reload.");
      }
      assertModuleAvailable(captured);
      return captured;
    },
    captureRecoverySource: () => {
      for (const captured of new Set(capturedPaths.values())) {
        assertModuleAvailable(captured);
      }
      const recovery = createPluginSourceCapture();
      let native: PluginNativeRecovery | undefined;
      try {
        native = captureNativeRecovery?.();
        const hardlinkedTargets = new Map<string, PluginNativeArtifactFact>();
        // Preserve relative dependency links without reopening an updated package.
        fs.cpSync(boundaryRoot, recovery.directory, {
          recursive: true,
          verbatimSymlinks: true,
          filter: (from, to) => {
            const fact = native?.references.get(from);
            if (!fact) {
              return true;
            }
            const retained = { ...fact, sourceIdentity: fact.capturedIdentity };
            if (linkPluginNativeReference(fact.capturedPath, to, retained) === "hardlink") {
              hardlinkedTargets.set(to, retained);
            }
            native!.references.set(from, retained);
            return false;
          },
        });
        const assertReference = createPluginNativeReferenceValidator(recovery.directory, rootDir);
        for (const [target, fact] of hardlinkedTargets) {
          assertReference(target, fact, native!.namespaces.get(fact.namespace)!);
        }
        const relocate = (filename: string) =>
          path.join(recovery.directory, path.relative(boundaryRoot, filename));
        // A partial capture can copy successfully while losing an already-loaded companion.
        for (const captured of new Set(capturedPaths.values())) {
          fs.lstatSync(relocate(captured));
        }
        const sources = new Map(
          Array.from(capturedPaths, ([source, captured]) => [source, relocate(captured)]),
        );
        return {
          rootDir: relocate(capturedRoot),
          resolve: createRecoverySourceResolver(rootDir, sourceRoot, sources),
          native: native && {
            ...native,
            references: new Map(
              Array.from(native.references, ([source, fact]) => [relocate(source), fact]),
            ),
            directories: new Map(
              Array.from(native.directories, ([source, namespace]) => [
                relocate(source),
                namespace,
              ]),
            ),
          },
          ...createRecoverySourceDisposal(recovery, native),
        };
      } catch (error) {
        createRecoverySourceDisposal(recovery, native).dispose();
        if (hasErrnoCode(error, "ENOENT")) {
          throw new PluginSourceRecoveryUnavailableError(error);
        }
        throw error;
      }
    },
  };
}

/** Resolve first-demand executable files through the same captured-source availability owner. */
export function createPluginResolvedModuleCapture({
  capturedPaths,
  assertModuleAvailable,
  captureAdmitted,
  captureExecutableFile,
  packages,
  directory,
}: {
  capturedPaths: Map<string, string>;
  assertModuleAvailable: (filename: string) => void;
  captureAdmitted: ReturnType<typeof createPluginSourceCapture>["capture"];
  captureExecutableFile: (filename: string) => string | undefined;
  packages: ReadonlyMap<string, PluginPackageCapture>;
  directory: string;
}) {
  return (filename: string) => {
    const known = capturedPaths.get(path.resolve(filename));
    if (known) {
      assertModuleAvailable(known);
      return known;
    }
    return captureAdmitted(() => {
      const captured = findPluginCapturedPackage(packages, filename, directory);
      // import.meta.url can name a deferred peer through a private dependency link.
      const original = captured
        ? path.join(captured.owner.sourceRoot, path.relative(captured.root, filename))
        : filename;
      const source = captureExecutableFile(original);
      const target = source ? capturedPaths.get(source) : undefined;
      if (target) {
        capturedPaths.set(path.resolve(filename), target);
      }
      return target;
    }).value;
  };
}
