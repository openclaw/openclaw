import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { loadConfig } from "../../config/config.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import {
  buildPluginLoaderJitiOptions,
  resolvePluginSdkAliasFile,
  resolvePluginSdkScopedAliasMap,
  shouldPreferNativeJiti,
} from "../sdk-alias.js";

const MATRIX_PLUGIN_ID = "matrix";

type MatrixModule = typeof import("../../../extensions/matrix/runtime-api.js");

type MatrixPluginRecord = {
  rootDir?: string;
  source: string;
};

let cachedModulePath: string | null = null;
let cachedModule: MatrixModule | null = null;

const jitiLoaders = new Map<boolean, ReturnType<typeof createJiti>>();

function readConfigSafely() {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

function resolveMatrixPluginRecord(): MatrixPluginRecord | null {
  const manifestRegistry = loadPluginManifestRegistry({
    config: readConfigSafely(),
    cache: true,
  });
  const record = manifestRegistry.plugins.find((plugin) => plugin.id === MATRIX_PLUGIN_ID);
  if (!record?.source) {
    return null;
  }
  return {
    rootDir: record.rootDir,
    source: record.source,
  };
}

function resolveMatrixRuntimeModulePath(record: MatrixPluginRecord): string | null {
  const candidates = [
    path.join(path.dirname(record.source), "runtime-api.js"),
    path.join(path.dirname(record.source), "runtime-api.ts"),
    ...(record.rootDir
      ? [path.join(record.rootDir, "runtime-api.js"), path.join(record.rootDir, "runtime-api.ts")]
      : []),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getJiti(modulePath: string) {
  const tryNative = shouldPreferNativeJiti(modulePath);
  const cached = jitiLoaders.get(tryNative);
  if (cached) {
    return cached;
  }
  const pluginSdkAlias = resolvePluginSdkAliasFile({
    srcFile: "root-alias.cjs",
    distFile: "root-alias.cjs",
    modulePath,
  });
  const aliasMap = {
    ...(pluginSdkAlias ? { "openclaw/plugin-sdk": pluginSdkAlias } : {}),
    ...resolvePluginSdkScopedAliasMap({ modulePath }),
  };
  const loader = createJiti(import.meta.url, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  jitiLoaders.set(tryNative, loader);
  return loader;
}

function loadWithJiti<TModule>(modulePath: string): TModule {
  return getJiti(modulePath)(modulePath) as TModule;
}

function loadMatrixModule(): MatrixModule | null {
  const record = resolveMatrixPluginRecord();
  if (!record) {
    return null;
  }
  const modulePath = resolveMatrixRuntimeModulePath(record);
  if (!modulePath) {
    return null;
  }
  if (cachedModule && cachedModulePath === modulePath) {
    return cachedModule;
  }
  const loaded = loadWithJiti<MatrixModule>(modulePath);
  cachedModulePath = modulePath;
  cachedModule = loaded;
  return loaded;
}

export function setMatrixThreadBindingIdleTimeoutBySessionKey(
  ...args: Parameters<MatrixModule["setMatrixThreadBindingIdleTimeoutBySessionKey"]>
): ReturnType<MatrixModule["setMatrixThreadBindingIdleTimeoutBySessionKey"]> {
  const fn = loadMatrixModule()?.setMatrixThreadBindingIdleTimeoutBySessionKey;
  if (typeof fn !== "function") {
    return [];
  }
  return fn(...args);
}

export function setMatrixThreadBindingMaxAgeBySessionKey(
  ...args: Parameters<MatrixModule["setMatrixThreadBindingMaxAgeBySessionKey"]>
): ReturnType<MatrixModule["setMatrixThreadBindingMaxAgeBySessionKey"]> {
  const fn = loadMatrixModule()?.setMatrixThreadBindingMaxAgeBySessionKey;
  if (typeof fn !== "function") {
    return [];
  }
  return fn(...args);
}
