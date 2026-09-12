import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { moduleResolve } from "import-meta-resolve";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { isPathInside } from "../infra/path-guards.js";
import { escapeRegExp } from "../shared/regexp.js";

export function createPluginSourceLinkCapture() {
  const links = new Set<string>();
  return {
    defer(filename: string, root: string): boolean {
      if (
        !fs.lstatSync(filename).isSymbolicLink() ||
        isPathInside(root, fs.realpathSync(filename))
      ) {
        return false;
      }
      links.add(filename);
      return true;
    },
    contains: (filename: string) => [...links].some((link) => isPathInside(link, filename)),
  };
}

export const pluginSourceStatIdentity = (stat: fs.BigIntStats): string =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export function readPluginSourceBytes(source: string, boundary: string): Buffer {
  const opened = openRootFileSync({
    absolutePath: source,
    rootPath: boundary,
    boundaryLabel: "plugin build source",
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(`Cannot capture plugin source ${source}`, { cause: opened.error });
  }
  try {
    return fs.readFileSync(opened.fd);
  } finally {
    fs.closeSync(opened.fd);
  }
}

export const pluginSourceContentHash = (content: Buffer | string[]) =>
  createHash("sha256")
    .update(Array.isArray(content) ? JSON.stringify(content) : content)
    .digest("hex");

export type PluginSourceInput = {
  identity: string;
  contentHash: string;
  directory: boolean;
  boundary: string;
};

export function verifyPluginSourceInputs(
  inputs: ReadonlyMap<string, PluginSourceInput>,
  sources: Iterable<string>,
): void {
  for (const source of sources) {
    const input = inputs.get(source)!;
    if (
      fs.realpathSync(source) !== source ||
      pluginSourceStatIdentity(fs.statSync(source, { bigint: true })) !== input.identity ||
      pluginSourceContentHash(
        input.directory
          ? fs.readdirSync(source).toSorted()
          : readPluginSourceBytes(source, input.boundary),
      ) !== input.contentHash
    ) {
      throw new Error(
        "Plugin source changed while preparing its reload; retry after the edit finishes.",
      );
    }
  }
}

export function createPluginDependencyResolver() {
  const roots = new Map<string, string | undefined>();
  return (name: string, importer: string): string | undefined => {
    const key = `${path.dirname(importer)}\0${name}`;
    if (roots.has(key)) {
      return roots.get(key);
    }
    // Keep the lookup name: npm aliases can differ from the target package's name.
    for (const nodeModules of createRequire(importer).resolve.paths(`${name}/`) ?? []) {
      const candidate = path.join(nodeModules, name);
      if (fs.existsSync(path.join(candidate, "package.json"))) {
        const root = fs.realpathSync(candidate);
        roots.set(key, root);
        return root;
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
  capture: (name: string, root: string) => void,
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
      const root = resolve(name, importer);
      if (root) {
        capture(name, root);
      }
      prepared.set(name, root !== undefined);
    }
    return prepared.get(name);
  };
}

export function capturePluginDependencies(params: {
  root: string;
  manifestFile?: string;
  references: ReadonlyMap<string, ReadonlySet<string>>;
  resolve: ReturnType<typeof createPluginDependencyResolver>;
  capture: (name: string, importer: string, root: string) => void;
}) {
  const manifest: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  } = params.manifestFile ? JSON.parse(fs.readFileSync(params.manifestFile, "utf8")) : {};
  const dependencyNames = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const dependencies = [
    ...[...dependencyNames].toSorted().map((name) => ({
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
    params.capture(name, importer, dependency);
  }
  return manifest;
}

function resolvePluginModulePackageRoot(filename: string): string {
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
      if (
        isPathInside(root, filename) &&
        fs.statSync(filename, { throwIfNoEntry: false })?.isFile() &&
        isPathInside(root, fs.realpathSync(filename))
      ) {
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
  if (typeof value === "string") {
    return value &&
      !value.startsWith(".") &&
      !value.startsWith("#") &&
      !path.isAbsolute(value) &&
      !isBuiltin(value)
      ? [packageName(value)]
      : [];
  }
  return value && typeof value === "object" ? Object.values(value).flatMap(importTargetNames) : [];
};

/** Enumerate declared branches for acquisition; the runtime still selects its conditions. */
function* pluginPackageTargetBranches(
  value: unknown,
  conditions: string[] = [],
): Generator<{ target: string; conditions: string[] }> {
  if (typeof value === "string") {
    yield { target: value, conditions };
  } else if (Array.isArray(value)) {
    for (const item of value) {
      yield* pluginPackageTargetBranches(item, conditions);
    }
  } else if (value && typeof value === "object") {
    for (const [condition, target] of Object.entries(value)) {
      yield* pluginPackageTargetBranches(target, [...conditions, condition]);
    }
  }
}

/** Package '*' substitutes one subpath everywhere; only its declared fixed prefix is walked. */
function visitPluginPackageTargetFiles(params: {
  metadata: string;
  boundary: string;
  target: string;
  wildcard: boolean;
  visit: (filename: string, subpath?: string) => void;
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
    const stat = fs.statSync(source, { throwIfNoEntry: false });
    if (!stat) {
      return;
    }
    const real = fs.realpathSync(source);
    if (!isPathInside(params.boundary, real)) {
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
      for (const name of fs.readdirSync(source).toSorted()) {
        visit(path.join(source, name));
      }
      ancestors.delete(real);
    } else if (stat.isFile()) {
      const match = matcher?.exec(source);
      if (!matcher || match) {
        params.visit(source, match?.[1]?.split(path.sep).join("/"));
      }
    }
  };
  visit(matcher ? path.dirname(parts[0]! + "_") : filename);
}

type PluginPackageCaptureState = "metadata" | "entry" | "body" | { error: unknown };
export type PluginPackageCapture = {
  destination: string;
  capturedRoot: string;
  sourceRoot: string;
  links: Set<string>;
  state: PluginPackageCaptureState;
  materialize(entry?: string): void;
  captureTarget(filename: string): void;
};

export const isPluginPackageFile = (root: string, file: string) =>
  isPathInside(root, file) && !path.relative(root, file).split(path.sep).includes("node_modules");

/** Retain the matched lookup root; dependency links need their own source-relative mapping. */
export function findPluginCapturedPackage(
  packages: Iterable<PluginPackageCapture>,
  filename: string,
) {
  for (const owner of packages) {
    const root = [owner.capturedRoot, ...owner.links].find((candidate) =>
      isPluginPackageFile(candidate, filename),
    );
    if (root) {
      return { owner, root };
    }
  }
  return undefined;
}

/** Captured metadata and declared target preparation share the artifact lifetime. */
export function createPluginPackageMetadataCapture(params: {
  sourceForCaptured: (filename: string) => string | undefined;
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
      lookups: Map<string, string>;
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
      const lookups = new Map(scope.lookups);
      if (typeof manifest.name === "string") {
        lookups.set(manifest.name, metadata);
      }
      const declarations = [
        ...Object.entries(asOptionalRecord(manifest.imports) ?? {}).map(([key, value]) => ({
          key,
          value,
          contexts: [{ request: key, parent: metadata }],
        })),
        ...Object.entries(exportMap).map(([key, value]) => ({
          key,
          value,
          contexts: [...lookups].map(([name, parent]) => ({
            request: name + key.slice(1),
            parent,
          })),
        })),
      ];
      for (const { key, value, contexts } of declarations) {
        if (contexts.length === 0) {
          continue;
        }
        for (const { target, conditions } of pluginPackageTargetBranches(value)) {
          visitPluginPackageTargetFiles({
            metadata: sourceMetadata,
            boundary: owner.sourceRoot,
            target,
            wildcard: key.includes("*"),
            visit(filename, subpath) {
              if (subpath === undefined) {
                owner.captureTarget(
                  path.join(
                    path.dirname(metadata),
                    path.relative(path.dirname(sourceMetadata), filename),
                  ),
                );
                return;
              }
              const encoded = subpath.split("/").map(encodeURIComponent).join("/");
              for (const { request, parent } of contexts) {
                let selected: URL;
                try {
                  selected = moduleResolve(
                    request.replaceAll("*", encoded),
                    pathToFileURL(parent),
                    new Set(conditions),
                  );
                } catch (error) {
                  // Validate specificity and package '*' substitution with the existing resolver.
                  if (
                    !(error instanceof Error) ||
                    !("url" in error) ||
                    typeof error.url !== "string"
                  ) {
                    continue;
                  }
                  selected = new URL(error.url);
                }
                if (selected.protocol !== "file:") {
                  continue;
                }
                const captured = fileURLToPath(selected);
                const original = path.join(
                  path.dirname(sourceMetadata),
                  path.relative(path.dirname(metadata), captured),
                );
                if (
                  fs.existsSync(original) &&
                  fs.realpathSync(original) === fs.realpathSync(filename)
                ) {
                  params.packageForFile(captured)?.captureTarget(captured);
                }
              }
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
        lookups: new Map(),
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
    addLookup(metadata: string, name: string, importer: string) {
      const scope = metadataScopes.get(metadata)!;
      if (!scope.lookups.has(name)) {
        scope.lookups.set(name, importer);
        pendingScopes.add(metadata);
      }
    },
    get pending() {
      return pendingScopes.size > 0;
    },
    prepare: prepareNativeScopes,
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
      const packageScopes = new Map<string, PackageScope | undefined>();
      const capturedScopes = new Map<string, { source: string; target: string } | undefined>();
      const captureScopeMetadata = (
        scopeDirectory: string,
      ): { source: string; target: string } | undefined => {
        if (capturedScopes.has(scopeDirectory)) {
          return capturedScopes.get(scopeDirectory);
        }
        let scope: { source: string; target: string } | undefined;
        const source = path.join(scopeDirectory, "package.json");
        if (hasSource(source) || fs.existsSync(source)) {
          const target = path.join(destination, path.relative(root, source));
          copy(source, target);
          scope = { source, target };
        } else if (
          scopeDirectory !== boundary &&
          isPathInside(boundary, path.dirname(scopeDirectory))
        ) {
          scope = captureScopeMetadata(path.dirname(scopeDirectory));
        }
        capturedScopes.set(scopeDirectory, scope);
        return scope;
      };
      const packageScope = (scopeDirectory: string): PackageScope | undefined => {
        if (packageScopes.has(scopeDirectory)) {
          return packageScopes.get(scopeDirectory);
        }
        let scope: PackageScope | undefined;
        const capturedScope = captureScopeMetadata(scopeDirectory);
        if (capturedScope) {
          const { source: manifest, target } = capturedScope;
          const data = asOptionalRecord(JSON.parse(fs.readFileSync(target, "utf8"))) ?? {};
          metadataScopes.get(target)!.manifest = data;
          scope = {
            source: manifest,
            manifest: data,
            aliases: new Set(importTargetNames(data.imports)),
          };
          // Conditional aliases need stable metadata, but unused optional package bodies stay lazy.
          metadataScopes.get(target)!.prepareAliases(data);
        }
        packageScopes.set(scopeDirectory, scope);
        return scope;
      };
      return { captureMetadata: captureScopeMetadata, resolve: packageScope };
    },
    clear() {
      metadataScopes.clear();
      pendingScopes.clear();
    },
  };
}

/** Admissions and failed-input receipts belong to one source acquisition lifetime. */
export function createPluginSourceCapture(execute?: <T>(run: () => T) => T) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "openclaw-plugin-build-")));
  fs.chmodSync(directory, 0o700);
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
  return {
    inputs,
    pendingInputs,
    additions,
    capture: captureAdmitted,
    assertModuleAvailable,
    directory,
    linkHost: (hostRoot: string) => {
      const modules = path.join(directory, "node_modules");
      fs.mkdirSync(modules, { recursive: true, mode: 0o700 });
      // Native ESM follows the selected host's real public exports and identity.
      fs.symlinkSync(hostRoot, path.join(modules, "openclaw"), "junction");
    },
    dispose() {
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
      captureFailures.clear();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
