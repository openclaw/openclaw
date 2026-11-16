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
import { getPluginCache } from "./plugin-cache.js";
import { createPluginCaptureOwner } from "./plugin-capture-native-resource.client.js";
import { PluginSourceRecoveryUnavailableError } from "./plugin-instance-error.js";
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
  pluginRecoveryCapture,
} from "./plugin-source-capture-context.js";
import { createPluginSourceCaptureState } from "./plugin-source-capture-state.js";
import type { PluginCapturedSourceFact } from "./plugin-source-verification.js";
// These owner-defined operations copy captured source trees; their cost scales with
// package size and filesystem latency rather than the ordinary method deadline.
const sourceCaptureOperations = new WeakSet<object>();
export function markPluginSourceCaptureOperation<T extends () => unknown>(operation: T): T {
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
};
export type PluginSourceCustodyFork = SourceCustody;
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
        executionAliases: retained.executionAliases,
        executionSources: retained.executionSources,
        packageManifests: retained.packageManifests,
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
  executionAliases: ReadonlyMap<string, string>,
  executionSources: ReadonlyMap<string, string>,
) {
  const files = new Map<string, PluginCapturedSourceFact>();
  return {
    files: captureForCustody ? files : undefined,
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
  rootDir: string;
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
  native?: PluginNativeRecovery;
};

function copyRecoverySource(input: RecoveryInput): PluginRecoverySource {
  let recovery: ReturnType<typeof createPluginSourceCapture> | undefined;
  try {
    recovery = createPluginSourceCapture();
    const steps = copyPluginRecoveryFiles(
      {
        rootDir: input.rootDir,
        boundaryRoot: input.boundaryRoot,
        references: input.native?.references,
        namespaces: input.native?.namespaces,
      },
      recovery.directory,
    );
    let step = steps.next();
    while (!step.done) {
      fs.cpSync(...step.value);
      step = steps.next();
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
    const borrowed = pluginRecoveryCapture.getStore();
    const copyInput = {
      rootDir: input.rootDir,
      boundaryRoot: input.boundaryRoot,
      references: input.native?.references,
      namespaces: input.native?.namespaces,
      storage: resolvePluginSourceCaptureStorage(),
      directory: pluginSourceCaptureDirectory.getStore(),
    };
    let root: { directory: string; managedRoot?: string };
    let release: () => Promise<void>;
    if (borrowed) {
      const capture = await borrowed(copyInput);
      root = capture;
      release = () => capture.release();
    } else {
      // Host-local recovery outlives the preparation generation that produced its bytes.
      owner = await createPluginCaptureOwner(
        captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }),
      );
      ({ root } = await owner.copyRecovery(1, copyInput));
      const captureOwner = owner;
      release = () =>
        settleWithCleanup(
          captureOwner.releaseSource(1),
          () => captureOwner.close(),
          "Plugin recovery source release and owner close failed",
        );
    }
    let disposal: Promise<void> | undefined;
    const dispose = () => (disposal ??= release());
    recovery = createPluginSourceCaptureState({
      directory: root.directory,
      outputRoot: root.managedRoot,
      dispose() {
        void dispose().catch((error: unknown) => process.emitWarning(String(error)));
      },
      disposeAsync: dispose,
    });
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
  const { rootDir, sourceRoot, capturedRoot, boundaryRoot, sources } = input;
  const directory = sourceCapture.directory;
  const relocate = (filename: string) =>
    path.join(directory, path.relative(boundaryRoot, filename));
  const copiedSources = new Map(
    Array.from(sources, ([source, captured]) => [source, relocate(captured)]),
  );
  const previousNative = input.native;
  if (previousNative) {
    for (const [filename, fact] of previousNative.references) {
      previousNative.references.set(filename, { ...fact, sourceIdentity: fact.capturedIdentity });
    }
  }
  const native = previousNative?.fork(relocate);
  input.native = native;
  previousNative?.dispose();
  const root = relocate(capturedRoot);
  let disposed = false;
  return {
    rootDir: root,
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
        native: captureNativeRecovery?.(),
      });
    }),
    captureRecoverySourceAsync: markPluginSourceCaptureOperation(() => {
      for (const captured of new Set(capturedPaths.values())) {
        assertModuleAvailable(captured);
      }
      return copyRecoverySourceAsync({
        rootDir,
        sourceRoot,
        capturedRoot,
        boundaryRoot,
        sources: new Map(capturedPaths),
        native: captureNativeRecovery?.(),
      });
    }),
  };
}

/** Keep first-demand module lookup and admission with the captured source graph. */
export function createPluginGenerationModuleLookup({
  capturedPaths,
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
    prepareModule: (filename: string) => {
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
    },
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
