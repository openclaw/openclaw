import { createHash } from "node:crypto";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleResolve } from "import-meta-resolve";
import type { JitiOptions } from "jiti";
import { isPathInside } from "../infra/path-guards.js";
import { createJiti } from "./jiti-factory.js";
import {
  capturePluginPackageMetadata,
  capturePluginDependencies,
  capturePluginModuleSource,
  createPluginDependencyLookup,
  createPluginDependencyResolver,
  createPluginNativeDependencyScopes,
  packageName,
  importTargetNames,
  createPluginSourceLinkCapture,
  pluginSourceStatIdentity,
  verifyPluginSourceInputs,
  pluginSourceContentHash,
  readPluginSourceBytes,
  createPluginPackageMetadataCapture,
  createPluginSourceCapture,
  type PluginPackageCapture,
  type PluginModuleCapture,
  isPluginPackageFile as inPackage,
  findPluginCapturedPackage,
} from "./plugin-package-metadata-capture.js";
import {
  capturedPluginModuleUrl,
  visitPluginSourceReferences,
} from "./plugin-source-references.js";

/** Capture selective entries and whole dependencies without replacing earlier file bytes. */
export function capturePluginGenerationArtifact(
  rootDir: string,
  entryFile?: string,
  inputBoundaryRoot = rootDir,
  execute?: <T>(run: () => T) => T,
  moduleSource?: (filename: string) => string,
) {
  const sourceCapture = createPluginSourceCapture(execute);
  const directory = sourceCapture.directory;
  const packages = new Map<string, PluginPackageCapture>();
  const capturedPaths = new Map<string, string>();
  const originalSources = new Map<string, string>();
  const hardlinkedSources = new Set<string>();
  const metadataCapture = createPluginPackageMetadataCapture({
    sourceForCaptured: (filename) => originalSources.get(filename),
    packageForFile: (filename) => packageForFile(filename),
  });
  const sourceAliases: Record<string, string> = {};
  const digest = createHash("sha256");
  const {
    inputs,
    pendingInputs,
    additions,
    capture: captureAdmitted,
    assertModuleAvailable,
  } = sourceCapture;
  const moduleCaptures = new Map<string, PluginModuleCapture>();
  const dependencyRoot = createPluginDependencyResolver();
  // Callers canonicalize roots; already-captured packages survive removal of their original files.
  const copyPackage = (
    root: string,
    entry?: string,
    metadataOnly = false,
    executableEntry = false,
  ): string => {
    const boundary = entry && !executableEntry ? fs.realpathSync(inputBoundaryRoot) : root;
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
    const destination = path.join(
      moduleRoot,
      parentName.startsWith("@") ? parentName : "",
      path.basename(boundary),
      path.relative(boundary, root),
    );
    const capturedBoundary = path.resolve(destination, path.relative(root, boundary));
    sourceAliases[boundary] = capturedBoundary;
    sourceAliases[root] = destination;
    if (entry && !executableEntry) {
      sourceAliases[path.resolve(inputBoundaryRoot)] = capturedBoundary;
    }
    digest.update(packageId).update("\0");
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
          isPathInside(boundary, fs.realpathSync(source))
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
    const ancestors = new Set<string>();
    const sourceLinks = createPluginSourceLinkCapture();
    const copy = (source: string, target: string) => {
      // Metadata can precede its package body; promotion never replaces those captured bytes.
      if (capturedPaths.get(path.resolve(source)) === target) {
        return;
      }
      const real = fs.realpathSync(source);
      if (!isPathInside(boundary, real)) {
        throw new Error(
          `Plugin source link leaves its package: ${path.relative(root, source)}. Declare shared code as a package dependency.`,
        );
      }
      const stat = fs.statSync(real, { bigint: true });
      const captured = capturedPaths.get(real);
      const recordContent = (content: Buffer | string[]) => {
        if (!captured) {
          // Filesystem ticks can hide edits. Retain the bytes or member names actually copied,
          // not just stat fields; cached aliases must keep their first capture's facts.
          inputs.set(real, {
            identity: pluginSourceStatIdentity(stat),
            contentHash: pluginSourceContentHash(content),
            directory: stat.isDirectory(),
            boundary,
          });
          pendingInputs.add(real);
        }
      };
      capturedPaths.set(path.resolve(source), target);
      originalSources.set(target, path.resolve(source));
      // SDK companion loaders receive copied paths; those exact aliases retain this owner.
      capturedPaths.set(target, target);
      if (!capturedPaths.has(real)) {
        capturedPaths.set(real, target);
      }
      // Receipts cover copied empty directories as well as file contents.
      digest
        .update(stat.isDirectory() ? "directory\0" : "file\0")
        .update(path.relative(destination, target))
        .update("\0");
      if (stat.isDirectory()) {
        if (ancestors.has(real)) {
          throw new Error(`Plugin source contains a directory cycle: ${source}`);
        }
        ancestors.add(real);
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        const names = fs.readdirSync(real).toSorted();
        recordContent(names);
        for (const name of names) {
          if (
            name !== "node_modules" &&
            name !== ".git" &&
            !(execute && sourceLinks.defer(path.join(source, name), boundary))
          ) {
            copy(path.join(source, name), path.join(target, name));
          }
        }
        ancestors.delete(real);
      } else if (stat.isFile()) {
        if (stat.nlink > 1n) {
          hardlinkedSources.add(target);
        }
        let bytes: Buffer;
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        if (captured) {
          // A second filename for a prefetched entry retains its first bytes and source identity.
          bytes = fs.readFileSync(captured);
          fs.copyFileSync(captured, target);
        } else {
          bytes = readPluginSourceBytes(real, boundary);
          fs.writeFileSync(target, bytes, { mode: 0o600 | Number(stat.mode & 0o100n) });
        }
        recordContent(bytes);
        digest.update(String(bytes.length)).update("\0").update(bytes);
        additions.add(target);
        if (path.basename(target) === "package.json") {
          metadataCapture.record(target, (manifest) => {
            for (const alias of importTargetNames(manifest.imports)) {
              if (alias === "openclaw" || alias === "@openclaw/plugin-sdk") {
                continue;
              }
              const dependency = dependencyRoot(alias, source);
              if (dependency) {
                linkDependency(alias, source, dependency, true);
              }
            }
          });
        }
      } else {
        throw new Error(`Plugin build input is not a regular file: ${source}`);
      }
    };
    const linkDependency = (
      name: string,
      importer: string,
      dependency: string,
      captureMetadataOnly = false,
    ) => {
      const captured = copyPackage(dependency, undefined, captureMetadataOnly);
      // Native lookup starts beside this importer, including within whole-package captures.
      const link = path.join(path.dirname(capturedPaths.get(importer)!), "node_modules", name);
      packages.get(dependency)!.links.add(link);
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
      dependencyRoot,
      (name, source, dependency) => linkDependency(name, source, dependency, true),
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
        const real = fs.realpathSync(source);
        if (!isPathInside(boundary, real)) {
          throw new Error("Standalone plugin input leaves its source directory");
        }
        if (fs.statSync(source).isDirectory()) {
          if (scannedDirectories.has(real)) {
            throw new Error("Standalone plugin input contains a directory cycle");
          }
          scannedDirectories.add(real);
          for (const name of fs.readdirSync(source).toSorted()) {
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
        dependencyRoot,
        (name, dependency) => linkDependency(name, source, dependency),
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
          url.pathname = pathToFileURL(originalSources.get(captured) ?? captured).pathname;
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
            if (!isPathInside(dependencyRoot(name, source) ?? boundary, input)) {
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
              const dependency = dependencyRoot(alias, scope.source);
              if (dependency && isPathInside(dependency, input)) {
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
        const lexicalBoundary = entry && !executableEntry ? path.resolve(inputBoundaryRoot) : root;
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
        const moduleRequest = fromCopy ? path.join(destination, path.relative(root, local)) : local;
        const resolved = module ? resolve(moduleRequest) : undefined;
        if (module && !resolved) {
          return undefined;
        }
        const input = resolved?.startsWith("file:") ? fileURLToPath(resolved) : (resolved ?? local);
        const capturedInput = capturedPaths.has(path.resolve(input));
        if (capturedInput || fs.existsSync(input)) {
          if (
            module &&
            execute &&
            !capturedInput &&
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
        resolve: dependencyRoot,
        capture: linkDependency,
      });
      if (!entry) {
        metadataCapture.setManifest(path.join(destination, "package.json"), manifest);
      }
    };
    if (metadataOnly) {
      const manifest = capturePluginPackageMetadata(root, destination, copy);
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
    findPluginCapturedPackage(packages.values(), filename)?.owner;

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
      verifyPluginSourceInputs(inputs, inputs.keys());
    };
    assertSourceCurrent();
    pendingInputs.clear();
    additions.clear();
    const resolveCaptured = (source: string) => {
      const lexical = path.resolve(source);
      const canonical = isPathInside(path.resolve(rootDir), lexical)
        ? path.join(sourceRoot, path.relative(path.resolve(rootDir), lexical))
        : lexical;
      const captured = capturedPaths.get(canonical);
      return captured && isPathInside(root, captured) ? captured : undefined;
    };
    return {
      sourceRoot,
      rootDir: root,
      sourceAliases,
      linkHost: sourceCapture.linkHost,
      sourceForCaptured: (file: string) => originalSources.get(path.resolve(file)),
      boundaryRoot: directory,
      // The receipt attests the initial snapshot; first-demand inputs extend only its identity ledger.
      sourceDigest: digest.copy().digest("hex"),
      assertSourceCurrent,
      hasSource: (source: string) => resolveCaptured(source) !== undefined,
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
          const captured = findPluginCapturedPackage(packages.values(), filename);
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
      dispose: () => {
        sourceCapture.dispose();
        moduleCaptures.clear();
        hardlinkedSources.clear();
        metadataCapture.clear();
        packages.clear();
      },
    };
  } catch (error) {
    sourceCapture.dispose();
    throw error;
  }
}
