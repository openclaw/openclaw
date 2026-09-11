import fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { moduleResolve } from "import-meta-resolve";
import { createJiti, type JitiOptions } from "jiti";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  capturePluginPackageMetadata,
  capturePluginDependencies,
  createPluginDependencyLookup,
  createPluginDependencyResolver,
  packageName,
  importTargetNames,
  createPluginSourceLinkCapture,
  resolvePluginModulePackageRoot,
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
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "openclaw-plugin-build-")));
  fs.chmodSync(directory, 0o700);
  type PackageCapture = {
    destination: string;
    capturedRoot: string;
    links: Set<string>;
    state: "metadata" | "entry" | "body" | { error: unknown };
    materialize(entry?: string): void;
  };
  const packages = new Map<string, PackageCapture>();
  const capturedPaths = new Map<string, string>();
  const originalSources = new Map<string, string>();
  const sourceAliases: Record<string, string> = {};
  const inputs = new Map<string, string>();
  const additions = new Set<string>();
  const captureFailures = new Map<string, unknown>();
  const moduleCaptures = new Map<
    string,
    {
      prepareDependency: ReturnType<typeof createPluginDependencyLookup>;
      capture: (
        specifier: string,
        conditions: readonly string[],
      ) => { target: URL } | { retryNative: true } | undefined;
    }
  >();
  let disposed = false;
  const identity = (source: string) => {
    const stat = fs.statSync(source, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  };
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
    const owner: PackageCapture = {
      destination,
      capturedRoot: capturedBoundary,
      links: new Set<string>(),
      state: "metadata",
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
      const stat = fs.statSync(real);
      const captured = capturedPaths.get(real);
      if (!captured) {
        inputs.set(real, identity(real));
      }
      capturedPaths.set(path.resolve(source), target);
      originalSources.set(target, path.resolve(source));
      // SDK companion loaders receive copied paths; those exact aliases retain this owner.
      capturedPaths.set(target, target);
      if (!capturedPaths.has(real)) {
        capturedPaths.set(real, target);
      }
      if (stat.isDirectory()) {
        if (ancestors.has(real)) {
          throw new Error(`Plugin source contains a directory cycle: ${source}`);
        }
        ancestors.add(real);
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        for (const name of fs.readdirSync(real).toSorted()) {
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
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        if (captured) {
          // A second filename for a prefetched entry retains its first bytes and source identity.
          fs.copyFileSync(captured, target);
        } else {
          const opened = openRootFileSync({
            absolutePath: real,
            rootPath: boundary,
            boundaryLabel: "plugin build source",
            rejectHardlinks: false,
          });
          if (!opened.ok) {
            throw new Error(`Cannot capture plugin source ${source}`, { cause: opened.error });
          }
          try {
            const bytes = fs.readFileSync(opened.fd);
            fs.writeFileSync(target, bytes, { mode: 0o600 | (stat.mode & 0o100) });
          } finally {
            fs.closeSync(opened.fd);
          }
        }
        additions.add(target);
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
    type PackageScope = { source: string; manifest: Record<string, unknown>; aliases: Set<string> };
    const packageScopes = new Map<string, PackageScope | undefined>();
    const packageScope = (scopeDirectory: string): PackageScope | undefined => {
      if (packageScopes.has(scopeDirectory)) {
        return packageScopes.get(scopeDirectory);
      }
      let scope: PackageScope | undefined;
      const manifest = path.join(scopeDirectory, "package.json");
      if (capturedPaths.has(manifest) || fs.existsSync(manifest)) {
        const target = path.join(destination, path.relative(root, manifest));
        if (!capturedPaths.has(manifest)) {
          copy(manifest, target);
        }
        const data = asOptionalRecord(JSON.parse(fs.readFileSync(target, "utf8"))) ?? {};
        scope = {
          source: manifest,
          manifest: data,
          aliases: new Set(importTargetNames(data.imports)),
        };
        // Conditional aliases need stable metadata, but unused optional package bodies stay lazy.
        for (const alias of scope.aliases) {
          if (alias === "openclaw" || alias === "@openclaw/plugin-sdk") {
            continue;
          }
          const dependency = dependencyRoot(alias, manifest);
          if (dependency) {
            linkDependency(alias, manifest, dependency, true);
          }
        }
      } else if (
        scopeDirectory !== boundary &&
        isPathInside(boundary, path.dirname(scopeDirectory))
      ) {
        scope = packageScope(path.dirname(scopeDirectory));
      }
      packageScopes.set(scopeDirectory, scope);
      return scope;
    };
    const references = new Map<string, Set<string>>();
    const scannedDirectories = new Set<string>();
    const inSource = (file: string) =>
      isPathInside(boundary, file) &&
      !path.relative(boundary, file).split(path.sep).includes("node_modules");
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
      const scope = packageScope(path.dirname(source));
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
          if (
            resolver.options.tsconfigPaths &&
            name !== "openclaw" &&
            name !== "@openclaw/plugin-sdk"
          ) {
            const resolved = resolve(value);
            if (resolved?.startsWith("file:")) {
              const input = fileURLToPath(resolved);
              if (
                inSource(input) &&
                (capturedPaths.has(path.resolve(input)) || inSource(fs.realpathSync(input)))
              ) {
                captureFile(input, resolver.options);
                return input;
              }
            }
          }
          const self = scope?.manifest.exports != null && scope.manifest.name === name;
          if (!value.startsWith("#") && !self) {
            const resolved = resolve(value);
            if (conditions && !resolved) {
              return undefined;
            }
            addDependency(name);
            return resolved?.startsWith("file:") ? fileURLToPath(resolved) : undefined;
          }
          const resolved = resolve(value);
          if (!resolved || isBuiltin(resolved)) {
            return undefined;
          }
          const input = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
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
          if (mapped && inSource(mapped)) {
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
          if (
            isPathInside(capturedBoundary, filename) &&
            !path.relative(capturedBoundary, filename).split(path.sep).includes("node_modules")
          ) {
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
      moduleCaptures.set(target, { prepareDependency, capture: captureModule });
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
      capturePluginDependencies({
        root,
        manifestFile: entry ? undefined : path.join(destination, "package.json"),
        references,
        resolve: dependencyRoot,
        capture: linkDependency,
      });
    };
    if (metadataOnly) {
      capturePluginPackageMetadata(root, destination, copy);
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
      // Admission precedes source acquisition; package scope only determines captured layout.
      copyPackage(resolvePluginModulePackageRoot(real), real, false, true);
      return real;
    });
  const packageForFile = (filename: string) => {
    if (!isPathInside(directory, filename)) {
      return undefined;
    }
    return [...packages.values()].find((owner) =>
      [owner.capturedRoot, ...owner.links].some(
        (packageRoot) =>
          isPathInside(packageRoot, filename) &&
          !path.relative(packageRoot, filename).split(path.sep).includes("node_modules"),
      ),
    );
  };
  const verifyInputs = () => {
    for (const [source, before] of inputs) {
      if (identity(source) !== before) {
        throw new Error(
          "Plugin source changed while preparing its reload; retry after the edit finishes.",
        );
      }
    }
    inputs.clear();
  };
  const acquire = <T>(capture: () => T) => {
    if (disposed) {
      throw new Error("Plugin module capture has been disposed");
    }
    try {
      const value = capture();
      verifyInputs();
      return { value, additions: [...additions] };
    } catch (error) {
      // Another specifier must not admit files from an incomplete capture transaction.
      for (const filename of additions) {
        captureFailures.set(filename, error);
      }
      throw error;
    } finally {
      inputs.clear();
      additions.clear();
    }
  };
  const assertModuleAvailable = (filename: string) => {
    if (captureFailures.has(filename)) {
      throw captureFailures.get(filename);
    }
  };
  const captureAdmitted = <T>(run: () => T) => {
    const capture = () => acquire(run);
    return execute ? execute(capture) : capture();
  };
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
    verifyInputs();
    additions.clear();
    const remove = () => {
      disposed = true;
      // The capture owns compiled helpers and CJS files as well as async URL-keyed records.
      // Prefixes need no filesystem lookup after source-build disposal removes their files.
      const filenames = directory + path.sep;
      const urls = pathToFileURL(filenames).href;
      const cache = createRequire(import.meta.url).cache;
      for (const id of Object.keys(cache)) {
        if (id.startsWith(filenames) || id.startsWith(urls)) {
          delete cache[id];
        }
      }
      moduleCaptures.clear();
      packages.clear();
      captureFailures.clear();
      fs.rmSync(directory, { recursive: true, force: true });
    };
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
      sourceForCaptured: (file: string) => originalSources.get(path.resolve(file)),
      boundaryRoot: directory,
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
      captureModule: (importer: string, specifier: string, conditions: readonly string[]) => {
        const result = captureAdmitted(() =>
          moduleCaptures.get(importer)?.capture(specifier, conditions),
        );
        return result.value ? { ...result.value, additions: result.additions } : undefined;
      },
      resolve: (source: string) => {
        // Public exports may be loaded for the first time after the original package
        // has been edited or removed. Resolve only through facts captured with it.
        const captured = resolveCaptured(source);
        if (!captured) {
          throw new Error("Plugin entry is outside its captured source package");
        }
        assertModuleAvailable(captured);
        return captured;
      },
      dispose: remove,
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
