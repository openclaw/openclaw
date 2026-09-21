import fs from "node:fs";
import path from "node:path";
import { isPathInside, relativePluginPathInsideRootSync } from "./path-safety.js";
import { createPluginSourceCapture } from "./plugin-package-metadata-capture.js";

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

function createRecoverySourceDisposal(recovery: ReturnType<typeof createPluginSourceCapture>) {
  return {
    dispose: () => recovery.dispose(),
    disposeAsync: () => recovery.disposeAsync(),
  };
}

function captureRecoverySource({
  rootDir,
  sourceRoot,
  capturedRoot,
  boundaryRoot,
  capturedPaths,
}: {
  rootDir: string;
  sourceRoot: string;
  capturedRoot: string;
  boundaryRoot: string;
  capturedPaths: ReadonlyMap<string, string>;
}) {
  const recovery = createPluginSourceCapture();
  try {
    // Preserve relative dependency links without reopening an updated package.
    fs.cpSync(boundaryRoot, recovery.directory, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const relocate = (filename: string) =>
      path.join(recovery.directory, path.relative(boundaryRoot, filename));
    const sources = new Map(
      Array.from(capturedPaths, ([source, captured]) => [source, relocate(captured)]),
    );
    return {
      rootDir: relocate(capturedRoot),
      resolve: createRecoverySourceResolver(rootDir, sourceRoot, sources),
      ...createRecoverySourceDisposal(recovery),
    };
  } catch (error) {
    recovery.dispose();
    throw error;
  }
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
}: {
  rootDir: string;
  sourceRoot: string;
  capturedRoot: string;
  boundaryRoot: string;
  capturedPaths: ReadonlyMap<string, string>;
  hardlinkedSources: ReadonlySet<string>;
  assertModuleAvailable: (filename: string) => void;
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
    captureRecoverySource: () =>
      captureRecoverySource({ rootDir, sourceRoot, capturedRoot, boundaryRoot, capturedPaths }),
  };
}
