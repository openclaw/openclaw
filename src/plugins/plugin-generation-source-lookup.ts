import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import {
  settleWithCleanup,
  throwIfSettledRejected,
  throwSettledAggregate,
} from "../infra/error-graph-internal.js";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { isPathInside, relativePluginPathInsideRootSync } from "./path-safety.js";
import { createPluginCaptureOwner } from "./plugin-capture-native-resource.client.js";
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
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import type { PluginNativeRecovery } from "./plugin-native-admission.js";
import {
  createPluginDependencyResolver,
  createPluginSourceCapture,
  type PluginModuleCapture,
  type createPluginPackageMetadataCapture,
  findPluginCapturedPackage,
  type PluginPackageCapture,
} from "./plugin-package-metadata-capture.js";
import { copyPluginRecoveryFiles } from "./plugin-recovery-source-copy.js";
import {
  pluginSourceCaptureDirectory,
  resolvePluginSourceCaptureStorage,
} from "./plugin-source-capture-context.js";
import { createPluginSourceCaptureState } from "./plugin-source-capture-state.js";
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
  executionAliases: ReadonlyMap<string, string>;
  executionSources: ReadonlyMap<string, string>;
  packageManifests: ReadonlyMap<string, Record<string, unknown> | null>;
  modules?: ReadonlyMap<string, PluginInspectedModule>;
};
/** Plain inspection facts; executable lookup callbacks stay with each consuming capture. */
export type PluginInspectedModule = {
  staticImports: ReadonlySet<string>;
  observed: ReadonlyMap<string, string | null | undefined>;
  acquisitions: ReadonlyArray<
    { kind: "file"; source: string } | { kind: "dependency"; importer: string; name: string }
  >;
};
export type PluginSourceCustodyFork = SourceCustody;
const sourceCustody = new AsyncLocalStorage<{
  closing: boolean;
  prepared: Map<object, Map<string, Promise<PreparedSourceCustody>>>;
}>();

type PreparedSourceCustody = {
  captureId: number;
  sourceDigest: string;
  disposeAsync(): Promise<void>;
};

export function hasPluginGenerationSourceCustody(): boolean {
  return sourceCustody.getStore() !== undefined;
}

/** Retain an unexecuted worker source; each caller still prepares its own private artifact. */
export async function retainPreparedPluginGenerationSource(
  owner: object,
  key: string,
  create: () => Promise<PreparedSourceCustody>,
): Promise<PreparedSourceCustody | undefined> {
  const scope = sourceCustody.getStore();
  if (!scope) {
    return undefined;
  }
  if (scope.closing) {
    throw new Error("Plugin source custody has closed");
  }
  let sources = scope.prepared.get(owner);
  if (!sources) {
    sources = new Map();
    scope.prepared.set(owner, sources);
  }
  let preparing = sources.get(key);
  if (!preparing) {
    preparing = create();
    sources.set(key, preparing);
  }
  try {
    const source = await preparing;
    if (scope.closing) {
      throw new Error("Plugin source custody has closed");
    }
    return source;
  } catch (error) {
    if (sources.get(key) === preparing) {
      sources.delete(key);
    }
    throw error;
  }
}

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
    closing: false,
    prepared: new Map<object, Map<string, Promise<PreparedSourceCustody>>>(),
    async disposeAsync() {
      this.closing = true;
      const results = await Promise.allSettled(
        [...this.prepared.values()].flatMap((sources) =>
          [...sources.values()].map(async (source) => (await source).disposeAsync()),
        ),
      );
      this.prepared.clear();
      throwSettledAggregate(results, "Plugin source custody cleanup failed");
    },
  };
  return {
    run: <T>(run: () => T): T => sourceCustody.run(scope, run),
    disposeAsync: () => scope.disposeAsync(),
  };
}

/** Reuse captured bytes across one management operation; source edits take effect next time. */
export function createPluginSourceFacts(
  dependencyLookupBoundary: Parameters<typeof createPluginDependencyResolver>[0],
  captureForCustody: boolean,
  executionAliases: ReadonlyMap<string, string>,
  executionSources: ReadonlyMap<string, string>,
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
    captureCustody: (capture: () => PluginRecoverySource) => ({
      source: capture(),
      files,
      executionAliases,
      executionSources,
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

type RecoveryInput = {
  rootDir: string;
  sourceRoot: string;
  capturedRoot: string;
  boundaryRoot: string;
  sources: ReadonlyMap<string, string>;
  directories: ReadonlySet<string>;
  native?: PluginNativeRecovery;
};

function copyRecoverySource(input: RecoveryInput): PluginRecoverySource {
  let recovery: ReturnType<typeof createPluginSourceCapture> | undefined;
  try {
    recovery = createPluginSourceCapture();
    const metrics = getPluginGenerationMetrics();
    const steps = copyPluginRecoveryFiles(
      {
        rootDir: input.rootDir,
        boundaryRoot: input.boundaryRoot,
        references: input.native?.references,
        namespaces: input.native?.namespaces,
        measureBytes: metrics !== undefined,
      },
      recovery.directory,
    );
    let step = steps.next();
    while (!step.done) {
      fs.cpSync(...step.value);
      step = steps.next();
    }
    if (metrics) {
      metrics.copiedBytes += step.value;
    }
    return retainRecoverySource(input, recovery);
  } catch (error) {
    try {
      recovery?.dispose();
    } finally {
      input.native?.dispose();
    }
    if (hasErrnoCode(error, "ENOENT")) {
      throw new PluginSourceRecoveryUnavailableError(error);
    }
    throw error;
  }
}

async function copyRecoverySourceAsync(input: RecoveryInput): Promise<PluginRecoverySource> {
  let owner: Awaited<ReturnType<typeof createPluginCaptureOwner>> | undefined;
  let recovery: ReturnType<typeof createPluginSourceCapture> | undefined;
  try {
    // Recovery outlives the preparation generation that produced the serving artifact.
    const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
    // The independent host outlives this invocation; its transport must not retain the old owner.
    owner = await pluginInstanceInvocation.exit(() => createPluginCaptureOwner(source));
    const metrics = getPluginGenerationMetrics();
    const { root, copiedBytes } = await owner.copyRecovery(1, {
      rootDir: input.rootDir,
      boundaryRoot: input.boundaryRoot,
      references: input.native?.references,
      namespaces: input.native?.namespaces,
      measureBytes: metrics !== undefined,
      storage: resolvePluginSourceCaptureStorage(),
      directory: pluginSourceCaptureDirectory.getStore(),
    });
    const captureOwner = owner;
    let disposal: Promise<void> | undefined;
    const dispose = () =>
      (disposal ??= settleWithCleanup(
        captureOwner.releaseSource(1),
        () => captureOwner.close(),
        "Plugin recovery source release and owner close failed",
      ));
    recovery = createPluginSourceCaptureState({
      directory: root.directory,
      outputRoot: root.managedRoot,
      dispose() {
        void dispose().catch((error: unknown) => process.emitWarning(String(error)));
      },
      disposeAsync: dispose,
    });
    if (metrics) {
      metrics.copiedBytes += copiedBytes;
    }
    return retainRecoverySource(input, recovery);
  } catch (error) {
    try {
      throwIfSettledRejected(
        await Promise.allSettled([
          recovery ? recovery.disposeAsync() : owner?.close(),
          input.native?.disposeAsync(),
        ]),
        "Plugin recovery custody cleanup failed",
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Plugin recovery capture and cleanup failed",
        {
          cause: cleanupError,
        },
      );
    }
    if (hasErrnoCode(error, "ENOENT")) {
      throw new PluginSourceRecoveryUnavailableError(error);
    }
    throw error;
  }
}

function retainRecoverySource(
  input: RecoveryInput,
  sourceCapture: ReturnType<typeof createPluginSourceCapture>,
): PluginRecoverySource {
  const { rootDir, sourceRoot, capturedRoot, boundaryRoot, sources, directories } = input;
  const directory = sourceCapture.directory;
  const relocate = (filename: string) =>
    path.join(directory, path.relative(boundaryRoot, filename));
  const copiedSources = new Map(
    Array.from(sources, ([source, captured]) => [source, relocate(captured)]),
  );
  const previousNative = input.native;
  const native = previousNative?.fork(relocate);
  input.native = native;
  previousNative?.dispose();
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
  const recoveryInput = () => {
    for (const captured of new Set(capturedPaths.values())) {
      assertModuleAvailable(captured);
    }
    const native = captureNativeRecovery?.();
    if (native) {
      // Recovery links read the retained snapshots, never the installed originals.
      for (const [filename, fact] of native.references) {
        native.references.set(filename, { ...fact, sourceIdentity: fact.capturedIdentity });
      }
    }
    return {
      rootDir,
      sourceRoot,
      capturedRoot,
      boundaryRoot,
      sources: new Map(capturedPaths),
      directories: new Set(capturedDirectories),
      native,
    };
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
    captureRecoverySource: markPluginSourceCaptureOperation(() =>
      copyRecoverySource(recoveryInput()),
    ),
    captureRecoverySourceAsync: markPluginSourceCaptureOperation(() =>
      copyRecoverySourceAsync(recoveryInput()),
    ),
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
      assertModuleAvailable(filename);
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
