import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPathInside } from "../infra/path-guards.js";
import { createPluginCaptureResolver } from "./plugin-capture-resolution.js";
import type {
  CapturedModuleState,
  CapturedPackageState,
  PluginGenerationCaptureState,
  PluginDependencyResolution,
} from "./plugin-generation-capture.types.js";
import {
  createPluginGenerationFileCapture,
  createPluginSourceLinkCapture,
} from "./plugin-generation-file-capture.js";
import { createPluginGenerationReceipt } from "./plugin-generation-receipt.js";
import {
  createPluginGenerationCapture,
  createPluginGenerationReferenceCapture,
  createPluginGenerationSourceLookup,
  createPluginSourceFacts,
  type PluginSourceCustodyFork,
  createPluginGenerationModuleLookup,
} from "./plugin-generation-source-lookup.js";
import type { AdmissionState } from "./plugin-native-admission-state.js";
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
  type PluginPackageCapture,
  type PluginModuleCapture,
  isPluginPackageFile as inPackage,
  findPluginCapturedPackage,
} from "./plugin-package-metadata-capture.js";
import { isPluginSourceEntry } from "./plugin-source-file.js";
import {
  capturedPluginModuleUrl,
  createPluginPackageMapReferences,
  resolvePluginPackageMapTarget,
  visitPluginSourceReferences,
} from "./plugin-source-references.js";

export type PluginGenerationPreparationOwner = {
  admission: AdmissionState;
  sourceCapture: ReturnType<typeof createPluginSourceCapture>;
  resolution: ReturnType<typeof createPluginCaptureResolver>;
  state?: PluginGenerationCaptureState;
  prepared?(state: PluginGenerationCaptureState): void;
};
export type PluginGenerationArtifact = {
  sourceRoot: string;
  rootDir: string;
  boundaryRoot: string;
  sourceAliases: Record<string, string>;
  sourceDigest: string;
  linkHost: (hostRoot: string) => void;
  hasSource: (source: string) => boolean;
  resolve: (source: string, rejectHardlinks?: boolean) => string;
  captureRecoverySource: () => PluginSourceCustodyFork["source"];
  retainSourceCustody: () => PluginSourceCustodyFork;
  sourceForCaptured: (file: string) => string | undefined;
  moduleFacts: (importer: string) => Readonly<PluginModuleCapture> | undefined;
  moduleRoot: (filename: string) => string | undefined;
  assertModuleAvailable: (filename: string) => void;
  prepareModule: (filename: string) => string[];
  prepareDependency: (importer: string, specifier: string) => string[];
  prepareNativeScopes: (importer?: string) => { value: void; additions: string[] } | undefined;
  prepareNativeModule: (importer: string, specifier: string) => boolean;
  captureModule: (
    importer: string,
    specifier: string,
    conditions: readonly string[],
  ) => (({ target: URL } | { retryNative: true }) & { additions: string[] }) | undefined;
  captureResolvedModule: (filename: string) => string | undefined;
  dispose: () => void;
  disposeAsync: () => Promise<void>;
};

/** Capture selective entries and whole dependencies without replacing earlier file bytes. */
export const capturePluginGenerationArtifactInScope = createPluginGenerationCapture(
  createPluginGenerationArtifact,
);

export function createPluginGenerationArtifact(
  rootDir: string,
  entryFile?: string | readonly string[],
  execute?: <T>(run: () => T) => T,
  moduleSource?: (filename: string) => string,
  nativeRecovery?: PluginNativeRecovery,
  dependencyLookupBoundary?: Parameters<typeof createPluginDependencyResolver>[0],
  retained?: PluginSourceCustodyFork,
  captureForCustody = false,
  preparation?: PluginGenerationPreparationOwner,
): PluginGenerationArtifact {
  const entryFiles = typeof entryFile === "string" ? [entryFile] : entryFile && [...entryFile];
  if (entryFiles?.length === 0) {
    throw new Error("Selective plugin capture requires at least one entry");
  }
  const prepared = preparation?.state;
  const sourceCapture =
    preparation?.sourceCapture ?? retained?.source.sourceCapture ?? createPluginSourceCapture();
  const directory = sourceCapture.directory;
  const packages = new Map<string, PluginPackageCapture>();
  const packageStates = prepared?.packages ?? new Map<string, CapturedPackageState>();
  const hydrateModules: Array<() => void> = [];
  const packageForFile = (filename: string) =>
    findPluginCapturedPackage(packages, filename, directory)?.owner;
  const capturedPaths = prepared?.capturedPaths ?? new Map<string, string>();
  const originalSources = prepared?.originalSources ?? new Map<string, string>();
  const hardlinkedSources = prepared?.hardlinkedSources ?? new Set<string>();
  const nativeAdmission = createPluginNativeAdmission(
    rootDir,
    directory,
    entryFiles,
    nativeRecovery,
    sourceCapture.outputRoot,
    prepared?.native,
    preparation?.admission,
  );
  const metadata = prepared?.metadata ?? { scopes: new Map(), pending: new Set<string>() };
  const metadataCapture = createPluginPackageMetadataCapture({
    state: metadata,
    prepareAliases(target, source, manifest) {
      for (const alias of importTargetNames(manifest.imports)) {
        if (alias === "openclaw" || alias === "@openclaw/plugin-sdk") {
          continue;
        }
        const dependency = resolveDependency(alias, source);
        if (dependency) {
          packageForFile(target)!.captureDependency(alias, dependency, true);
        }
      }
    },
    sourceForCaptured: (filename) => originalSources.get(filename),
    packageForFile,
    isRetainedReference: nativeAdmission.isRetainedReference,
    resolveSource: nativeAdmission.resolvePreparedSource,
  });
  const sourceAliases: Record<string, string> = prepared?.sourceAliases ?? {};
  const dependencies =
    prepared?.dependencies ?? new Map<string, PluginDependencyResolution | undefined>();
  const sourceFacts = createPluginSourceFacts(
    dependencyLookupBoundary,
    captureForCustody,
    dependencies,
  );
  const receipt = createPluginGenerationReceipt(nativeAdmission.prepared, prepared?.receipt);
  const { additions, capture: acquireSources, assertModuleAvailable } = sourceCapture;
  const captureAdmitted = <T>(run: () => T) => {
    const acquired = execute ? execute(() => acquireSources(run)) : acquireSources(run);
    nativeAdmission.finish(receipt.finish());
    return acquired;
  };
  const moduleCaptures = new Map<string, PluginModuleCapture>();
  const resolution = preparation?.resolution ?? createPluginCaptureResolver();
  const resolveDependency = sourceFacts.resolveDependency;
  // Callers canonicalize roots; already-captured packages survive removal of their original files.
  const copyPackage = (
    root: string,
    entry?: string,
    metadataOnly = false,
    executableEntry = false,
    restored?: CapturedPackageState,
  ): string => {
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
    const packageState: CapturedPackageState = restored ?? {
      entry,
      executableEntry,
      links: new Set(),
      state: "metadata",
      missingTargets: new Set(),
      sourceLinks: new Set(),
      scopes: new Map(),
      references: new Map(),
      nativeScopes: new Map(),
      modules: new Map(),
    };
    packageStates.set(root, packageState);
    const packageMap = createPluginPackageMapReferences(packageState.missingTargets);
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
      links: packageState.links,
      get state() {
        return packageState.state;
      },
      set state(value) {
        packageState.state = value;
      },
      captureDependency: (name, dependency, captureMetadataOnly) =>
        linkDependency(name, dependency, captureMetadataOnly),
      captureTarget(filename) {
        const source = path.join(boundary, path.relative(destination, filename));
        if (
          !capturedPaths.has(source) &&
          !packageMap.hasMissingTarget(source) &&
          fs.statSync(source, { throwIfNoEntry: false })?.isFile() &&
          (isPathInside(boundary, fs.realpathSync(source)) ||
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
    const sourceLinks = createPluginSourceLinkCapture(packageState.sourceLinks);
    const copy = createPluginGenerationFileCapture({
      boundary,
      destination,
      directory,
      outputRoot,
      capturedPaths,
      originalSources,
      hardlinkedSources,
      sourceCapture,
      sourceLinks,
      deferExternalLinks: Boolean(execute),
      nativeAdmission,
      receipt,
      retained,
      sourceFacts: sourceFacts.files,
      onPackageMetadata(source, target) {
        metadataCapture.record(target, source);
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
      packages.get(dependency.root)!.links.add(link);
      if (!fs.existsSync(link)) {
        fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
        fs.symlinkSync(path.relative(path.dirname(link), captured), link, "junction");
        additions.add(link);
      }
    };
    const scopes = metadataCapture.createScope({
      root,
      destination,
      boundary,
      copy,
      hasSource: (source) => capturedPaths.has(source),
      capturedScopes: packageState.scopes,
    });
    const references = packageState.references;
    const getNativeScope = createPluginNativeDependencyScopes(
      resolveDependency,
      (name, dependency) => linkDependency(name, dependency, true),
      packageState.nativeScopes,
    );
    const scannedDirectories = new Set<string>();
    const captureFile = (source: string, restoredModule?: CapturedModuleState): void => {
      const existingSource = capturedPaths.get(path.resolve(source));
      if (existingSource) {
        assertModuleAvailable(existingSource);
      }
      if (
        existingSource &&
        (!/\.[cm]?[jt]sx?$/.test(source) || moduleCaptures.has(existingSource))
      ) {
        return;
      }
      const target = existingSource ?? path.join(destination, path.relative(root, source));
      if (!existingSource) {
        const nativePrepared = nativeAdmission.resolvePreparedSource(source);
        const real = fs.realpathSync(nativePrepared?.path ?? source);
        if (
          !isPathInside(nativePrepared?.boundary ?? boundary, real) &&
          !nativeAdmission.isRetainedReference(source, real)
        ) {
          throw new Error("Standalone plugin input leaves its source directory");
        }
        if (!nativePrepared && outputRoot && isPathInside(outputRoot, real)) {
          return;
        }
        if (fs.statSync(real).isDirectory()) {
          if (scannedDirectories.has(real)) {
            throw new Error("Standalone plugin input contains a directory cycle");
          }
          scannedDirectories.add(real);
          for (const name of fs.readdirSync(real).toSorted()) {
            if (isPluginSourceEntry(name)) {
              captureFile(path.join(source, name));
            }
          }
          scannedDirectories.delete(real);
          return;
        }
        copy(source, target);
      }
      if (!/\.[cm]?[jt]sx?$/.test(source)) {
        return;
      }
      const moduleState: CapturedModuleState = restoredModule ?? {
        source,
        scope: scopes.resolve(path.dirname(source)),
        tsconfigPaths: resolution.hasTsconfigPaths(source),
        observed: new Map(),
        dependencies: new Map(),
      };
      const scope = moduleState.scope;
      packageState.modules.set(target, moduleState);
      const prepareDependency = createPluginDependencyLookup(
        source,
        scope?.manifest,
        resolveDependency,
        linkDependency,
        moduleState.dependencies,
      );
      const captureReference = createPluginGenerationReferenceCapture({
        moduleState,
        resolution,
        moduleSource,
        originalSources,
        nativeAdmission,
        references,
        packageMap,
        boundary,
        capturedPaths,
        captureFile,
        resolveDependency,
        executable: Boolean(execute),
        captureExecutableFile,
        lexicalBoundary: entry && !executableEntry ? path.resolve(rootDir) : root,
        root,
        destination,
        owner,
        sourceLinks,
      });
      const observed = moduleState.observed;
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
        specifier: string,
        conditions: readonly string[],
      ): { target: URL } | { retryNative: true } | undefined => {
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
        if (moduleState.tsconfigPaths && bare && !self && !specifier.startsWith("#")) {
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
        staticImports: moduleState.staticImports,
        isNativeImportPattern: createPluginNativeImportPattern(scope?.manifest.imports),
        isRequireReference: (specifier) =>
          observed.has(`require\0${specifier}`) && !observed.has(`import\0${specifier}`),
        prepareDependency,
        nativeScope: getNativeScope(source, scope?.manifest),
        capture: captureModule,
      };
      moduleCaptures.set(target, moduleCapture);
      // Only Bun previews need deferred-code facts without acquiring unresolved references.
      if (!restoredModule && ((entry && !executableEntry) || process.versions.bun)) {
        moduleCapture.staticImports = moduleState.staticImports = visitPluginSourceReferences(
          source,
          fs.readFileSync(target, "utf8"),
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
      const manifest = capturePluginDependencies({
        root,
        manifestFile: entry ? undefined : path.join(destination, "package.json"),
        references,
        resolve: resolveDependency,
        capture: linkDependency,
      });
      if (!entry) {
        metadataCapture.setManifest(path.join(destination, "package.json"), manifest);
      }
    };
    if (restored) {
      hydrateModules.push(() => {
        for (const module of restored.modules.values()) {
          captureFile(module.source, module);
        }
      });
    } else if (metadataOnly) {
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
  const captureExecutableFile = (filename: string): string | undefined =>
    execute?.(() => {
      const real = fs.realpathSync(filename);
      if (!fs.statSync(real).isFile()) {
        return undefined;
      }
      copyPackage(resolvePluginModulePackageRoot(real), real, false, true);
      return real;
    });

  try {
    const sourceRoot = prepared?.sourceRoot ?? fs.realpathSync(rootDir);
    let root: string;
    if (prepared) {
      for (const [source, state] of packageStates) {
        copyPackage(source, state.entry, true, state.executableEntry, state);
      }
      for (const hydrate of hydrateModules) {
        hydrate();
      }
      root = prepared.capturedRoot;
    } else {
      const entries = entryFiles?.map((file) => fs.realpathSync(file));
      root = copyPackage(sourceRoot, entries?.[0]);
      for (const entry of entries?.slice(1) ?? []) {
        packages.get(sourceRoot)!.materialize(entry);
      }
      sourceAliases[path.resolve(rootDir)] = root;
      for (const [index, entry] of entries?.entries() ?? []) {
        const alias = path.join(
          sourceRoot,
          path.relative(path.resolve(rootDir), path.resolve(entryFiles![index]!)),
        );
        capturedPaths.set(alias, capturedPaths.get(entry)!);
      }
    }
    const initialReceipt = receipt.finish();
    nativeAdmission.finish(initialReceipt);
    additions.clear();
    preparation?.prepared?.({
      sourceRoot,
      capturedRoot: root,
      sourceAliases,
      capturedPaths,
      originalSources,
      hardlinkedSources,
      packages: packageStates,
      dependencies,
      metadata,
      native: nativeAdmission.snapshot(),
      receipt: initialReceipt,
    });
    const captures = [
      moduleCaptures,
      hardlinkedSources,
      metadataCapture,
      packages,
      packageStates,
      resolution,
    ];
    const clearCaptures = () => captures.forEach((capture) => capture.clear());
    const sourceLookup = createPluginGenerationSourceLookup({
      rootDir,
      sourceRoot,
      capturedRoot: root,
      boundaryRoot: directory,
      capturedPaths,
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
      ...sourceLookup,
      retainSourceCustody: () => sourceFacts.captureCustody(sourceLookup.captureRecoverySource),
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
        try {
          (retained?.source ?? sourceCapture).dispose();
        } finally {
          nativeAdmission.dispose();
          clearCaptures();
        }
      },
      disposeAsync: async () => {
        try {
          await (retained?.source ?? sourceCapture).disposeAsync();
        } finally {
          await nativeAdmission.disposeAsync();
          clearCaptures();
        }
      },
    };
  } catch (error) {
    // Preparation custody is released by the host only after its worker has exited.
    if (!preparation) {
      try {
        (retained?.source ?? sourceCapture).dispose();
      } finally {
        nativeAdmission.dispose();
      }
    } else {
      nativeAdmission.dispose();
    }
    throw error;
  }
}
