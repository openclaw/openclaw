import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  shouldPreferNativeJiti,
} from "../sdk-alias.js";

const RUNTIME_MODULE_EXTENSIONS = [".js", ".ts", ".mjs", ".mts", ".cjs", ".cts"] as const;
const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();

function resolveSiblingRuntimeModulePath(moduleUrl: string, relativeBase: string): string {
  const baseDir = path.dirname(fileURLToPath(moduleUrl));
  for (const ext of RUNTIME_MODULE_EXTENSIONS) {
    const candidate = path.resolve(baseDir, `${relativeBase}${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve runtime module ${relativeBase} from ${moduleUrl}`);
}

function getJiti(modulePath: string, moduleUrl: string) {
  const tryNative = shouldPreferNativeJiti(modulePath);
  const aliasMap = buildPluginLoaderAliasMap(modulePath, process.argv[1], moduleUrl);
  const cacheKey = JSON.stringify({
    tryNative,
    aliasMap: Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
    moduleUrl,
  });
  const cached = jitiLoaders.get(cacheKey);
  if (cached) {
    return cached;
  }
  const loader = createJiti(moduleUrl, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  jitiLoaders.set(cacheKey, loader);
  return loader;
}

export function loadSiblingRuntimeModuleSync<T>(params: {
  moduleUrl: string;
  relativeBase: string;
}): T {
  const modulePath = resolveSiblingRuntimeModulePath(params.moduleUrl, params.relativeBase);
  return getJiti(modulePath, params.moduleUrl)(modulePath) as T;
}
