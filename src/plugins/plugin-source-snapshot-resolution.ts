import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSON5 from "json5";
import { isPathInside } from "../infra/path-guards.js";
import { PluginSnapshotDependencyError } from "./plugin-snapshot-dependency-error.js";
import { selectPluginSnapshotPackageMap } from "./plugin-source-snapshot-package-map.js";

type Entry = { kind: "file" | "directory" | "link" };
type Configuration = { baseUrl?: string; paths?: Record<string, string[]>; pathsOrigin?: string };
type Package = {
  name?: string;
  main?: string;
  type?: string;
  exports?: unknown;
  imports?: unknown;
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

/** Resolve solely from sealed membership and metadata. Never consult live package/config files. */
export function createPluginSnapshotResolver(
  source: PluginSnapshotResolutionSource,
  options: ResolutionOptions = {},
) {
  const packages = new Map<string, Package>();
  const configurations = new Map<string, Configuration>();
  const runtime = options.runtime ?? (process.versions.bun ? "bun" : "node");
  const extensions = options.extensions ?? [
    ".js",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".json",
    ".node",
  ];
  const aliases = Object.keys(options.alias ?? {}).toSorted((a, b) => b.length - a.length);
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
  const payloadPath = (filename: string) => {
    let selected = path.resolve(filename);
    const alias = findAncestor(selected, (parent) =>
      Object.hasOwn(source.sourceAliases, parent) ? parent : undefined,
    );
    if (alias) {
      selected = path.join(source.sourceAliases[alias]!, path.relative(alias, selected));
    }
    return selected;
  };
  const canonicalPath = (filename: string) => {
    let selected = payloadPath(filename);
    const seen = new Set<string>();
    while (!seen.has(selected)) {
      seen.add(selected);
      const link = findAncestor(selected, (parent) =>
        source.sourceLinks.has(parent) ? parent : undefined,
      );
      if (!link) {
        return selected;
      }
      selected = path.join(source.sourceLinks.get(link)!, path.relative(link, selected));
    }
    throw new PluginSnapshotDependencyError(filename);
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
        ...("exports" in parsed ? { exports: parsed.exports } : {}),
        ...("imports" in parsed ? { imports: parsed.imports } : {}),
      };
      packages.set(canonical, value);
    }
    return value;
  };
  const scope = (filename: string) =>
    findAncestor(path.dirname(filename), (directory) => {
      if (path.basename(directory) === "node_modules") {
        return { directory, value: undefined };
      }
      const value = packageAt(directory);
      return value ? { directory, value } : undefined;
    });
  const asModule = (input: string, suffix = ""): PluginSnapshotResolvedModule => {
    const filename = payloadPath(input);
    const canonical = canonicalPath(filename);
    if (entry(canonical)?.kind !== "file" || !isPathInside(source.payloadRoot, canonical)) {
      throw new PluginSnapshotDependencyError(filename);
    }
    return { filename, canonical, url: pathToFileURL(canonical).href + suffix };
  };
  const file = (filename: string, suffix = "") =>
    entry(filename)?.kind === "file" ? asModule(filename, suffix) : undefined;
  const legacyFile = (filename: string, suffix = "") => {
    const direct = file(filename, suffix);
    if (direct) {
      return direct;
    }
    for (const extension of extensions) {
      const candidate = file(filename + extension, suffix);
      if (candidate) {
        return candidate;
      }
    }
    // Jiti tries appended extensions before a TypeScript sibling of a missing JS path.
    if (/\.[cm]?jsx?$/.test(filename)) {
      return file(filename.replace(/\.([cm]?)j(sx?)$/, ".$1t$2"), suffix);
    }
    return undefined;
  };
  const legacyDirectory = (directory: string, suffix = "") => {
    if (entry(directory)?.kind !== "directory") {
      return undefined;
    }
    const main = packageAt(directory)?.main;
    if (main) {
      const target = path.resolve(directory, main);
      const selected = legacyFile(target, suffix) ?? legacyFile(path.join(target, "index"), suffix);
      if (selected) {
        return selected;
      }
    }
    return legacyFile(path.join(directory, "index"), suffix);
  };
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
      const target = path.resolve(path.dirname(canonical), base);
      const selected = source.configuration.has(target) ? target : `${target}.json`;
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
  const resolve = (
    importer: string,
    request: string,
    conditions: readonly string[],
    native = false,
    depth = 0,
  ): PluginSnapshotResolvedModule => {
    if (depth > 64) {
      throw new PluginSnapshotDependencyError(request);
    }
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
    const importing = !conditions.includes("require");
    let specifier = request;
    const alias = aliases.find((key) => request === key || request.startsWith(`${key}/`));
    if (alias) {
      specifier = options.alias![alias]! + request.slice(alias.length);
    }
    if (specifier.startsWith(".") || specifier.startsWith("file:") || path.isAbsolute(specifier)) {
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
        native && importing
          ? file(filename, suffix)
          : (legacyFile(filename, suffix) ?? legacyDirectory(filename, suffix));
      if (!selected) {
        throw new PluginSnapshotDependencyError(request);
      }
      return selected;
    }
    if (URL.canParse(specifier)) {
      throw new PluginSnapshotDependencyError(request);
    }
    const selectMap = (map: unknown, directory: string, subpath: string, internal: boolean) => {
      const url = selectPluginSnapshotPackageMap(map, {
        packageDir: directory,
        request: subpath,
        conditions: new Set(conditions),
        internal,
        runtime,
        resolvePackage: (target) =>
          new URL(
            resolve(path.join(directory, "package.json"), target, conditions, native, depth + 1)
              .url,
          ),
      });
      if (url.protocol !== "file:") {
        return { filename: url.href, canonical: url.href, url: url.href, external: true as const };
      }
      return asModule(fileURLToPath(url), importing ? url.search + url.hash : "");
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
    if (!native) {
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
            const selected = legacyFile(resolvedTarget) ?? legacyDirectory(resolvedTarget);
            if (selected) {
              return selected;
            }
          }
          break;
        }
      }
      if (configuration?.baseUrl) {
        const target = path.resolve(configuration.baseUrl, specifier);
        const selected = legacyFile(target) ?? legacyDirectory(target);
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
    const packageDir =
      ownScope?.value?.name === packageName && ownScope.value.exports != null
        ? ownScope.directory
        : findAncestor(path.dirname(canonicalPath(importer)), (directory) => {
            if (path.basename(directory) === "node_modules") {
              return undefined;
            }
            const candidate = path.join(directory, "node_modules", packageName);
            return entry(candidate)?.kind === "directory" ? candidate : undefined;
          });
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
        ? (legacyFile(target) ?? legacyDirectory(target))
        : file(target);
    if (!selected) {
      throw new PluginSnapshotDependencyError(request);
    }
    return selected;
  };
  return {
    resolve,
    canonicalPath,
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
