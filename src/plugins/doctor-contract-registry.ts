import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { LegacyConfigRule } from "../config/legacy.shared.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { resolvePluginCacheInputs } from "./roots.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  shouldPreferNativeJiti,
} from "./sdk-alias.js";

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type PluginDoctorContractModule = {
  legacyConfigRules?: unknown;
};

type PluginDoctorContractEntry = {
  pluginId: string;
  rules: LegacyConfigRule[];
};

const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();
const doctorContractCache = new Map<string, PluginDoctorContractEntry[]>();

function getJiti(modulePath: string) {
  const aliasMap = buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url);
  const cacheKey = JSON.stringify({
    tryNative: shouldPreferNativeJiti(modulePath),
    aliasMap: Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
  });
  const cached = jitiLoaders.get(cacheKey);
  if (cached) {
    return cached;
  }
  const loader = createJiti(modulePath, buildPluginLoaderJitiOptions(aliasMap));
  jitiLoaders.set(cacheKey, loader);
  return loader;
}

function buildDoctorContractCacheKey(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return JSON.stringify({
    roots,
    loadPaths,
  });
}

function resolveContractApiPath(rootDir: string): string | null {
  const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT
    ? CONTRACT_API_EXTENSIONS
    : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
  for (const extension of orderedExtensions) {
    const candidate = path.join(rootDir, `contract-api${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function coerceLegacyConfigRules(value: unknown): LegacyConfigRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const candidate = entry as { path?: unknown; message?: unknown };
    return Array.isArray(candidate.path) && typeof candidate.message === "string";
  }) as LegacyConfigRule[];
}

function resolvePluginDoctorContracts(params?: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginDoctorContractEntry[] {
  const env = params?.env ?? process.env;
  const cacheKey = buildDoctorContractCacheKey({
    workspaceDir: params?.workspaceDir,
    env,
  });
  const cached = doctorContractCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const discovery = discoverOpenClawPlugins({
    workspaceDir: params?.workspaceDir,
    env,
    cache: true,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    workspaceDir: params?.workspaceDir,
    env,
    cache: true,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });

  const entries: PluginDoctorContractEntry[] = [];
  for (const record of manifestRegistry.plugins) {
    const contractSource = resolveContractApiPath(record.rootDir);
    if (!contractSource) {
      continue;
    }
    let mod: PluginDoctorContractModule;
    try {
      mod = getJiti(contractSource)(contractSource) as PluginDoctorContractModule;
    } catch {
      continue;
    }
    const rules = coerceLegacyConfigRules(
      (mod as { default?: PluginDoctorContractModule }).default?.legacyConfigRules ??
        mod.legacyConfigRules,
    );
    if (rules.length === 0) {
      continue;
    }
    entries.push({
      pluginId: record.id,
      rules,
    });
  }

  doctorContractCache.set(cacheKey, entries);
  return entries;
}

export function clearPluginDoctorContractRegistryCache(): void {
  doctorContractCache.clear();
}

export function listPluginDoctorLegacyConfigRules(params?: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): LegacyConfigRule[] {
  return resolvePluginDoctorContracts(params).flatMap((entry) => entry.rules);
}
