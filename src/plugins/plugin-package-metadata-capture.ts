import fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isPathInside } from "../infra/path-guards.js";

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
}): void {
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

export function capturePluginPackageMetadata(
  root: string,
  destination: string,
  copy: (source: string, target: string) => void,
): void {
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
