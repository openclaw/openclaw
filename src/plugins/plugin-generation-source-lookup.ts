import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { throwSettledAggregate } from "../infra/error-graph-internal.js";
import { isPathInside, relativePluginPathInsideRootSync } from "./path-safety.js";
import { getPluginCache } from "./plugin-cache.js";
import { getPluginGenerationMetrics } from "./plugin-generation-metrics.js";
import type {
  PluginFrozenSourceSnapshot,
  PluginSourceSnapshotFacts,
} from "./plugin-generation-source.types.js";
import {
  markPluginSourceAcquisitionError,
  markPluginSourcePreparationOperation,
  PluginSourceRecoveryUnavailableError,
} from "./plugin-instance-error.js";
import type { PluginNativeRecovery } from "./plugin-native-admission.js";
import {
  createPluginNativeReferenceValidator,
  linkPluginNativeReference,
} from "./plugin-native-reference.js";
import {
  createPluginDependencyResolver,
  createPluginSourceCapture,
  type PluginModuleCapture,
  type createPluginPackageMetadataCapture,
  findPluginCapturedPackage,
  type PluginPackageCapture,
} from "./plugin-package-metadata-capture.js";
import type { PluginNativeArtifactFact } from "./plugin-source-admission.types.js";
import { readPluginCapturedCode } from "./plugin-source-file.js";
import type { PluginCapturedSourceFact } from "./plugin-source-verification.js";
// These owner-defined operations copy captured source trees; their cost scales with
// package size and filesystem latency rather than the ordinary method deadline.
const sourceCaptureOperations = new WeakSet<object>();
export function markPluginSourceCaptureOperation<T extends (...args: never[]) => unknown>(
  operation: T,
): T {
  sourceCaptureOperations.add(operation);
  return operation;
}
export function isPluginSourceCaptureOperation(operation: object): boolean {
  return sourceCaptureOperations.has(operation);
}

type SourceCustody = {
  source: PluginRecoverySource;
  files: ReadonlyMap<string, PluginCapturedSourceFact>;
};
export type PluginSourceCustodyFork = Pick<SourceCustody, "source" | "files">;
type PluginGenerationCaptureArguments = [
  rootDir: string,
  entryFile?: string | readonly string[],
  execute?: <V>(run: () => V) => V,
  moduleSource?: (filename: string) => string,
  nativeRecovery?: PluginNativeRecovery,
  dependencyLookupBoundary?: Parameters<typeof createPluginDependencyResolver>[0],
];
const sourceCustody = new AsyncLocalStorage<{
  sources: Map<string, SourceCustody>;
}>();

/** Retain files across management phases, without retaining their callback instances or leases. */
export async function withPluginGenerationSourceCustody<T>(run: () => Promise<T>): Promise<T> {
  if (sourceCustody.getStore()) {
    return await run();
  }
  const scope = createPluginGenerationSourceCustody();
  try {
    return await scope.run(run);
  } finally {
    await scope.disposeAsync();
  }
}

function createPluginGenerationSourceCustody() {
  const scope = {
    sources: new Map<string, SourceCustody>(),
    async disposeAsync() {
      const results = await Promise.allSettled(
        [...this.sources.values()].map(({ source }) => source.disposeAsync()),
      );
      throwSettledAggregate(results, "Plugin source custody cleanup failed");
      this.sources.clear();
    },
  };
  return {
    run: <T>(run: () => T): T => sourceCustody.run(scope, run),
    disposeAsync: () => scope.disposeAsync(),
  };
}

/** Bind scoped file custody around an instance's independently constructed module graph. */
export function createPluginGenerationCapture<
  T extends {
    retainSourceCustody(): SourceCustody;
    dispose(): void;
  },
>(
  create: (
    ...args: [
      ...PluginGenerationCaptureArguments,
      retained?: PluginSourceCustodyFork,
      captureForCustody?: boolean,
    ]
  ) => T,
) {
  return (...args: PluginGenerationCaptureArguments): T => {
    const [rootDir, entryFile, execute, moduleSource, nativeRecovery, dependencyLookupBoundary] =
      args;
    const custody =
      execute && !nativeRecovery && !dependencyLookupBoundary && sourceCustody.getStore();
    if (!custody) {
      return create(...args);
    }
    const key = JSON.stringify([
      path.resolve(rootDir),
      typeof entryFile === "string"
        ? path.resolve(entryFile)
        : entryFile?.map((file) => path.resolve(file)),
    ]);
    let retained = custody.sources.get(key);
    if (!retained) {
      // This namespace is never executed; no instance can mutate the retained source bytes.
      const seed = create(
        rootDir,
        entryFile,
        (run) => run(),
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
      try {
        retained = seed.retainSourceCustody();
        custody.sources.set(key, retained);
      } finally {
        seed.dispose();
      }
    }
    const fork = retained.source.fork();
    try {
      fork.native?.retain(getPluginCache());
      return create(rootDir, entryFile, execute, moduleSource, undefined, undefined, {
        source: fork,
        files: retained.files,
      });
    } catch (error) {
      fork.dispose();
      throw error;
    }
  };
}

/** Reuse captured bytes across one management operation; source edits take effect next time. */
export function createPluginSourceFacts(
  dependencyLookupBoundary: Parameters<typeof createPluginDependencyResolver>[0],
  captureForCustody: boolean,
) {
  const files = new Map<string, PluginCapturedSourceFact>();
  const links = new Map<string, string>();
  return {
    files: captureForCustody ? files : undefined,
    recordLink(link: string, target: string) {
      if (captureForCustody && fs.lstatSync(link).isSymbolicLink()) {
        links.set(link, target);
      }
    },
    snapshot(
      directory: string,
      capturedDirectories: ReadonlySet<string>,
      hardlinkedSources: ReadonlySet<string>,
    ): PluginSourceSnapshotFacts {
      const relative = (file: string) => path.relative(directory, file);
      const directories = new Set([...capturedDirectories].map(relative));
      const relativeLinks = new Map(
        [...links].map(([file, target]) => [relative(file), relative(target)]),
      );
      for (const file of [...files.keys(), ...directories, ...relativeLinks.keys()]) {
        let parent = path.dirname(file);
        while (parent !== ".") {
          directories.add(parent);
          parent = path.dirname(parent);
        }
      }
      return {
        files,
        directories,
        links: relativeLinks,
        hardlinks: new Set([...hardlinkedSources].map(relative)),
      };
    },
    resolveDependency: createPluginDependencyResolver(dependencyLookupBoundary),
    captureCustody: (capture: () => PluginRecoverySource): SourceCustody => ({
      source: capture(),
      files,
    }),
  };
}

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

export type PluginRecoverySourceResolverSnapshot = Readonly<{
  rootDir: string;
  sourceRoot: string;
  sources: ReadonlyMap<string, string>;
}>;
const recoverySourceResolvers = new WeakMap<object, PluginRecoverySourceResolverSnapshot>();

/** Transfer only immutable lookup facts, never a call back into a retired source owner. */
export function snapshotPluginRecoverySourceResolver(
  resolve: object,
): PluginRecoverySourceResolverSnapshot | undefined {
  return recoverySourceResolvers.get(resolve);
}

export function restorePluginRecoverySourceResolver(
  snapshot: PluginRecoverySourceResolverSnapshot,
) {
  return createRecoverySourceResolver(snapshot.rootDir, snapshot.sourceRoot, snapshot.sources);
}

// A recovery resolver outlives its producer. Its closure contains copied path
// facts, never the producer's availability callback or live captured graph.
function createRecoverySourceResolver(
  rootDir: string,
  sourceRoot: string,
  sources: ReadonlyMap<string, string>,
) {
  const snapshot = { rootDir, sourceRoot, sources: new Map(sources) };
  const resolve = (source: string) => {
    const captured = getCapturedSource(snapshot.sources, rootDir, sourceRoot, source);
    if (!captured) {
      throw new Error("Plugin recovery entry is outside its captured source package");
    }
    return captured;
  };
  recoverySourceResolvers.set(resolve, snapshot);
  return resolve;
}

export type PluginRecoverySource = {
  frozenSource?: PluginFrozenSourceSnapshot;
  rootDir: string;
  directories: ReadonlySet<string>;
  sourceCapture: ReturnType<typeof createPluginSourceCapture>;
  native?: PluginNativeRecovery;
  resolve: (source: string) => string;
  fork: () => PluginRecoverySource;
  dispose: () => void;
  disposeAsync: () => Promise<void>;
};

function copyRecoverySource({
  rootDir,
  sourceRoot,
  capturedRoot,
  boundaryRoot,
  sources,
  directories,
  native: suppliedNative,
}: {
  rootDir: string;
  sourceRoot: string;
  capturedRoot: string;
  boundaryRoot: string;
  sources: ReadonlyMap<string, string>;
  directories: ReadonlySet<string>;
  native?: PluginNativeRecovery;
}): PluginRecoverySource {
  let native = suppliedNative;
  let recovery: ReturnType<typeof createPluginSourceCapture> | undefined;
  try {
    recovery = createPluginSourceCapture();
    const directory = recovery.directory;
    const relocate = (filename: string) =>
      path.join(directory, path.relative(boundaryRoot, filename));
    const hardlinkedTargets = new Map<string, PluginNativeArtifactFact>();
    const metrics = getPluginGenerationMetrics();
    let copiedBytes = 0;
    // Keep dependency links within the new capture without reopening installed packages.
    fs.cpSync(boundaryRoot, recovery.directory, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (from, to) => {
        const fact = native?.references.get(from);
        if (!fact) {
          const entry = fs.lstatSync(from);
          if (metrics && entry.isFile()) {
            copiedBytes += entry.size;
          }
          if (entry.isSymbolicLink()) {
            const target = fs.readlinkSync(from);
            const relative = path.isAbsolute(target)
              ? relativePluginPathInsideRootSync(boundaryRoot, target)
              : undefined;
            if (relative !== undefined) {
              // Windows junctions store absolute targets. A verbatim copy would
              // point at the seed after custody disposes it, then fail on fork.
              fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
              fs.symlinkSync(
                path.relative(path.dirname(to), path.join(directory, relative)),
                to,
                fs.statSync(from).isDirectory() ? "junction" : "file",
              );
              return false;
            }
          }
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
    if (metrics) {
      metrics.copiedBytes += copiedBytes;
    }
    const assertReference = createPluginNativeReferenceValidator(recovery.directory, rootDir);
    for (const [target, fact] of hardlinkedTargets) {
      assertReference(target, fact, native!.namespaces.get(fact.namespace)!);
    }
    const copiedSources = new Map(
      Array.from(sources, ([source, captured]) => [source, relocate(captured)]),
    );
    const previousNative = native;
    native = previousNative?.fork(relocate);
    previousNative?.dispose();
    const sourceCapture = recovery;
    const root = relocate(capturedRoot);
    const copiedDirectories = new Set([...directories].map(relocate));
    let disposed = false;
    return {
      rootDir: root,
      directories: copiedDirectories,
      sourceCapture,
      resolve: createRecoverySourceResolver(rootDir, sourceRoot, copiedSources),
      native,
      fork: markPluginSourceCaptureOperation(() => {
        if (disposed) {
          throw new Error("Plugin source recovery has been disposed");
        }
        return copyRecoverySource({
          rootDir,
          sourceRoot,
          capturedRoot: root,
          boundaryRoot: directory,
          sources: copiedSources,
          directories: copiedDirectories,
          native: native?.fork(),
        });
      }),
      dispose() {
        if (!disposed) {
          disposed = true;
          try {
            sourceCapture.dispose();
          } finally {
            native?.dispose();
          }
        }
      },
      async disposeAsync() {
        if (!disposed) {
          disposed = true;
          await Promise.all([sourceCapture.disposeAsync(), native?.disposeAsync()]);
        }
      },
    };
  } catch (error) {
    try {
      recovery?.dispose();
    } finally {
      native?.dispose();
    }
    if (hasErrnoCode(error, "ENOENT")) {
      throw new PluginSourceRecoveryUnavailableError(error);
    }
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
  capturedDirectories,
  hardlinkedSources,
  assertModuleAvailable,
  captureNativeRecovery,
}: {
  rootDir: string;
  sourceRoot: string;
  capturedRoot: string;
  boundaryRoot: string;
  capturedPaths: ReadonlyMap<string, string>;
  capturedDirectories: ReadonlySet<string>;
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
    resolve: markPluginSourcePreparationOperation((source: string, rejectHardlinks = false) => {
      // Public exports may be loaded for the first time after the original package
      // has been edited or removed. Resolve only through facts captured with it.
      const captured = resolveCaptured(source);
      if (!captured) {
        throw markPluginSourceAcquisitionError(
          new Error("Plugin entry is outside its captured source package"),
        );
      }
      if (rejectHardlinks && hardlinkedSources.has(captured)) {
        throw markPluginSourceAcquisitionError(
          new Error("Plugin source is hardlinked; use a separate file and reload."),
        );
      }
      assertModuleAvailable(captured);
      return captured;
    }),
    captureRecoverySource: markPluginSourceCaptureOperation(() => {
      for (const captured of new Set(capturedPaths.values())) {
        assertModuleAvailable(captured);
      }
      return copyRecoverySource({
        rootDir,
        sourceRoot,
        capturedRoot,
        boundaryRoot,
        sources: new Map(capturedPaths),
        directories: new Set(capturedDirectories),
        native: captureNativeRecovery?.(),
      });
    }),
  };
}

/** Keep first-demand module lookup and admission with the captured source graph. */
export function createPluginGenerationModuleLookup({
  capturedPaths,
  capturedDirectories,
  originalSources,
  moduleCaptures,
  metadataCapture,
  assertModuleAvailable,
  captureAdmitted,
  captureExecutableFile,
  executable,
  packages,
  directory,
}: {
  capturedPaths: Map<string, string>;
  capturedDirectories: ReadonlySet<string>;
  originalSources: ReadonlyMap<string, string>;
  moduleCaptures: ReadonlyMap<string, PluginModuleCapture>;
  metadataCapture: ReturnType<typeof createPluginPackageMetadataCapture>;
  assertModuleAvailable: (filename: string) => void;
  captureAdmitted: ReturnType<typeof createPluginSourceCapture>["capture"];
  captureExecutableFile: (filename: string) => string | undefined;
  executable: boolean;
  packages: ReadonlyMap<string, PluginPackageCapture>;
  directory: string;
}) {
  const packageForFile = (filename: string) =>
    findPluginCapturedPackage(packages, filename, directory)?.owner;
  return {
    boundaryRoot: directory,
    sourceForCaptured: (file: string) => originalSources.get(path.resolve(file)),
    moduleFacts: (importer: string): Readonly<PluginModuleCapture> | undefined =>
      moduleCaptures.get(importer),
    moduleRoot: (filename: string) =>
      originalSources.has(filename) ? packageForFile(filename)?.capturedRoot : undefined,
    assertModuleAvailable,
    prepareModule: markPluginSourcePreparationOperation((filename: string) => {
      // Directory capture is valid, but selecting that directory as a module is not.
      if (capturedDirectories.has(filename)) {
        readPluginCapturedCode(filename, true);
      }
      const owner = packageForFile(filename);
      const source = originalSources.get(filename);
      const needsEntry =
        executable && source && /\.[cm]?[jt]sx?$/.test(source) && !moduleCaptures.has(filename);
      if (!owner || ((owner.state === "entry" || owner.state === "body") && !needsEntry)) {
        return [];
      }
      return captureAdmitted(() => {
        // Loading another selected module must not capture a standalone workspace.
        owner.materialize(owner.state === "entry" ? source : undefined);
        if (needsEntry && owner.state !== "entry") {
          owner.materialize(source);
        }
      }).additions;
    }),
    prepareDependency: (importer: string, specifier: string) =>
      captureAdmitted(() => moduleCaptures.get(importer)?.prepareDependency(specifier)).additions,
    prepareNativeScopes: (importer?: string) => {
      const scope = importer ? moduleCaptures.get(importer)?.nativeScope : undefined;
      return scope?.prepareDependencies || metadataCapture.pending
        ? captureAdmitted(() => metadataCapture.prepare(scope))
        : undefined;
    },
    prepareNativeModule: (importer: string, specifier: string) =>
      captureAdmitted(() => {
        const packageMap =
          moduleCaptures.get(importer)?.prepareDependency(specifier) === "package-map";
        metadataCapture.prepare();
        return packageMap;
      }).value,
    captureModule: (importer: string, specifier: string, conditions: readonly string[]) => {
      const result = captureAdmitted(() =>
        moduleCaptures.get(importer)?.capture(specifier, conditions),
      );
      return result.value ? { ...result.value, additions: result.additions } : undefined;
    },
    captureResolvedModule: (filename: string) => {
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
    },
  };
}
