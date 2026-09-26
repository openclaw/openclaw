import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isPathInside } from "../infra/path-guards.js";
import { escapeRegExp } from "../shared/regexp.js";
import { retainPluginSourceCaptureInstance } from "./plugin-source-capture-directory.js";
import { PLUGIN_SOURCE_CAPTURE_PREFIX } from "./plugin-source-capture-path.js";
import { verifyPluginSourceInputs, type PluginSourceInput } from "./plugin-source-verification.js";

export type PluginDependencyResolution = { root: string; lookupDirectory: string };

export function createPluginDependencyResolver() {
  const roots = new Map<string, PluginDependencyResolution | undefined>();
  return (name: string, importer: string): PluginDependencyResolution | undefined => {
    const key = `${path.dirname(importer)}\0${name}`;
    if (roots.has(key)) {
      return roots.get(key);
    }
    // Keep the lookup name: npm aliases can differ from the target package's name.
    for (const nodeModules of createRequire(importer).resolve.paths(`${name}/`) ?? []) {
      const candidate = path.join(nodeModules, name);
      if (fs.existsSync(path.join(candidate, "package.json"))) {
        const resolved = {
          root: fs.realpathSync(candidate),
          lookupDirectory: path.dirname(nodeModules),
        };
        roots.set(key, resolved);
        return resolved;
      }
    }
    roots.set(key, undefined);
    return undefined;
  };
}

/** Prepare each importer's package lookup once; Node still selects its export target. */
export function createPluginDependencyLookup(
  importer: string,
  manifest: Record<string, unknown> | undefined,
  resolve: ReturnType<typeof createPluginDependencyResolver>,
  capture: (name: string, dependency: PluginDependencyResolution) => void,
) {
  const prepared = new Map<string, boolean>();
  return (specifier: string): boolean | "package-map" | undefined => {
    if (
      !specifier ||
      specifier.startsWith(".") ||
      path.isAbsolute(specifier) ||
      URL.canParse(specifier) ||
      isBuiltin(specifier)
    ) {
      return undefined;
    }
    const name = packageName(specifier);
    if (name === "openclaw" || name === "@openclaw/plugin-sdk") {
      return undefined;
    }
    if (specifier.startsWith("#") || (manifest?.exports != null && manifest.name === name)) {
      return "package-map";
    }
    if (!prepared.has(name)) {
      const dependency = resolve(name, importer);
      if (dependency) {
        capture(name, dependency);
      }
      prepared.set(name, dependency !== undefined);
    }
    return prepared.get(name);
  };
}

function pluginDependencyNames(manifest: Record<string, unknown> | undefined): Set<string> {
  return new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.optionalDependencies ?? {}),
    ...Object.keys(manifest?.peerDependencies ?? {}),
  ]);
}

type PluginNativeDependencyScope = { prepareDependencies?: () => void };

export type PluginModuleCapture = {
  prepareDependency: ReturnType<typeof createPluginDependencyLookup>;
  nativeScope: PluginNativeDependencyScope;
  capture: (
    specifier: string,
    conditions: readonly string[],
  ) => { target: URL } | { retryNative: true } | undefined;
};

/** Native resolvers need declared package lookups before they can resolve a deferred import. */
export function createPluginNativeDependencyScopes(
  resolve: ReturnType<typeof createPluginDependencyResolver>,
  capture: (name: string, dependency: PluginDependencyResolution) => void,
) {
  const scopes = new Map<string, PluginNativeDependencyScope>();
  return (source: string, manifest: Record<string, unknown> | undefined) => {
    const key = path.dirname(source);
    let scope = scopes.get(key);
    if (!scope) {
      const dependencies = [...pluginDependencyNames(manifest)].filter(
        (name) => name !== "openclaw" && name !== "@openclaw/plugin-sdk",
      );
      scope = {
        prepareDependencies: dependencies.length
          ? () => {
              for (const name of dependencies) {
                const dependency = resolve(name, source);
                if (dependency) {
                  capture(name, dependency);
                }
              }
            }
          : undefined,
      };
      scopes.set(key, scope);
    }
    return scope;
  };
}

export function capturePluginDependencies(params: {
  root: string;
  manifestFile?: string;
  references: ReadonlyMap<string, ReadonlySet<string>>;
  resolve: ReturnType<typeof createPluginDependencyResolver>;
  capture: (name: string, dependency: PluginDependencyResolution) => void;
}) {
  const manifest: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  } = params.manifestFile ? JSON.parse(fs.readFileSync(params.manifestFile, "utf8")) : {};
  const dependencies = [
    ...[...pluginDependencyNames(manifest)].toSorted().map((name) => ({
      name,
      importer: path.join(params.root, "package.json"),
    })),
    ...[...params.references].flatMap(([importer, names]) =>
      [...names].toSorted().map((name) => ({ name, importer })),
    ),
  ];
  for (const { name, importer } of dependencies) {
    // The SDK keeps host identity; declared names otherwise use package lookup, including builtins.
    if (name === "openclaw" || name === "@openclaw/plugin-sdk") {
      continue;
    }
    const dependency = params.resolve(name, importer);
    if (!dependency) {
      if (
        !params.manifestFile ||
        name in (manifest.optionalDependencies ?? {}) ||
        name in (manifest.peerDependencies ?? {})
      ) {
        continue;
      }
      throw new Error(
        `Plugin dependency ${name} is missing from ${params.root}; install its dependencies and reload.`,
      );
    }
    params.capture(name, dependency);
  }
  return manifest;
}

export function resolvePluginModulePackageRoot(filename: string): string {
  let directory = path.dirname(filename);
  while (path.basename(directory) !== "node_modules") {
    if (fs.existsSync(path.join(directory, "package.json"))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return path.dirname(filename);
}

export function capturePluginModuleSource(
  filename: string,
  capture: (root: string, source: string) => void,
): string | undefined {
  const real = fs.realpathSync(filename);
  if (!fs.statSync(real).isFile()) {
    return undefined;
  }
  // The admitted artifact owns byte capture; package metadata only selects its layout.
  capture(resolvePluginModulePackageRoot(real), real);
  return real;
}

export function capturePluginPackageMetadata(
  root: string,
  destination: string,
  copy: (source: string, target: string) => void,
  isRetainedReference?: (source: string, real: string) => boolean,
  resolveSource?: (source: string) => { path: string; boundary: string } | undefined,
) {
  const manifest = path.join(destination, "package.json");
  copy(path.join(root, "package.json"), manifest);
  let data: Record<string, unknown> | undefined;
  try {
    data = asOptionalRecord(JSON.parse(fs.readFileSync(manifest, "utf8")));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    // Keep invalid optional metadata for native validation only if that alias is selected.
  }
  if (data && data.exports == null) {
    // Node's legacy package entry search is finite; raw entry bytes let native selection
    // succeed before the chosen owner's remaining body is materialized for execution.
    const main = typeof data.main === "string" && data.main ? data.main : undefined;
    const bases = main === undefined ? ["./index"] : [`./${main}`, `./${main}/index`, "./index"];
    const candidates = [
      ...(main === undefined ? [] : [main]),
      ...bases.flatMap((base) => [".js", ".json", ".node"].map((extension) => base + extension)),
    ];
    for (const candidate of candidates) {
      const url = new URL(candidate, pathToFileURL(path.join(root, "package.json")));
      if (url.protocol !== "file:") {
        continue;
      }
      const filename = fileURLToPath(url);
      const prepared = resolveSource?.(filename);
      const input = prepared?.path ?? filename;
      if (isPathInside(root, filename) && fs.statSync(input, { throwIfNoEntry: false })?.isFile()) {
        const real = fs.realpathSync(input);
        if (
          !isPathInside(prepared?.boundary ?? root, real) &&
          !isRetainedReference?.(filename, real)
        ) {
          continue;
        }
        copy(filename, path.join(destination, path.relative(root, filename)));
        break;
      }
    }
  }
  return data;
}

export const packageName = (specifier: string) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
export const importTargetNames = (value: unknown): string[] => {
  return [...pluginPackageTargets(value)]
    .filter(
      (target) =>
        target &&
        !target.startsWith(".") &&
        !target.startsWith("#") &&
        !path.isAbsolute(target) &&
        !isBuiltin(target),
    )
    .map(packageName);
};

/** Capture declared targets; native loading owns conditions and subpath selection. */
function* pluginPackageTargets(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
  } else if (value && typeof value === "object") {
    for (const target of Object.values(value)) {
      yield* pluginPackageTargets(target);
    }
  }
}

/** Package '*' substitutes one subpath everywhere; only its declared fixed prefix is walked. */
function visitPluginPackageTargetFiles(params: {
  metadata: string;
  boundary: string;
  target: string;
  wildcard: boolean;
  visit: (filename: string) => void;
  isRetainedReference?: (source: string, real: string) => boolean;
  resolveSource?: (source: string) => { path: string; boundary: string } | undefined;
}): void {
  if (!params.target.startsWith("./")) {
    return;
  }
  const marker = randomUUID();
  let filename: string;
  try {
    filename = fileURLToPath(
      new URL(
        params.wildcard ? params.target.replaceAll("*", marker) : params.target,
        pathToFileURL(params.metadata),
      ),
    );
  } catch {
    // Native selection owns invalid URL/target errors; unused branches remain inert.
    return;
  }
  if (!isPathInside(params.boundary, filename)) {
    return;
  }
  const parts = filename.split(marker);
  const matcher =
    parts.length > 1
      ? new RegExp(
          `^${escapeRegExp(parts[0]!)}([\\s\\S]*)${parts.slice(1).map(escapeRegExp).join("\\1")}$`,
          "i",
        )
      : undefined;
  const ancestors = new Set<string>();
  const visit = (source: string) => {
    if (
      path
        .relative(params.boundary, source)
        .split(path.sep)
        .some((name) => name === ".git" || name === "node_modules")
    ) {
      return;
    }
    const prepared = params.resolveSource?.(source);
    const input = prepared?.path ?? source;
    const stat = fs.statSync(input, { throwIfNoEntry: false });
    if (!stat) {
      return;
    }
    const real = fs.realpathSync(input);
    if (
      !isPathInside(prepared?.boundary ?? params.boundary, real) &&
      !(stat.isFile() && params.isRetainedReference?.(source, real))
    ) {
      return;
    }
    if (stat.isDirectory()) {
      if (!matcher) {
        return;
      }
      if (ancestors.has(real)) {
        throw new Error(`Plugin source contains a directory cycle: ${source}`);
      }
      ancestors.add(real);
      for (const name of fs.readdirSync(input).toSorted()) {
        visit(path.join(source, name));
      }
      ancestors.delete(real);
    } else if (stat.isFile()) {
      if (!matcher || matcher.test(source)) {
        params.visit(source);
      }
    }
  };
  visit(matcher ? path.dirname(parts[0]! + "_") : filename);
}

type PluginPackageCaptureState = "metadata" | "entry" | "body" | { error: unknown };
export type PluginPackageCapture = {
  destination: string;
  /** Absolute normalized root captured by the artifact producer. */
  readonly capturedRoot: string;
  sourceRoot: string;
  /** Absolute normalized dependency links; additions remain visible to lookups. */
  links: Set<string>;
  state: PluginPackageCaptureState;
  materialize(entry?: string): void;
  captureTarget(filename: string): void;
};

export const isPluginPackageFile = (root: string, file: string) =>
  isPathInside(root, file) && !path.relative(root, file).split(path.sep).includes("node_modules");

function isCapturedPathInside(root: string, file: string): boolean {
  return process.platform === "win32"
    ? isPathInside(root, file)
    : file === root ||
        (file.startsWith(root) && (root.endsWith("/") || file.charCodeAt(root.length) === 47));
}

function isCapturedPackageFile(root: string, file: string): boolean {
  if (process.platform === "win32") {
    return isPluginPackageFile(root, file);
  }
  return (
    isCapturedPathInside(root, file) &&
    !/(?:^|\/)node_modules(?:\/|$)/u.test(file.slice(root.length))
  );
}

/** Retain the matched lookup root; dependency links need their own source-relative mapping. */
export function findPluginCapturedPackage(
  packages: ReadonlyMap<string, PluginPackageCapture>,
  filename: string,
  directory: string,
) {
  // The artifact producer normalizes its directory, captured roots, and dependency links.
  const file = process.platform === "win32" ? filename : path.resolve(filename);
  if (!isCapturedPathInside(directory, file)) {
    return undefined;
  }
  for (const owner of packages.values()) {
    if (isCapturedPackageFile(owner.capturedRoot, file)) {
      return { owner, root: owner.capturedRoot };
    }
    for (const root of owner.links) {
      if (isCapturedPackageFile(root, file)) {
        return { owner, root };
      }
    }
  }
  return undefined;
}

/** Captured metadata and declared target preparation share the artifact lifetime. */
export function createPluginPackageMetadataCapture(params: {
  sourceForCaptured: (filename: string) => string | undefined;
  isRetainedReference?: (source: string, real: string) => boolean;
  resolveSource?: (source: string) => { path: string; boundary: string } | undefined;
  packageForFile: (filename: string) =>
    | {
        sourceRoot: string;
        state: PluginPackageCaptureState;
        captureTarget(filename: string): void;
      }
    | undefined;
}) {
  const metadataScopes = new Map<
    string,
    {
      manifest?: Record<string, unknown> | null;
      prepareAliases(manifest: Record<string, unknown>): void;
    }
  >();
  const pendingScopes = new Set<string>();
  const prepareNativeScopes = () => {
    for (const metadata of pendingScopes) {
      pendingScopes.delete(metadata);
      const scope = metadataScopes.get(metadata)!;
      if (scope.manifest === undefined) {
        try {
          scope.manifest = asOptionalRecord(JSON.parse(fs.readFileSync(metadata, "utf8"))) ?? null;
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
          // Unselected malformed scope bytes remain for the native loader to validate.
          scope.manifest = null;
        }
      }
      const manifest = scope.manifest;
      const owner = params.packageForFile(metadata);
      if (!manifest || !owner) {
        continue;
      }
      scope.prepareAliases(manifest);
      // Whole package captures already contain every local target, including nested scopes.
      if (owner.state === "body") {
        continue;
      }
      const sourceMetadata = params.sourceForCaptured(metadata)!;
      const packageExports = manifest.exports;
      const exportMap =
        packageExports &&
        typeof packageExports === "object" &&
        !Array.isArray(packageExports) &&
        Object.keys(packageExports).some((key) => key.startsWith("."))
          ? (asOptionalRecord(packageExports) ?? {})
          : { ".": packageExports };
      const declarations = [
        ...Object.entries(asOptionalRecord(manifest.imports) ?? {}),
        ...Object.entries(exportMap),
      ];
      for (const [key, value] of declarations) {
        for (const target of pluginPackageTargets(value)) {
          visitPluginPackageTargetFiles({
            metadata: sourceMetadata,
            boundary: owner.sourceRoot,
            target,
            wildcard: key.includes("*"),
            isRetainedReference: params.isRetainedReference,
            resolveSource: params.resolveSource,
            visit(filename) {
              owner.captureTarget(
                path.join(
                  path.dirname(metadata),
                  path.relative(path.dirname(sourceMetadata), filename),
                ),
              );
            },
          });
        }
      }
    }
  };

  return {
    record(metadata: string, prepareAliases: (manifest: Record<string, unknown>) => void) {
      if (metadataScopes.has(metadata)) {
        return;
      }
      let aliasesPrepared = false;
      metadataScopes.set(metadata, {
        prepareAliases(manifest) {
          if (!aliasesPrepared) {
            prepareAliases(manifest);
            aliasesPrepared = true;
          }
        },
      });
      pendingScopes.add(metadata);
    },
    setManifest(metadata: string, manifest: Record<string, unknown> | null | undefined) {
      metadataScopes.get(metadata)!.manifest = manifest;
    },
    get pending() {
      return pendingScopes.size > 0;
    },
    prepare(scope?: PluginNativeDependencyScope) {
      // Bun invokes resolution hooks only after a package target exists.
      if (scope?.prepareDependencies) {
        scope.prepareDependencies();
        delete scope.prepareDependencies;
      }
      prepareNativeScopes();
    },
    createScope({
      root,
      destination,
      boundary,
      copy,
      hasSource,
    }: {
      root: string;
      destination: string;
      boundary: string;
      copy: (source: string, target: string) => void;
      hasSource: (source: string) => boolean;
    }) {
      type PackageScope = {
        source: string;
        manifest: Record<string, unknown>;
        aliases: Set<string>;
      };
      const capturedScopes = new Map<string, (() => PackageScope) | undefined>();
      const captureScopeMetadata = (scopeDirectory: string): (() => PackageScope) | undefined => {
        if (capturedScopes.has(scopeDirectory)) {
          return capturedScopes.get(scopeDirectory);
        }
        let scope: (() => PackageScope) | undefined;
        const source = path.join(scopeDirectory, "package.json");
        if (hasSource(source) || fs.existsSync(params.resolveSource?.(source)?.path ?? source)) {
          const target = path.join(destination, path.relative(root, source));
          copy(source, target);
          let parsed: PackageScope | undefined;
          scope = () => {
            if (!parsed) {
              const metadata = metadataScopes.get(target)!;
              const data =
                asOptionalRecord(metadata.manifest) ??
                asOptionalRecord(JSON.parse(fs.readFileSync(target, "utf8"))) ??
                {};
              metadata.manifest = data;
              metadata.prepareAliases(data);
              parsed = {
                source,
                manifest: data,
                aliases: new Set(importTargetNames(data.imports)),
              };
            }
            return parsed;
          };
        } else if (
          scopeDirectory !== boundary &&
          isPathInside(boundary, path.dirname(scopeDirectory))
        ) {
          scope = captureScopeMetadata(path.dirname(scopeDirectory));
        }
        capturedScopes.set(scopeDirectory, scope);
        return scope;
      };
      return {
        captureMetadata: captureScopeMetadata,
        resolve: (scopeDirectory: string) => captureScopeMetadata(scopeDirectory)?.(),
      };
    },
    clear() {
      metadataScopes.clear();
      pendingScopes.clear();
    },
  };
}

const sourceCaptureDirectory = new AsyncLocalStorage<{ directory: string; managedRoot?: string }>();

/** A compute worker's parent reclaims this scratch directory after confirmed exit. */
export function withPluginSourceCaptureDirectory<T>(
  directory: string,
  run: () => T,
  managedRoot?: string,
): T {
  return sourceCaptureDirectory.run({ directory, managedRoot }, run);
}

/** Admissions and failed-input receipts belong to one source acquisition lifetime. */
export function createPluginSourceCapture(execute?: <T>(run: () => T) => T) {
  const override = sourceCaptureDirectory.getStore();
  const instance = override === undefined ? retainPluginSourceCaptureInstance() : undefined;
  let created: string | undefined;
  let directory: string;
  try {
    created =
      override !== undefined
        ? fs.mkdtempSync(path.join(override.directory, PLUGIN_SOURCE_CAPTURE_PREFIX))
        : instance!.createDirectory();
    directory = fs.realpathSync(created);
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    if (created) {
      fs.rmSync(created, { recursive: true, force: true });
    }
    instance?.release();
    throw error;
  }
  const inputs = new Map<string, PluginSourceInput>();
  const pendingInputs = new Set<string>();
  const additions = new Set<string>();
  const captureFailures = new Map<string, unknown>();
  let disposed = false;
  const acquire = <T>(capture: () => T) => {
    if (disposed) {
      throw new Error("Plugin module capture has been disposed");
    }
    try {
      const value = capture();
      verifyPluginSourceInputs(inputs, pendingInputs);
      return { value, additions: [...additions] };
    } catch (error) {
      // Another specifier must not admit files from an incomplete capture transaction.
      for (const filename of additions) {
        captureFailures.set(filename, error);
      }
      throw error;
    } finally {
      pendingInputs.clear();
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
  const beginDisposal = () => {
    disposed = true;
    // Revoke cached modules before removal yields, including compiled CJS helpers.
    const filenames = directory + path.sep;
    const urls = pathToFileURL(filenames).href;
    const cache = createRequire(import.meta.url).cache;
    for (const id of Object.keys(cache)) {
      if (id.startsWith(filenames) || id.startsWith(urls)) {
        delete cache[id];
      }
    }
    captureFailures.clear();
  };
  return {
    inputs,
    pendingInputs,
    additions,
    capture: captureAdmitted,
    assertModuleAvailable,
    directory,
    outputRoot: override?.managedRoot ?? instance?.managedRoot,
    linkHost: (hostRoot: string) => {
      const modules = path.join(directory, "node_modules");
      fs.mkdirSync(modules, { recursive: true, mode: 0o700 });
      // Native ESM follows the selected host's real public exports and identity.
      fs.symlinkSync(hostRoot, path.join(modules, "openclaw"), "junction");
    },
    dispose() {
      beginDisposal();
      fs.rmSync(directory, { recursive: true, force: true });
      instance?.release();
    },
    async disposeAsync() {
      beginDisposal();
      await fsPromises.rm(directory, { recursive: true, force: true });
      await instance?.releaseAsync();
    },
  };
}
