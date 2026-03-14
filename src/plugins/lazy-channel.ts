import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

function resolvePluginSdkAliasCandidateOrder(params: {
  modulePath: string;
  isProduction: boolean;
}): Array<"dist" | "src"> {
  const normalizedModulePath = params.modulePath.replace(/\\/g, "/");
  const isDistRuntime = normalizedModulePath.includes("/dist/");
  return isDistRuntime || params.isProduction ? ["dist", "src"] : ["src", "dist"];
}

function listPluginSdkAliasCandidates(params: {
  srcFile: string;
  distFile: string;
  modulePath: string;
}): string[] {
  const orderedKinds = resolvePluginSdkAliasCandidateOrder({
    modulePath: params.modulePath,
    isProduction: process.env.NODE_ENV === "production",
  });
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

function resolvePluginSdkAliasFile(params: {
  srcFile: string;
  distFile: string;
  modulePath: string;
}): string | null {
  for (const candidate of listPluginSdkAliasCandidates(params)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const cachedPluginSdkExportedSubpaths = new Map<string, string[]>();

function listPluginSdkExportedSubpaths(modulePath: string): string[] {
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

function resolvePluginSdkAliasMap(modulePath: string): Record<string, string> {
  const aliasMap: Record<string, string> = {};
  const pluginSdkRoot = resolvePluginSdkAliasFile({
    srcFile: "root-alias.cjs",
    distFile: "root-alias.cjs",
    modulePath,
  });
  if (pluginSdkRoot) {
    aliasMap["openclaw/plugin-sdk"] = pluginSdkRoot;
  }
  for (const subpath of listPluginSdkExportedSubpaths(modulePath)) {
    const resolved = resolvePluginSdkAliasFile({
      srcFile: `${subpath}.ts`,
      distFile: `${subpath}.js`,
      modulePath,
    });
    if (resolved) {
      aliasMap[`openclaw/plugin-sdk/${subpath}`] = resolved;
    }
  }
  return aliasMap;
}

const jitiCache = new Map<string, ReturnType<typeof createJiti>>();

function getLazyLoader(importerUrl: string): ReturnType<typeof createJiti> {
  const cached = jitiCache.get(importerUrl);
  if (cached) {
    return cached;
  }
  const modulePath = fileURLToPath(importerUrl);
  const aliasMap = resolvePluginSdkAliasMap(modulePath);
  const loader = createJiti(importerUrl, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
    ...(Object.keys(aliasMap).length > 0 ? { alias: aliasMap } : {}),
  });
  jitiCache.set(importerUrl, loader);
  return loader;
}

type LazyModuleObjectParams<T extends object> = {
  importerUrl: string;
  modulePath: string;
  resolve: (mod: Record<string, unknown>) => T;
  stub?: Partial<T>;
};

function createLazyModuleObject<T extends object>(params: LazyModuleObjectParams<T>): T {
  let loaded: T | null = null;
  const load = (): T => {
    loaded ??= params.resolve(
      getLazyLoader(params.importerUrl)(params.modulePath) as Record<string, unknown>,
    );
    return loaded;
  };
  const target = { ...params.stub } as T;
  return new Proxy(target, {
    get(_target, prop, receiver) {
      if (params.stub && Reflect.has(params.stub, prop)) {
        return Reflect.get(params.stub, prop, receiver);
      }
      return Reflect.get(load() as object, prop, receiver);
    },
    has(_target, prop) {
      if (params.stub && Reflect.has(params.stub, prop)) {
        return true;
      }
      return Reflect.has(load() as object, prop);
    },
    ownKeys() {
      return Reflect.ownKeys(load() as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (params.stub && Reflect.has(params.stub, prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: Reflect.get(params.stub, prop),
        };
      }
      return Reflect.getOwnPropertyDescriptor(load() as object, prop);
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(load() as object, prop, value, receiver);
    },
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(load() as object, prop);
    },
    defineProperty(_target, prop, attributes) {
      return Reflect.defineProperty(load() as object, prop, attributes);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(load() as object);
    },
  });
}

export function createLazyChannelPlugin<T extends { id: string }>(params: {
  importerUrl: string;
  modulePath: string;
  exportName: string;
  pluginId: string;
}): T {
  return createLazyModuleObject<T>({
    importerUrl: params.importerUrl,
    modulePath: params.modulePath,
    resolve: (mod) => mod[params.exportName] as T,
    stub: { id: params.pluginId, meta: {}, gatewayMethods: [] } as Partial<T>,
  });
}

export function createLazyChannelDock<T extends object>(params: {
  importerUrl: string;
  modulePath: string;
  exportName: string;
}): T {
  return createLazyModuleObject<T>({
    importerUrl: params.importerUrl,
    modulePath: params.modulePath,
    resolve: (mod) => mod[params.exportName] as T,
  });
}

export function createLazyChannelFactoryResult<T extends { id: string }>(params: {
  importerUrl: string;
  modulePath: string;
  exportName: string;
  pluginId: string;
}): T {
  return createLazyModuleObject<T>({
    importerUrl: params.importerUrl,
    modulePath: params.modulePath,
    resolve: (mod) => (mod[params.exportName] as () => T)(),
    stub: { id: params.pluginId } as Partial<T>,
  });
}

export function loadLazyModuleExport<T>(params: {
  importerUrl: string;
  modulePath: string;
  exportName: string;
}): T {
  return getLazyLoader(params.importerUrl)(params.modulePath)[params.exportName] as T;
}
