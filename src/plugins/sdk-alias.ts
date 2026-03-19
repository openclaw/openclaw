import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

type PluginSdkAliasCandidateKind = "dist" | "src";

export type LoaderModuleResolveParams = {
  modulePath?: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
};

function resolveLoaderModulePath(params: LoaderModuleResolveParams = {}): string {
  return params.modulePath ?? fileURLToPath(params.moduleUrl ?? import.meta.url);
}

export function resolveLoaderPackageRoot(
  params: LoaderModuleResolveParams & { modulePath: string },
): string | null {
  const cwd = params.cwd ?? path.dirname(params.modulePath);
  const fromModulePath = resolveOpenClawPackageRootSync({ cwd });
  if (fromModulePath) {
    return fromModulePath;
  }
  const argv1 = params.argv1 ?? process.argv[1];
  const moduleUrl = params.moduleUrl ?? (params.modulePath ? undefined : import.meta.url);
  return resolveOpenClawPackageRootSync({
    cwd,
    ...(argv1 ? { argv1 } : {}),
    ...(moduleUrl ? { moduleUrl } : {}),
  });
}

export function resolvePluginSdkAliasCandidateOrder(params: {
  modulePath: string;
  isProduction: boolean;
}): PluginSdkAliasCandidateKind[] {
  const normalizedModulePath = params.modulePath.replace(/\\/g, "/");
  const isDistRuntime = normalizedModulePath.includes("/dist/");
  return isDistRuntime || params.isProduction ? ["dist", "src"] : ["src", "dist"];
}

export function listPluginSdkAliasCandidates(params: {
  srcFile: string;
  distFile: string;
  modulePath: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
}) {
  const orderedKinds = resolvePluginSdkAliasCandidateOrder({
    modulePath: params.modulePath,
    isProduction: process.env.NODE_ENV === "production",
  });
  const packageRoot = resolveLoaderPackageRoot(params);
  if (packageRoot) {
    const candidateMap = {
      src: path.join(packageRoot, "src", "plugin-sdk", params.srcFile),
      dist: path.join(packageRoot, "dist", "plugin-sdk", params.distFile),
    } as const;
    return orderedKinds.map((kind) => candidateMap[kind]);
  }
  let cursor = path.dirname(params.modulePath);
  const candidates: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const candidateMap = {
      src: path.join(cursor, "src", "plugin-sdk", params.srcFile),
      dist: path.join(cursor, "dist", "plugin-sdk", params.distFile),
    } as const;
    for (const kind of orderedKinds) {
      candidates.push(candidateMap[kind]);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return candidates;
}

export function resolvePluginSdkAliasFile(params: {
  srcFile: string;
  distFile: string;
  modulePath?: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
}): string | null {
  try {
    const modulePath = resolveLoaderModulePath(params);
    for (const candidate of listPluginSdkAliasCandidates({
      srcFile: params.srcFile,
      distFile: params.distFile,
      modulePath,
      argv1: params.argv1,
      cwd: params.cwd,
      moduleUrl: params.moduleUrl,
    })) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

const cachedPluginSdkExportedSubpaths = new Map<string, string[]>();

export function listPluginSdkExportedSubpaths(params: { modulePath?: string } = {}): string[] {
  const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
  const packageRoot = resolveOpenClawPackageRootSync({
    cwd: path.dirname(modulePath),
  });
  if (!packageRoot) {
    return [];
  }
  const cached = cachedPluginSdkExportedSubpaths.get(packageRoot);
  if (cached) {
    return cached;
  }
  try {
    const pkgRaw = fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw) as {
      exports?: Record<string, unknown>;
    };
    const subpaths = Object.keys(pkg.exports ?? {})
      .filter((key) => key.startsWith("./plugin-sdk/"))
      .map((key) => key.slice("./plugin-sdk/".length))
      .filter((subpath) => Boolean(subpath) && !subpath.includes("/"))
      .toSorted();
    cachedPluginSdkExportedSubpaths.set(packageRoot, subpaths);
    return subpaths;
  } catch {
    return [];
  }
}

export function resolvePluginSdkScopedAliasMap(
  params: { modulePath?: string } = {},
): Record<string, string> {
  const aliasMap: Record<string, string> = {};
  for (const subpath of listPluginSdkExportedSubpaths(params)) {
    const resolved = resolvePluginSdkAliasFile({
      srcFile: `${subpath}.ts`,
      distFile: `${subpath}.js`,
      modulePath: params.modulePath,
    });
    if (resolved) {
      aliasMap[`openclaw/plugin-sdk/${subpath}`] = resolved;
    }
  }
  return aliasMap;
}

export function buildPluginLoaderJitiOptions(aliasMap: Record<string, string>) {
  return {
    interopDefault: true,
    // Prefer Node's native sync ESM loader for built dist/*.js modules so
    // bundled plugins and plugin-sdk subpaths stay on the canonical module graph.
    tryNative: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
    ...(Object.keys(aliasMap).length > 0
      ? {
          alias: aliasMap,
        }
      : {}),
  };
}

export function shouldPreferNativeJiti(modulePath: string): boolean {
  switch (path.extname(modulePath).toLowerCase()) {
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".json":
      return true;
    default:
      return false;
  }
}
