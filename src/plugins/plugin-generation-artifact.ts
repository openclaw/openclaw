import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleResolve } from "import-meta-resolve";
import type { JitiOptions } from "jiti";
import { isPathInside } from "../infra/path-guards.js";
import { createJiti } from "./jiti-factory.js";
import {
  createPluginGenerationFileCapture,
  createPluginSourceLinkCapture,
} from "./plugin-generation-file-capture.js";
import { createPluginGenerationReceipt } from "./plugin-generation-receipt.js";
import { createPluginGenerationSourceLookup } from "./plugin-generation-source-lookup.js";
import {
  createPluginNativeAdmission,
  type PluginNativeRecovery,
} from "./plugin-native-admission.js";
import {
  capturePluginPackageMetadata,
  capturePluginDependencies,
  capturePluginModuleSource,
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
  capturedPluginModuleUrl,
  visitPluginSourceReferences,
} from "./plugin-source-references.js";
import { verifyPluginSourceInputs } from "./plugin-source-verification.js";

/** Capture selective entries and whole dependencies without replacing earlier file bytes. */
export function capturePluginGenerationArtifact(
  rootDir: string,
  entryFile?: string,
  execute?: <T>(run: () => T) => T,
  moduleSource?: (filename: string) => string,
  nativeRecovery?: PluginNativeRecovery,
) {
  const sourceCapture = createPluginSourceCapture(execute);
  const directory = sourceCapture.directory;
  const packages = new Map<string, PluginPackageCapture>();
  const capturedPaths = new Map<string, string>();
  const originalSources = new Map<string, string>();
  const hardlinkedSources = new Set<string>();
  const nativeAdmission = createPluginNativeAdmission(
    rootDir,
    directory,
    entryFile,
    nativeRecovery,
    sourceCapture.outputRoot,
  );
  const metadataCapture = createPluginPackageMetadataCapture({
    sourceForCaptured: (filename) => originalSources.get(filename),
    packageForFile: (filename) => packageForFile(filename),
    isRetainedReference: nativeAdmission.isRetainedReference,
    resolveSource: nativeAdmission.resolvePreparedSource,
  });
  const sourceAliases: Record<string, string> = {};
  const receipt = createPluginGenerationReceipt(nativeAdmission.prepared);
  const {
    inputs,
    pendingInputs,
    additions,
    capture: acquireSources,
    assertModuleAvailable,
  } = sourceCapture;
  const captureAdmitted = <T>(run: () => T) => {
    const acquired = acquireSources(run);
    nativeAdmission.finish(directory, receipt.finish());
    return acquired;
  };
  const moduleCaptures = new Map<string, PluginModuleCapture>();
  const resolveDependency = createPluginDependencyResolver();
  // Callers canonicalize roots; already-captured packages survive removal of their original files.
  const copyPackage = (
    root: string,
    entry?: string,
    metadataOnly = false,
    executableEntry = false,
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
      return existing.destination;
    }
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
    const capturedBoundary = destination;
    sourceAliases[root] = destination;
    receipt.marker(`${packageId}\0`);
    const owner: PluginPackageCapture = {
      destination,
      capturedRoot: capturedBoundary,
      sourceRoot: boundary,
      links: new Set<string>(),
      state: "metadata",
      captureTarget(filename) {
        const source = path.join(boundary, path.relative(capturedBoundary, filename));
        if (
          !capturedPaths.has(source) &&
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
    const sourceLinks = createPluginSourceLinkCapture();
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
        ? path.join(capturedBoundary, path.relative(boundary, dependency.lookupDirectory))
        : path.join(dependency.lookupDirectory, "node_modules") === sourceModuleRoot
          ? path.dirname(moduleRoot)
          : capturedBoundary;
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
    });
    const references = new Map<string, Set<string>>();
    const getNativeScope = createPluginNativeDependencyScopes(
      resolveDependency,
      (name, dependency) => linkDependency(name, dependency, true),
    );
    const scannedDirectories = new Set<string>();
    const captureFile = (source: string, options?: JitiOptions): void => {
      const existingSource = capturedPaths.get(path.resolve(source));
      if (
        existingSource &&
        (!/\.[cm]?[jt]sx?$/.test(source) || moduleCaptures.has(existingSource))
      ) {
        return;
      }
      const target = existingSource ?? path.join(destination, path.relative(root, source));
      if (!existingSource) {
        const prepared = nativeAdmission.resolvePreparedSource(source);
        const real = fs.realpathSync(prepared?.path ?? source);
        if (
          !isPathInside(prepared?.boundary ?? boundary, real) &&
          !nativeAdmission.isRetainedReference(source, real)
        ) {
          throw new Error("Standalone plugin input leaves its source directory");
        }
        if (!prepared && outputRoot && isPathInside(outputRoot, real)) {
          return;
        }
        if (fs.statSync(real).isDirectory()) {
          if (scannedDirectories.has(real)) {
            throw new Error("Standalone plugin input contains a directory cycle");
          }
          scannedDirectories.add(real);
          for (const name of fs.readdirSync(real).toSorted()) {
            if (name !== "node_modules" && name !== ".git") {
              captureFile(path.join(source, name), options);
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
      const scope = scopes.resolve(path.dirname(source));
      const prepareDependency = createPluginDependencyLookup(
        source,
        scope?.manifest,
        resolveDependency,
        linkDependency,
      );
      const resolver = createJiti(source, {
        ...options,
        fsCache: false,
        moduleCache: false,
        tryNative: false,
      });
      const captureReference = (
        reference: string,
        kind: "asset" | "import" | "require",
        conditions?: readonly string[],
      ): string | null | undefined => {
        const module = kind !== "asset";
        const importUrl =
          kind === "import" && reference.startsWith(".")
            ? new URL(reference, pathToFileURL(source))
            : undefined;
        const value = importUrl
          ? `./${path.relative(path.dirname(source), fileURLToPath(importUrl))}`
          : module && reference.startsWith("file:")
            ? fileURLToPath(reference)
            : reference;
        const resolve = (specifier: string) => {
          const resolved = resolver.esmResolve(specifier, {
            try: true,
            conditions: conditions
              ? [...conditions]
              : kind === "require"
                ? ["node", "require"]
                : ["node", "import"],
          });
          if (!resolved?.startsWith("file:")) {
            return resolved;
          }
          // Native resolution may return this generation's compiler output, not a new input.
          const url = new URL(resolved);
          const filename = fileURLToPath(url);
          const captured = moduleSource?.(filename) ?? filename;
          url.pathname = pathToFileURL(
            originalSources.get(captured) ??
              nativeAdmission.sourceForPrepared(captured) ??
              captured,
          ).pathname;
          return url.href;
        };
        const addDependency = (name: string, importer = source) => {
          const imports = references.get(importer) ?? new Set<string>();
          imports.add(name);
          references.set(importer, imports);
        };
        if (module && !value.startsWith(".") && !path.isAbsolute(value)) {
          if (isBuiltin(value)) {
            return undefined;
          }
          const name = packageName(value);
          const resolved = resolve(value);
          const input = resolved?.startsWith("file:") ? fileURLToPath(resolved) : resolved;
          if (
            resolver.options.tsconfigPaths &&
            name !== "openclaw" &&
            name !== "@openclaw/plugin-sdk" &&
            resolved?.startsWith("file:") &&
            input
          ) {
            if (
              inPackage(boundary, input) &&
              (capturedPaths.has(path.resolve(input)) ||
                inPackage(boundary, fs.realpathSync(input)))
            ) {
              captureFile(input, resolver.options);
              return input;
            }
            if (!isPathInside(resolveDependency(name, source)?.root ?? boundary, input)) {
              return conditions && execute ? captureExecutableFile(input) : null;
            }
          }
          const self = scope?.manifest.exports != null && scope.manifest.name === name;
          if (!value.startsWith("#") && !self) {
            if (conditions && !resolved) {
              return undefined;
            }
            addDependency(name);
            return resolved?.startsWith("file:") ? input : undefined;
          }
          if (!input || isBuiltin(input)) {
            return undefined;
          }
          let external = false;
          if (!self && scope) {
            // Jiti selects the condition/target. String leaves identify lookup aliases only;
            // preserve every matching alias when several names share one physical package.
            for (const alias of scope.aliases) {
              const dependency = resolveDependency(alias, scope.source);
              if (dependency && isPathInside(dependency.root, input)) {
                addDependency(alias, scope.source);
                external = true;
              }
            }
          }
          if (!external) {
            captureFile(input, resolver.options);
          }
          return input;
        }
        const requested = path.resolve(path.dirname(source), value);
        const lexicalBoundary = entry && !executableEntry ? path.resolve(rootDir) : root;
        const local =
          module && path.isAbsolute(value) && isPathInside(lexicalBoundary, requested)
            ? path.join(boundary, path.relative(lexicalBoundary, requested))
            : requested;
        if (module && !isPathInside(boundary, local)) {
          if (!conditions || !execute) {
            return null;
          }
          const selected = resolve(local);
          if (!selected?.startsWith("file:")) {
            return undefined;
          }
          return captureExecutableFile(fileURLToPath(selected));
        }
        if (
          !value ||
          (!module && path.isAbsolute(value)) ||
          !isPathInside(boundary, local) ||
          local === boundary
        ) {
          return undefined;
        }
        // Dependency files retain their package owner, rather than becoming public source inputs.
        if (
          module &&
          path.isAbsolute(value) &&
          path.relative(boundary, local).split(path.sep).includes("node_modules")
        ) {
          return undefined;
        }
        // Captured local peers survive edits; deferred links enter only on executable demand.
        const fromCopy = owner.state === "body" && !sourceLinks.contains(local);
        const moduleRequest =
          nativeAdmission.resolvePreparedSource(local)?.path ??
          (fromCopy ? path.join(destination, path.relative(root, local)) : local);
        const resolved = module ? resolve(moduleRequest) : undefined;
        if (module && !resolved) {
          return undefined;
        }
        const input = resolved?.startsWith("file:") ? fileURLToPath(resolved) : (resolved ?? local);
        const capturedInput = capturedPaths.has(path.resolve(input));
        const preparedInput = nativeAdmission.resolvePreparedSource(input);
        if (capturedInput || fs.existsSync(preparedInput?.path ?? input)) {
          if (
            module &&
            execute &&
            !capturedInput &&
            !preparedInput &&
            !isPathInside(boundary, fs.realpathSync(input))
          ) {
            return conditions ? captureExecutableFile(input) : null;
          }
          captureFile(input, resolver.options);
          if (module && path.isAbsolute(value)) {
            capturedPaths.set(requested, capturedPaths.get(path.resolve(input))!);
          }
          return input;
        }
        return undefined;
      };
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
          return { target: capturedPluginModuleUrl(known, specifier, conditions) };
        }
        const name = packageName(specifier);
        const self = scope?.manifest.exports != null && scope.manifest.name === name;
        const bare =
          !specifier.startsWith(".") &&
          !path.isAbsolute(specifier) &&
          !specifier.startsWith("file:");
        if (resolver.options.tsconfigPaths && bare && !self && !specifier.startsWith("#")) {
          // Jiti still owns configured source paths; package maps below use captured metadata.
          const mapped = captureObservedReference(
            specifier,
            conditions.includes("require") ? "require" : "import",
            conditions,
          );
          if (mapped && capturedPaths.has(path.resolve(mapped))) {
            captureDependencies();
            return { target: pathToFileURL(capturedPaths.get(path.resolve(mapped))!) };
          }
        }
        const dependencyPrepared = prepareDependency(specifier);
        if (typeof dependencyPrepared === "boolean") {
          return dependencyPrepared ? { retryNative: true } : undefined;
        }
        if (dependencyPrepared === "package-map") {
          let selected: URL;
          try {
            selected = moduleResolve(specifier, pathToFileURL(target), new Set(conditions));
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "ERR_MODULE_NOT_FOUND"
            ) {
              throw error;
            }
            if (!("url" in error) || typeof error.url !== "string") {
              return undefined;
            }
            // Node chose this target from immutable metadata; only its body is still uncaptured.
            selected = new URL(error.url);
          }
          if (selected.protocol !== "file:") {
            return undefined;
          }
          const filename = fileURLToPath(selected);
          if (inPackage(capturedBoundary, filename)) {
            const original = path.join(boundary, path.relative(capturedBoundary, filename));
            if (!capturedPaths.has(original) && !fs.existsSync(original)) {
              return undefined;
            }
            captureFile(original, resolver.options);
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
        return { target: capturedPluginModuleUrl(captured, specifier, conditions) };
      };
      const nativeScope = getNativeScope(source, scope?.manifest);
      moduleCaptures.set(target, { prepareDependency, nativeScope, capture: captureModule });
      if (entry && !executableEntry) {
        visitPluginSourceReferences(
          source,
          fs.readFileSync(target, "utf8"),
          resolver,
          captureObservedReference,
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
  const captureExecutableFile = (filename: string): string | undefined =>
    execute?.(() =>
      capturePluginModuleSource(filename, (root, source) => copyPackage(root, source, false, true)),
    );
  const packageForFile = (filename: string) =>
    findPluginCapturedPackage(packages, filename, directory)?.owner;

  try {
    const sourceRoot = fs.realpathSync(rootDir);
    const entry = entryFile ? fs.realpathSync(entryFile) : undefined;
    const root = copyPackage(sourceRoot, entry);
    sourceAliases[path.resolve(rootDir)] = root;
    if (entry && entryFile) {
      const alias = path.join(
        sourceRoot,
        path.relative(path.resolve(rootDir), path.resolve(entryFile)),
      );
      capturedPaths.set(alias, capturedPaths.get(entry)!);
    }
    const assertSourceCurrent = () => {
      if (
        fs.realpathSync(rootDir) !== sourceRoot ||
        (entryFile && fs.realpathSync(entryFile) !== entry)
      ) {
        throw new Error("Plugin source root changed after capture");
      }
      nativeAdmission.reconcileSourceInputs(inputs);
      verifyPluginSourceInputs(inputs, inputs.keys());
    };
    const initialReceipt = receipt.finish();
    assertSourceCurrent();
    nativeAdmission.finish(directory, initialReceipt);
    pendingInputs.clear();
    additions.clear();
    const captures = [moduleCaptures, hardlinkedSources, metadataCapture, packages];
    const clearCaptures = () => captures.forEach((capture) => capture.clear());
    return {
      sourceRoot,
      rootDir: root,
      sourceAliases,
      linkHost: (hostRoot: string) => {
        sourceCapture.linkHost(hostRoot);
        for (const [source, identity] of nativeAdmission.linkHost(hostRoot)) {
          const input = inputs.get(source);
          if (input?.native) {
            input.identity = identity;
          }
        }
        nativeAdmission.reconcileSourceInputs(inputs);
      },
      sourceForCaptured: (file: string) => originalSources.get(path.resolve(file)),
      boundaryRoot: directory,
      // The receipt attests the initial snapshot; first-demand inputs extend only its identity ledger.
      sourceDigest: initialReceipt.sourceDigest,
      ...createPluginGenerationSourceLookup({
        rootDir,
        sourceRoot,
        capturedRoot: root,
        boundaryRoot: directory,
        capturedPaths,
        hardlinkedSources,
        assertModuleAvailable,
        captureNativeRecovery: () => nativeAdmission.captureRecovery(initialReceipt, sourceAliases),
      }),
      assertSourceCurrent,
      moduleRoot: (filename: string) =>
        originalSources.has(filename) ? packageForFile(filename)?.capturedRoot : undefined,
      assertModuleAvailable,
      prepareModule: (filename: string) => {
        const owner = packageForFile(filename);
        const source = originalSources.get(filename);
        const needsEntry =
          execute && source && /\.[cm]?[jt]sx?$/.test(source) && !moduleCaptures.has(filename);
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
      dispose: () => {
        sourceCapture.dispose();
        clearCaptures();
      },
      disposeAsync: () => sourceCapture.disposeAsync().then(clearCaptures),
    };
  } catch (error) {
    sourceCapture.dispose();
    throw error;
  }
}
