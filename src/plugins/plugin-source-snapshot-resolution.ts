import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSON5 from "json5";
import { isPathInside } from "../infra/path-guards.js";
import { getPluginResolutionPolicy } from "./plugin-native-resolution.js";
import { PluginSnapshotDependencyError } from "./plugin-snapshot-dependency-error.js";
import {
  resolvePluginSnapshotConfigPath,
  selectPluginSnapshotPackageMap,
} from "./plugin-source-snapshot-package-map.js";

type Entry = { kind: "file" | "directory" | "link" };
type Configuration = { baseUrl?: string; paths?: Record<string, string[]>; pathsOrigin?: string };
type Package = {
  name?: string;
  main?: string;
  type?: string;
  exports?: unknown;
  imports?: unknown;
  tsconfig?: string;
};
export type PluginSnapshotResolutionSource = {
  payloadRoot: string;
  rootDir: string;
  sourceAliases: Readonly<Record<string, string>>;
  sourceLinks: ReadonlyMap<string, string>;
  entries: ReadonlyMap<string, Entry>;
  resolution: ReadonlyMap<string, string>;
  configuration: ReadonlyMap<string, string>;
};
export type PluginSnapshotResolvedModule = {
  /** Logical member is passed to the owner so it verifies each traversed link. */
  filename: string;
  canonical: string;
  url: string;
  external?: true;
};
type ResolutionOptions = {
  alias?: Readonly<Record<string, string>>;
  extensions?: readonly string[];
  tsconfigPaths?: boolean | string;
  runtime?: "node" | "bun";
  resolveHostModule?: (
    specifier: string,
    importer: string,
    conditions: readonly string[],
  ) => string | undefined;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuredExtensions(): readonly string[] {
  const json = (name: string, fallback: unknown): unknown => {
    try {
      return JSON.parse(process.env[name] ?? "");
    } catch {
      return fallback;
    }
  };
  const extensions = json("JITI_EXTENSIONS", [
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".mtsx",
    ".ctsx",
  ]);
  if (!Array.isArray(extensions) || !extensions.every((value) => typeof value === "string")) {
    throw new TypeError("JITI_EXTENSIONS must be an array of file extensions");
  }
  return json("JITI_JSX", false) ? [...extensions, ".jsx", ".tsx"] : extensions;
}

/** Resolve solely from sealed membership and metadata. Never consult live package/config files. */
export function createPluginSnapshotResolver(
  source: PluginSnapshotResolutionSource,
  options: ResolutionOptions = {},
) {
  const packages = new Map<string, Package>();
  const configurations = new Map<string, Configuration>();
  const runtime = options.runtime ?? (process.versions.bun ? "bun" : "node");
  const preserveSymlinks = getPluginResolutionPolicy().preserveSymlinks;
  const nodeExtensions = [".js", ".json", ".node"];
  const bunExtensions = [
    ".tsx",
    ".ts",
    ".jsx",
    ".cts",
    ".cjs",
    ".js",
    ".mjs",
    ".mts",
    ".json",
    ".node",
  ];
  const extensions = [
    ...new Set([...(options.extensions ?? configuredExtensions()), ...nodeExtensions]),
  ];
  const aliases = Object.keys(options.alias ?? {}).toSorted((a, b) => b.length - a.length);
  const insensitive = process.platform === "win32";
  const pathKey = (filename: string) => (insensitive ? filename.toLowerCase() : filename);
  const memberCase = new Map<string, string>();
  if (insensitive) {
    for (const filename of source.entries.keys()) {
      const key = pathKey(filename);
      if (memberCase.has(key)) {
        throw new PluginSnapshotDependencyError(filename);
      }
      memberCase.set(key, filename);
    }
  }
  const sourceAliases = new Map(
    Object.entries(source.sourceAliases).map(([key, value]) => [pathKey(key), value]),
  );
  const findAncestor = <T>(filename: string, find: (candidate: string) => T | undefined) => {
    for (let parent = filename; ; parent = path.dirname(parent)) {
      const result = find(parent);
      if (result !== undefined) {
        return result;
      }
      if (path.dirname(parent) === parent) {
        return undefined;
      }
    }
  };
  const capturedCase = (filename: string) => {
    if (!insensitive) {
      return filename;
    }
    const parent = findAncestor(filename, (candidate) =>
      memberCase.has(pathKey(candidate)) ? candidate : undefined,
    );
    return parent
      ? path.join(memberCase.get(pathKey(parent))!, path.relative(parent, filename))
      : filename;
  };
  const payloadPath = (filename: string) => {
    let selected = path.resolve(filename);
    const alias = findAncestor(selected, (parent) =>
      sourceAliases.has(pathKey(parent)) ? parent : undefined,
    );
    if (alias) {
      selected = path.join(sourceAliases.get(pathKey(alias))!, path.relative(alias, selected));
    }
    return capturedCase(selected);
  };
  const resolvedPath = (filename: string) => {
    let selected = payloadPath(filename);
    const seen = new Set<string>();
    const links: Array<{ link: string; target: string }> = [];
    while (!seen.has(selected)) {
      seen.add(selected);
      const link = findAncestor(selected, (parent) =>
        source.sourceLinks.has(parent) ? parent : undefined,
      );
      if (!link) {
        let logical = selected;
        for (const redirect of links.toReversed()) {
          logical = path.join(redirect.link, path.relative(redirect.target, logical));
        }
        return { canonical: selected, logical };
      }
      const target = capturedCase(source.sourceLinks.get(link)!);
      links.push({ link, target });
      selected = capturedCase(path.join(target, path.relative(link, selected)));
    }
    throw new PluginSnapshotDependencyError(filename);
  };
  const canonicalPath = (filename: string) => resolvedPath(filename).canonical;
  const modulePath = (filename: string) => {
    if (isBuiltin(filename)) {
      return filename;
    }
    const selected = resolvedPath(filename);
    return preserveSymlinks ? selected.logical : selected.canonical;
  };
  const entry = (filename: string) => source.entries.get(canonicalPath(filename));
  const packageAt = (directory: string): Package | undefined => {
    const canonical = canonicalPath(directory);
    const text = source.resolution.get(canonical);
    if (text === undefined) {
      return undefined;
    }
    let value = packages.get(canonical);
    if (!value) {
      const parsed: unknown = JSON.parse(text);
      if (!object(parsed)) {
        throw Object.assign(new Error(`Invalid package configuration at ${directory}`), {
          code: "ERR_INVALID_PACKAGE_CONFIG",
        });
      }
      value = {
        ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
        ...(typeof parsed.main === "string" ? { main: parsed.main } : {}),
        ...(typeof parsed.type === "string" ? { type: parsed.type } : {}),
        ...(typeof parsed.tsconfig === "string" ? { tsconfig: parsed.tsconfig } : {}),
        ...("exports" in parsed ? { exports: parsed.exports } : {}),
        ...("imports" in parsed ? { imports: parsed.imports } : {}),
      };
      packages.set(canonical, value);
    }
    return value;
  };
  const scope = (filename: string) =>
    findAncestor(path.dirname(filename), (directory) => {
      if (pathKey(path.basename(directory)) === "node_modules") {
        return { directory, value: undefined };
      }
      const value = packageAt(directory);
      return value ? { directory, value } : undefined;
    });
  const asModule = (input: string, suffix = ""): PluginSnapshotResolvedModule => {
    const { logical: filename, canonical } = resolvedPath(input);
    if (entry(canonical)?.kind !== "file" || !isPathInside(source.payloadRoot, canonical)) {
      throw new PluginSnapshotDependencyError(filename);
    }
    return { filename, canonical, url: pathToFileURL(modulePath(filename)).href + suffix };
  };
  const file = (filename: string, suffix = "") =>
    entry(filename)?.kind === "file" ? asModule(filename, suffix) : undefined;
  const legacyFile = (filename: string, suffix = "", order = extensions, typedSibling = true) => {
    const direct = file(filename, suffix);
    if (direct) {
      return direct;
    }
    for (const extension of order) {
      const candidate = file(filename + extension, suffix);
      if (candidate) {
        return candidate;
      }
    }
    // Jiti tries appended extensions before a TypeScript sibling of a missing JS path.
    if (typedSibling && /\.[cm]?jsx?$/.test(filename)) {
      return file(filename.replace(/\.([cm]?)j(sx?)$/, ".$1t$2"), suffix);
    }
    return undefined;
  };
  const legacyDirectory = (
    directory: string,
    suffix = "",
    order = extensions,
    typedSibling = true,
  ) => {
    if (entry(directory)?.kind !== "directory") {
      return undefined;
    }
    const main = packageAt(directory)?.main;
    if (main) {
      const target = path.resolve(directory, main);
      const selected =
        legacyFile(target, suffix, order, typedSibling) ??
        legacyFile(path.join(target, "index"), suffix, order, typedSibling);
      if (selected) {
        return selected;
      }
    }
    return legacyFile(path.join(directory, "index"), suffix, order, typedSibling);
  };
  const legacyResolve = (filename: string, suffix = "", nativeOrder?: string[]) =>
    (nativeOrder
      ? (legacyFile(filename, suffix, nativeOrder, false) ??
        legacyDirectory(filename, suffix, nativeOrder, false))
      : undefined) ??
    legacyFile(filename, suffix) ??
    legacyDirectory(filename, suffix);
  const configurationPath = (importer: string, request: string) =>
    resolvePluginSnapshotConfigPath(canonicalPath(importer), request, {
      file: (filename) => (entry(filename)?.kind === "file" ? canonicalPath(filename) : undefined),
      directory: (filename) => entry(filename)?.kind === "directory",
      packageAt,
      runtime,
    });
  const configAt = (filename: string, seen = new Set<string>()): Configuration => {
    const canonical = canonicalPath(filename);
    const cached = configurations.get(canonical);
    if (cached) {
      return cached;
    }
    if (seen.has(canonical)) {
      throw new Error(`Circular TypeScript configuration at ${filename}`);
    }
    seen.add(canonical);
    const text = source.configuration.get(canonical);
    if (text === undefined) {
      throw new PluginSnapshotDependencyError(filename);
    }
    const parsed: unknown = JSON5.parse(text);
    if (!object(parsed)) {
      throw new Error(`Invalid TypeScript configuration at ${filename}`);
    }
    const inherited: Configuration = {};
    for (const base of Array.isArray(parsed.extends) ? parsed.extends : [parsed.extends]) {
      if (typeof base !== "string") {
        continue;
      }
      // Config extends is a captured input, including nonstandard .json names.
      const selected = configurationPath(canonical, base);
      if (!selected) {
        throw new PluginSnapshotDependencyError(base);
      }
      Object.assign(inherited, configAt(selected, new Set(seen)));
    }
    const compiler = object(parsed.compilerOptions) ? parsed.compilerOptions : {};
    const baseUrl =
      typeof compiler.baseUrl === "string"
        ? path.resolve(
            path.dirname(canonical),
            compiler.baseUrl.replaceAll("${configDir}", path.dirname(canonical)),
          )
        : inherited.baseUrl;
    let paths = inherited.paths;
    let pathsOrigin = inherited.pathsOrigin;
    if (object(compiler.paths)) {
      paths = {};
      pathsOrigin = path.dirname(canonical);
      for (const [key, value] of Object.entries(compiler.paths)) {
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
          paths[key] = [...value];
        }
      }
    }
    const value = { baseUrl, paths, pathsOrigin };
    configurations.set(canonical, value);
    return value;
  };
  const tsconfigFor = (importer: string) => {
    if (!options.tsconfigPaths) {
      return undefined;
    }
    if (typeof options.tsconfigPaths === "string") {
      return configAt(options.tsconfigPaths);
    }
    const selected = findAncestor(path.dirname(importer), (directory) => {
      const filename = path.join(directory, "tsconfig.json");
      return source.configuration.has(canonicalPath(filename)) ? filename : undefined;
    });
    return selected ? configAt(selected) : undefined;
  };
  const resolveExternal = (
    request: string,
    importer: string,
    conditions: readonly string[],
  ): PluginSnapshotResolvedModule | undefined => {
    const hosted = options.resolveHostModule?.(request, importer, conditions);
    if (hosted) {
      return {
        filename: hosted,
        canonical: hosted,
        url: hosted.startsWith("file:") ? hosted : pathToFileURL(hosted).href,
        external: true,
      };
    }
    if (isBuiltin(request)) {
      const builtin = request.startsWith("node:") ? request : `node:${request}`;
      return { filename: builtin, canonical: builtin, url: builtin, external: true };
    }
    return undefined;
  };
  const resolve = (
    from: string,
    request: string,
    conditions: readonly string[],
    native = false,
    depth = 0,
    paths?: readonly string[],
  ): PluginSnapshotResolvedModule => {
    const importer = modulePath(from);
    if (depth > 64) {
      throw new PluginSnapshotDependencyError(request);
    }
    const external = resolveExternal(request, importer, conditions);
    if (external) {
      return external;
    }
    const importing = !conditions.includes("require");
    const nativeOrder = importing
      ? undefined
      : runtime === "node"
        ? nodeExtensions
        : native
          ? bunExtensions
          : undefined;
    let specifier = request;
    const alias = aliases.find((key) => request === key || request.startsWith(`${key}/`));
    if (alias) {
      specifier = options.alias![alias]! + request.slice(alias.length);
      const aliasedExternal = resolveExternal(specifier, importer, conditions);
      if (aliasedExternal) {
        return aliasedExternal;
      }
    }
    if (specifier.startsWith(".") || specifier.startsWith("file:") || path.isAbsolute(specifier)) {
      if (paths && specifier.startsWith(".")) {
        for (const directory of paths) {
          try {
            return resolve(
              path.join(path.resolve(directory), "__resolve__.cjs"),
              request,
              conditions,
              native,
              depth + 1,
            );
          } catch (error) {
            if (!(error instanceof PluginSnapshotDependencyError)) {
              throw error;
            }
          }
        }
        throw new PluginSnapshotDependencyError(request);
      }
      const url =
        specifier.startsWith("file:") || importing
          ? new URL(specifier, pathToFileURL(importer))
          : pathToFileURL(path.resolve(path.dirname(importer), specifier));
      if (url.protocol !== "file:") {
        throw new PluginSnapshotDependencyError(request);
      }
      const filename = fileURLToPath(url);
      const suffix = importing ? url.search + url.hash : "";
      const selected =
        native && importing ? file(filename, suffix) : legacyResolve(filename, suffix, nativeOrder);
      if (!selected) {
        throw new PluginSnapshotDependencyError(request);
      }
      return selected;
    }
    if (URL.canParse(specifier)) {
      throw new PluginSnapshotDependencyError(request);
    }
    const selectMap = (map: unknown, directory: string, subpath: string, internal: boolean) => {
      let resolvedPackage: PluginSnapshotResolvedModule | undefined;
      const url = selectPluginSnapshotPackageMap(map, {
        packageDir: directory,
        request: subpath,
        conditions: new Set(conditions),
        internal,
        runtime,
        resolvePackage: (target) => {
          resolvedPackage = resolve(
            path.join(directory, "package.json"),
            target,
            conditions,
            native,
            depth + 1,
          );
          return new URL(resolvedPackage.url);
        },
      });
      return (
        resolvedPackage ?? asModule(fileURLToPath(url), importing ? url.search + url.hash : "")
      );
    };
    const ownScope = scope(importer);
    if (specifier.startsWith("#")) {
      return selectMap(
        ownScope?.value?.imports,
        ownScope?.directory ?? path.dirname(importer),
        specifier,
        true,
      );
    }
    if (!native || !importing) {
      const configuration = tsconfigFor(importer);
      const mappings = configuration?.paths;
      if (mappings) {
        const keys = Object.keys(mappings).toSorted((a, b) => {
          if (a === specifier) {
            return -1;
          }
          if (b === specifier) {
            return 1;
          }
          return b.split("*")[0]!.length - a.split("*")[0]!.length;
        });
        for (const key of keys) {
          const [prefix, suffix] = key.split("*");
          const middle =
            suffix === undefined
              ? ""
              : specifier.slice(prefix!.length, specifier.length - suffix.length);
          if (
            suffix === undefined
              ? key !== specifier
              : !specifier.startsWith(prefix!) || !specifier.endsWith(suffix)
          ) {
            continue;
          }
          for (const target of mappings[key]!) {
            const resolvedTarget = path.resolve(
              configuration?.baseUrl ?? configuration?.pathsOrigin ?? path.dirname(importer),
              target.replaceAll("*", middle),
            );
            const selected = legacyResolve(resolvedTarget, "", nativeOrder);
            if (selected) {
              return selected;
            }
          }
          break;
        }
      }
      if (configuration?.baseUrl) {
        const target = path.resolve(configuration.baseUrl, specifier);
        const selected = legacyResolve(target, "", nativeOrder);
        if (selected) {
          return selected;
        }
      }
    }
    const parts = specifier.split("/");
    const packageName = parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (
      !packageName ||
      packageName === "@" ||
      packageName.startsWith(".") ||
      specifier.includes("\\") ||
      specifier.includes("%")
    ) {
      throw new PluginSnapshotDependencyError(request);
    }
    const subpath = specifier.slice(packageName.length);
    let packageDir =
      ownScope?.value?.name === packageName && ownScope.value.exports != null
        ? ownScope.directory
        : undefined;
    for (const start of paths ?? [path.dirname(modulePath(importer))]) {
      if (packageDir) {
        break;
      }
      packageDir = findAncestor(path.resolve(start), (directory) => {
        if (pathKey(path.basename(directory)) === "node_modules") {
          return undefined;
        }
        const candidate = path.join(directory, "node_modules", packageName);
        return entry(candidate)?.kind === "directory" ? candidate : undefined;
      });
    }
    if (!packageDir) {
      throw new PluginSnapshotDependencyError(request);
    }
    const metadata = packageAt(packageDir);
    if (metadata?.exports != null) {
      return selectMap(metadata.exports, packageDir, subpath ? `.${subpath}` : ".", false);
    }
    const target = path.join(packageDir, subpath);
    const selected =
      !subpath || !native || !importing
        ? // The cold capture owner resolves legacy packages through Node's package resolver on both runtimes.
          legacyResolve(target, "", nodeExtensions)
        : file(target);
    if (!selected) {
      throw new PluginSnapshotDependencyError(request);
    }
    return selected;
  };
  return {
    resolve: (
      importer: string,
      request: string,
      conditions: readonly string[],
      native = false,
      paths?: readonly string[],
    ) => resolve(importer, request, conditions, native, 0, paths),
    canonicalPath,
    modulePath,
    configurationPath,
    syntaxPlugins(filename: string): Array<"typescript" | "jsx"> {
      return [
        ...(/\.[cm]?tsx?$/.test(filename) ? ["typescript" as const] : []),
        ...(/\.[cm]?[jt]sx$/.test(filename) ? ["jsx" as const] : []),
      ];
    },
    isAmbiguous(filename: string) {
      const type = scope(filename)?.value?.type;
      return /\.[jt]sx?$/.test(filename) && type !== "module" && type !== "commonjs";
    },
    format(filename: string): "module" | "commonjs" | "json" | "addon" {
      if (filename.endsWith(".json")) {
        return "json";
      }
      if (filename.endsWith(".node")) {
        return "addon";
      }
      if (/\.[cm][jt]s$/.test(filename)) {
        return /\.m[jt]s$/.test(filename) ? "module" : "commonjs";
      }
      return scope(filename)?.value?.type === "module" ? "module" : "commonjs";
    },
  };
}
