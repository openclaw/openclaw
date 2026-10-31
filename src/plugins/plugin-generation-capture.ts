import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPathInside } from "../infra/path-guards.js";
import { createPluginCaptureResolver } from "./plugin-capture-resolution.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.types.js";
import {
  createPluginGenerationFileCapture,
  createPluginSourceLinkCapture,
  linkPluginGenerationDependency,
} from "./plugin-generation-file-capture.js";
import { createPluginFrozenGeneration } from "./plugin-generation-frozen-source.js";
import { getPluginGenerationMetrics } from "./plugin-generation-metrics.js";
import { createPluginGenerationReceipt } from "./plugin-generation-receipt.js";
import { createPluginGenerationReferenceCapture } from "./plugin-generation-reference-capture.js";
import {
  createPluginGenerationCapture,
  createPluginGenerationSourceLookup,
  createPluginSourceFacts,
  markPluginSourceCaptureOperation,
  type PluginSourceCustodyFork,
  createPluginGenerationModuleLookup,
} from "./plugin-generation-source-lookup.js";
import {
  acquirePluginSource,
  clearPluginSourceAcquisitionError,
  createPluginDependencyLinkError,
} from "./plugin-instance-error.js";
import {
  createPluginNativeAdmission,
  type PluginNativeRecovery,
} from "./plugin-native-admission.js";
import { createPluginNativeImportPattern } from "./plugin-native-resolution.js";
import {
  capturePluginPackageMetadata,
  capturePluginDependencies,
  resolvePluginModulePackageRoot,
  createPluginDependencyLookup,
  createPluginDependencyResolver,
  createPluginNativeDependencyScopes,
  packageName,
  importTargetNames,
  createPluginPackageMetadataCapture,
  createPluginSourceCapture,
  type PluginDependencyResolution,
  type PluginPackageCapture,
  type PluginModuleCapture,
  isPluginPackageFile as inPackage,
  findPluginCapturedPackage,
} from "./plugin-package-metadata-capture.js";
import {
  createPluginSourceDirectoryCapture,
  inspectPluginCaptureSource,
  readPluginCapturedCode,
  realpathPluginSource,
} from "./plugin-source-file.js";
import {
  capturedPluginModuleUrl,
  createPluginPackageMapReferences,
  resolvePluginPackageMapTarget,
  visitPluginSourceReferences,
} from "./plugin-source-references.js";

export type { PluginGenerationArtifact } from "./plugin-generation-artifact.types.js";

/** Capture selective entries and whole dependencies without replacing earlier file bytes. */
export const capturePluginGenerationArtifactInScope = createPluginGenerationCapture(
  createPluginGenerationArtifact,
);

/** Install snapshots contain unexecuted source bytes, never native admission or live custody. */
export function capturePluginSourceSnapshot(
  rootDir: string,
  dependencyLookupBoundary?: Parameters<typeof createPluginDependencyResolver>[0],
): PluginGenerationArtifact {
  return createPluginGenerationArtifact(
    rootDir,
    undefined,
    undefined,
    undefined,
    undefined,
    dependencyLookupBoundary,
    undefined,
    false,
    true,
  );
}

/** Rebuild every runtime owner independently from the complete immutable source closure. */
export function capturePluginSnapshotGeneration(
  snapshot: Parameters<typeof createPluginFrozenGeneration>[0],
  _entryFile?: string | readonly string[],
  execute?: <T>(run: () => T) => T,
  moduleSource?: (filename: string) => string,
  nativeRecovery?: PluginNativeRecovery,
): PluginGenerationArtifact {
  return createPluginFrozenGeneration(snapshot, (resolveInput) =>
    createPluginGenerationArtifact(
      snapshot.rootDir,
      undefined,
      execute,
      moduleSource,
      nativeRecovery,
      undefined,
      undefined,
      true,
      false,
      resolveInput,
    ),
  );
}

function createPluginGenerationArtifact(
  rootDir: string,
  entryFile?: string | readonly string[],
  execute?: <T>(run: () => T) => T,
  moduleSource?: (filename: string) => string,
  nativeRecovery?: PluginNativeRecovery,
  dependencyLookupBoundary?: Parameters<typeof createPluginDependencyResolver>[0],
  retained?: PluginSourceCustodyFork,
  captureForCustody = false,
  sourceOnly = false,
  resolveFrozenInput?: (filename: string) => string,
): PluginGenerationArtifact {
  const metrics = getPluginGenerationMetrics();
  if (metrics) {
    metrics.captures++;
    if (retained || resolveFrozenInput) {
      metrics.captureReuse++;
    }
  }
  const entryFiles = typeof entryFile === "string" ? [entryFile] : entryFile && [...entryFile];
  if (entryFiles?.length === 0) {
    throw new Error("Selective plugin capture requires at least one entry");
  }
  const sourceCapture = retained?.source.sourceCapture ?? createPluginSourceCapture();
  const directory = sourceCapture.directory;
  const packages = new Map<string, PluginPackageCapture>();
  const packageForFile = (filename: string) =>
    findPluginCapturedPackage(packages, filename, directory)?.owner;
  const capturedPaths = new Map<string, string>();
  const capturedDirectories = new Set(retained?.source.directories);
  const originalSources = new Map<string, string>();
  const hardlinkedSources = new Set<string>();
  const nativeAdmission = createPluginNativeAdmission(
    rootDir,
    directory,
    entryFiles,
    nativeRecovery,
    sourceCapture.outputRoot,
  );
  const metadataCapture = createPluginPackageMetadataCapture({
    sourceForCaptured: (filename) => originalSources.get(filename),
    packageForFile,
    isRetainedReference: nativeAdmission.isRetainedReference,
    resolveSource: nativeAdmission.resolvePreparedSource,
  });
  const sourceAliases: Record<string, string> = {};
  const sourceFacts = createPluginSourceFacts(
    dependencyLookupBoundary,
    captureForCustody || sourceOnly,
  );
  const receipt = createPluginGenerationReceipt(sourceOnly ? undefined : nativeAdmission.prepared);
  const { additions, capture: acquireSources, assertModuleAvailable } = sourceCapture;
  const captureAdmitted = <T>(run: () => T) => {
    const acquired = execute ? execute(() => acquireSources(run)) : acquireSources(run);
    nativeAdmission.finish(receipt.finish());
    return acquired;
  };
  const moduleCaptures = new Map<string, PluginModuleCapture>();
  const resolution = createPluginCaptureResolver();
  const resolveDependency = sourceFacts.resolveDependency;
  // Callers canonicalize roots; already-captured packages survive removal of their original files.
  const copyPackage = (
    requestedRoot: string,
    requestedEntry?: string,
    requestedMetadataOnly = false,
    executableEntry = false,
  ): string => {
    const root = resolveFrozenInput?.(requestedRoot) ?? requestedRoot;
    const entry = requestedEntry
      ? (resolveFrozenInput?.(requestedEntry) ?? requestedEntry)
      : undefined;
    // Install-time aliases belong to the complete closure, including deferred package-map bodies.
    const metadataOnly = requestedMetadataOnly && !sourceOnly && !resolveFrozenInput;
    const boundary = root;
    // Recovery packages are themselves captures; omit output only when it is nested in this source.
    const outputRoot =
      sourceCapture.outputRoot && isPathInside(boundary, sourceCapture.outputRoot)
        ? sourceCapture.outputRoot
        : undefined;
    const existing = packages.get(root);
    if (existing) {
      if (!metadataOnly) {
        existing.materialize(executableEntry ? entry : undefined);
      }
      return existing.capturedRoot;
    }
    const packageMap = createPluginPackageMapReferences();
    const packageKind = packages.size === 0 ? "package" : "dependency";
    const packageId = `package-${packages.size}`;
    const moduleRoot = path.join(directory, packageId, "node_modules");
    const parentName = path.basename(path.dirname(boundary));
    const sourceModuleRoot = parentName.startsWith("@")
      ? path.dirname(path.dirname(boundary))
      : path.dirname(boundary);
    const destination = path.join(
      moduleRoot,
      parentName.startsWith("@") ? parentName : "",
      path.basename(boundary),
    );
    sourceAliases[root] = destination;
    receipt.marker(`${packageId}\0`);
    const owner: PluginPackageCapture = {
      capturedRoot: destination,
      sourceRoot: boundary,
      links: new Set<string>(),
      state: "metadata",
      captureTarget(filename) {
        const source = path.join(boundary, path.relative(destination, filename));
        if (
          !capturedPaths.has(source) &&
          !packageMap.hasMissingTarget(source) &&
          acquirePluginSource(() => fs.statSync(source, { throwIfNoEntry: false }))?.isFile() &&
          (isPathInside(boundary, realpathPluginSource(source)) ||
            nativeAdmission.isRetainedReference(source))
        ) {
          // Unselected branches must not initialize Jiti or validate their tsconfig.
          copy(source, filename);
          scopes.captureMetadata(path.dirname(source));
        }
      },
      materialize(selectedEntry) {
        if (typeof owner.state === "object") {
          throw owner.state.error;
        }
        if (owner.state === "body" && !selectedEntry) {
          return;
        }
        owner.state = selectedEntry && owner.state !== "body" ? "entry" : "body";
        try {
          if (selectedEntry) {
            captureFile(path.resolve(selectedEntry));
          } else {
            copy(root, destination);
          }
          captureDependencies();
        } catch (error) {
          owner.state = { error };
          throw error;
        }
      },
    };
    packages.set(root, owner);
    const sourceLinks = createPluginSourceLinkCapture();
    const copy = createPluginGenerationFileCapture({
      boundary,
      destination,
      directory,
      packageKind,
      outputRoot,
      capturedPaths,
      capturedDirectories,
      originalSources,
      hardlinkedSources,
      sourceCapture,
      sourceLinks,
      deferExternalLinks: Boolean(execute),
      nativeAdmission,
      sourceOnly,
      retainedSnapshotSource: resolveFrozenInput !== undefined,
      receipt,
      retained,
      sourceFacts: sourceFacts.files,
      onPackageMetadata(source, target) {
        metadataCapture.record(target, (manifest) => {
          for (const alias of importTargetNames(manifest.imports)) {
            if (alias === "openclaw" || alias === "@openclaw/plugin-sdk") {
              continue;
            }
            const dependency = resolveDependency(alias, source);
            if (dependency) {
              linkDependency(alias, dependency, true);
            }
          }
        });
      },
    });
    const linkDependency = (
      name: string,
      dependency: PluginDependencyResolution,
      captureMetadataOnly = false,
    ) => {
      const captured = copyPackage(dependency.root, undefined, captureMetadataOnly);
      // Preserve real nested installs; synthetic per-file node_modules confuse native addon roots.
      // Installed peers also need sibling paths for native assets read directly from disk.
      const lookupDirectory = inPackage(boundary, dependency.lookupDirectory)
        ? path.join(destination, path.relative(boundary, dependency.lookupDirectory))
        : path.join(dependency.lookupDirectory, "node_modules") === sourceModuleRoot
          ? path.dirname(moduleRoot)
          : destination;
      const link = path.join(lookupDirectory, "node_modules", name);
      const dependencyPackage = packages.get(dependency.root)!;
      dependencyPackage.links.add(link);
      try {
        if (linkPluginGenerationDependency(link, captured)) {
          additions.add(link);
        }
        sourceFacts.recordLink(link, captured);
      } catch (cause) {
        const error = createPluginDependencyLinkError(name, rootDir, cause);
        dependencyPackage.state = { error };
        additions.add(link);
        throw error;
      }
    };
    const scopes = metadataCapture.createScope({
      root,
      destination,
      boundary,
      copy,
      hasSource: (source) => capturedPaths.has(source),
    });
    const references = new Map<string, Set<string>>();
    const getNativeScope = createPluginNativeDependencyScopes(
      resolveDependency,
      (name, dependency) => linkDependency(name, dependency, true),
    );
    const captureDirectory = createPluginSourceDirectoryCapture((source, ancestors) =>
      captureFile(source, ancestors),
    );
    const captureFile = (requestedSource: string, directoryAncestors?: Set<string>): void => {
      const source = resolveFrozenInput?.(requestedSource) ?? requestedSource;
      const existingSource = capturedPaths.get(path.resolve(source));
      if (existingSource) {
        assertModuleAvailable(existingSource);
        if (!/\.[cm]?[jt]sx?$/.test(source) || moduleCaptures.has(existingSource)) {
          return;
        }
      }
      const target = existingSource ?? path.join(destination, path.relative(root, source));
      if (!existingSource) {
        const prepared = nativeAdmission.resolvePreparedSource(source);
        const input = inspectPluginCaptureSource(
          source,
          boundary,
          prepared,
          nativeAdmission.isRetainedReference,
          outputRoot,
        );
        if (!input) {
          return;
        }
        const { real } = input;
        if (input.directory) {
          captureDirectory(source, real, target, directoryAncestors, !prepared);
          return;
        }
        copy(source, target);
      }
      if (!/\.[cm]?[jt]sx?$/.test(source)) {
        return;
      }
      const scope = scopes.resolve(path.dirname(source));
      const prepareDependency = createPluginDependencyLookup(
        source,
        scope?.manifest,
        resolveDependency,
        linkDependency,
      );
      // Configured tsconfig mappings must be pinned before later source edits.
      if (process.env.JITI_TSCONFIG_PATHS !== undefined) {
        resolution.get(source);
      }
      const captureReference = createPluginGenerationReferenceCapture({
        source,
        rootDir,
        root,
        boundary,
        destination,
        entry,
        executableEntry,
        execute: Boolean(execute),
        resolveFrozenInput,
        moduleSource,
        originalSources,
        nativeAdmission,
        resolution,
        references,
        scope,
        packageMap,
        capturedPaths,
        resolveDependency,
        captureFile,
        captureExecutableFile,
        owner,
        sourceLinks,
      });
      const observed = new Map<string, string | null | undefined>();
      const captureObservedReference = (
        reference: string,
        kind: "asset" | "import" | "require",
        conditions?: readonly string[],
      ) => {
        const key = `${kind}\0${reference}`;
        // Uninspected external references are distinct from observed absent local inputs.
        if (!observed.has(key) || (conditions && execute && observed.get(key) === null)) {
          observed.set(key, captureReference(reference, kind, conditions));
        }
        return observed.get(key) ?? undefined;
      };
      const captureModule = (
        requestedSpecifier: string,
        conditions: readonly string[],
      ): { target: URL } | { retryNative: true } | undefined => {
        let specifier = requestedSpecifier;
        if (resolveFrozenInput && specifier.startsWith("file:")) {
          const url = new URL(specifier);
          url.pathname = pathToFileURL(resolveFrozenInput(fileURLToPath(url))).pathname;
          specifier = url.href;
        } else if (resolveFrozenInput && path.isAbsolute(specifier)) {
          specifier = resolveFrozenInput(specifier);
        }
        const inputFilename = specifier.startsWith("file:")
          ? fileURLToPath(specifier)
          : path.isAbsolute(specifier)
            ? specifier
            : undefined;
        const known = inputFilename && capturedPaths.get(path.resolve(inputFilename));
        if (execute && known) {
          assertModuleAvailable(known);
          return { target: capturedPluginModuleUrl(known, specifier, conditions) };
        }
        const name = packageName(specifier);
        const self = scope?.manifest.exports != null && scope.manifest.name === name;
        const bare =
          !specifier.startsWith(".") &&
          !path.isAbsolute(specifier) &&
          !specifier.startsWith("file:");
        if (
          bare &&
          !self &&
          !specifier.startsWith("#") &&
          resolution.get(source).options.tsconfigPaths
        ) {
          // Jiti still owns configured source paths; package maps below use captured metadata.
          const mapped = captureObservedReference(
            specifier,
            conditions.includes("require") ? "require" : "import",
            conditions,
          );
          const captured = mapped && capturedPaths.get(path.resolve(mapped));
          if (captured) {
            captureDependencies();
            assertModuleAvailable(captured);
            return { target: pathToFileURL(captured) };
          }
        }
        const dependencyPrepared = prepareDependency(specifier);
        if (typeof dependencyPrepared === "boolean") {
          return dependencyPrepared ? { retryNative: true } : undefined;
        }
        if (dependencyPrepared === "package-map") {
          const selected = resolvePluginPackageMapTarget(specifier, target, conditions);
          if (!selected) {
            return undefined;
          }
          const filename = fileURLToPath(selected);
          if (inPackage(destination, filename)) {
            const original = path.join(boundary, path.relative(destination, filename));
            if (packageMap.hasMissingTarget(original)) {
              return undefined;
            }
            if (!capturedPaths.has(original) && !fs.existsSync(original)) {
              packageMap.recordMissingTarget(original);
              return undefined;
            }
            captureFile(original);
          } else {
            packageForFile(filename)?.materialize();
          }
          captureDependencies();
          return { retryNative: true };
        }
        const observedSource = captureObservedReference(
          specifier,
          conditions.includes("require") ? "require" : "import",
          conditions,
        );
        captureDependencies();
        const captured = observedSource
          ? capturedPaths.get(path.resolve(observedSource))
          : undefined;
        if (!captured) {
          return undefined;
        }
        assertModuleAvailable(captured);
        return { target: capturedPluginModuleUrl(captured, specifier, conditions) };
      };
      const moduleCapture: PluginModuleCapture = {
        isNativeImportPattern: createPluginNativeImportPattern(scope?.manifest.imports),
        isRequireReference: (specifier) =>
          observed.has(`require\0${specifier}`) && !observed.has(`import\0${specifier}`),
        prepareDependency,
        nativeScope: getNativeScope(source, scope?.manifest),
        capture: captureModule,
      };
      moduleCaptures.set(target, moduleCapture);
      // Only Bun previews need deferred-code facts without acquiring unresolved references.
      if ((entry && !executableEntry) || process.versions.bun) {
        moduleCapture.staticImports = visitPluginSourceReferences(
          source,
          readPluginCapturedCode(target, capturedDirectories.has(target)),
          resolution.get(source),
          entry && !executableEntry
            ? captureObservedReference
            : (reference, kind) => observed.set(`${kind}\0${reference}`, null),
        );
      }
    };
    const captureDependencies = () => {
      const manifestPath = path.join(root, "package.json");
      if (!entry && !capturedPaths.has(manifestPath)) {
        return;
      }
      capturePluginDependencies({
        root,
        plan: entry
          ? undefined
          : metadataCapture.dependencyPlan(path.join(destination, "package.json")),
        references,
        resolve: resolveDependency,
        capture: linkDependency,
      });
    };
    if (metadataOnly) {
      const manifest = capturePluginPackageMetadata(
        root,
        destination,
        copy,
        nativeAdmission.isRetainedReference,
        nativeAdmission.resolvePreparedSource,
      );
      metadataCapture.setManifest(path.join(destination, "package.json"), manifest ?? null);
    } else {
      owner.materialize(entry);
    }
    return destination;
  };
  const captureExecutableFile = (requestedFilename: string): string | undefined =>
    execute?.(() => {
      const filename = resolveFrozenInput?.(requestedFilename) ?? requestedFilename;
      const real = realpathPluginSource(filename);
      if (!acquirePluginSource(() => fs.statSync(real)).isFile()) {
        return undefined;
      }
      copyPackage(resolvePluginModulePackageRoot(real), real, false, true);
      return real;
    });

  try {
    const sourceRoot = realpathPluginSource(rootDir);
    const entries = entryFiles?.map((file) => realpathPluginSource(file));
    const root = copyPackage(sourceRoot, entries?.[0]);
    for (const entry of entries?.slice(1) ?? []) {
      packages.get(sourceRoot)!.materialize(entry);
    }
    if (sourceOnly || resolveFrozenInput) {
      metadataCapture.prepare();
    }
    sourceAliases[path.resolve(rootDir)] = root;
    for (const [index, entry] of entries?.entries() ?? []) {
      const alias = path.join(
        sourceRoot,
        path.relative(path.resolve(rootDir), path.resolve(entryFiles![index]!)),
      );
      // Directory selections capture their files, not a module at the directory path.
      const captured = capturedPaths.get(entry);
      if (captured) {
        capturedPaths.set(alias, captured);
      }
    }
    const initialReceipt = receipt.finish();
    nativeAdmission.finish(initialReceipt);
    additions.clear();
    const captures = [
      moduleCaptures,
      hardlinkedSources,
      metadataCapture,
      packages,
      resolution,
      capturedDirectories,
    ];
    const clearCaptures = () => captures.forEach((capture) => capture.clear());
    const sourceLookup = createPluginGenerationSourceLookup({
      rootDir,
      sourceRoot,
      capturedRoot: root,
      boundaryRoot: directory,
      capturedPaths,
      capturedDirectories,
      hardlinkedSources,
      assertModuleAvailable,
      captureNativeRecovery: () => nativeAdmission.captureRecovery(initialReceipt, sourceAliases),
    });
    return {
      sourceRoot,
      rootDir: root,
      sourceAliases,
      linkHost: (hostRoot: string) => {
        sourceCapture.linkHost(hostRoot);
        nativeAdmission.linkHost(hostRoot);
      },
      // The receipt attests the initial snapshot; lazy imports retain their own copied bytes.
      sourceDigest: initialReceipt.sourceDigest,
      ...(sourceOnly || captureForCustody
        ? {
            sourceSnapshotFacts: sourceFacts.snapshot(
              directory,
              capturedDirectories,
              hardlinkedSources,
            ),
          }
        : {}),
      ...sourceLookup,
      retainSourceCustody: markPluginSourceCaptureOperation(() =>
        sourceFacts.captureCustody(sourceLookup.captureRecoverySource),
      ),
      ...createPluginGenerationModuleLookup({
        capturedPaths,
        originalSources,
        moduleCaptures,
        metadataCapture,
        assertModuleAvailable,
        captureAdmitted,
        captureExecutableFile,
        executable: Boolean(execute),
        packages,
        directory,
      }),
      dispose: () => {
        (retained?.source ?? sourceCapture).dispose();
        clearCaptures();
      },
      disposeAsync: () => (retained?.source ?? sourceCapture).disposeAsync().then(clearCaptures),
    };
  } catch (error) {
    try {
      (retained?.source ?? sourceCapture).dispose();
    } catch (cleanupError) {
      throw clearPluginSourceAcquisitionError(cleanupError);
    }
    throw error;
  }
}
