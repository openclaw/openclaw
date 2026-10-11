/** Loads channel secret contract APIs from bundled and external plugin artifacts. */
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { shouldRejectHardlinkedPluginFiles } from "../plugins/hardlink-policy.js";
import { createJiti } from "../plugins/jiti-factory.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { pluginCacheExistsSync } from "../plugins/plugin-cache-files.js";
import {
  createPluginCache,
  getPluginCache,
  getPluginCacheRoot,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { capturePluginGenerationArtifact } from "../plugins/plugin-generation-artifact.js";
import {
  createUncachedPluginModuleLoader,
  getCachedPluginModuleLoader,
} from "../plugins/plugin-module-loader-cache.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { isPluginSourceEntry } from "../plugins/plugin-source-file.js";
import { visitPluginSourceReferences } from "../plugins/plugin-source-references.js";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../plugins/public-surface-loader.js";
import { preparePluginLoaderAliases } from "../plugins/sdk-alias.js";
import { loadOfficialExternalChannelSecretContractApi } from "./official-external-channel-secret-contract.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

type BundledChannelSecretContractApi = {
  collectRuntimeConfigAssignments?: (params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
  }) => void;
  secretTargetRegistryEntries?: readonly SecretTargetRegistryEntry[];
};

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

function loadBundledChannelSecretContractApi(
  channelId: string,
): BundledChannelSecretContractApi | undefined {
  return (
    loadBundledPluginPublicArtifactModuleFromCandidatesSync<BundledChannelSecretContractApi>({
      dirName: channelId,
      artifactCandidates: ["secret-contract-api.js"],
    }) ?? undefined
  );
}

function orderedContractApiExtensions(): readonly string[] {
  return RUNNING_FROM_BUILT_ARTIFACT
    ? CONTRACT_API_EXTENSIONS
    : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
}

function resolvePluginContractApiPath(rootDir: string): string | null {
  const artifacts = getPluginCacheRoot(rootDir).artifacts;
  const key = "channel-secret-contract";
  const cached = artifacts.get(key);
  if (cached !== undefined) {
    return cached?.modulePath ?? null;
  }
  // Compiled npm-published plugins place their public artifacts under <rootDir>/dist/
  // (per package.json `openclaw.runtimeExtensions`), while flat-layout plugins keep
  // them at <rootDir>/. Search both, preferring dist/ when running from built openclaw
  // artifacts and rootDir/ when running from source.
  const searchDirs = RUNNING_FROM_BUILT_ARTIFACT
    ? [path.join(rootDir, "dist"), rootDir]
    : [rootDir, path.join(rootDir, "dist")];
  for (const basename of ["secret-contract-api", "contract-api"]) {
    for (const dir of searchDirs) {
      for (const extension of orderedContractApiExtensions()) {
        const candidate = path.join(dir, `${basename}${extension}`);
        if (pluginCacheExistsSync(candidate)) {
          artifacts.set(key, { modulePath: candidate, boundaryRoot: rootDir });
          return candidate;
        }
      }
    }
  }
  artifacts.set(key, null);
  return null;
}

const CONTRACT_CAPTURE_MAX_ENTRIES = 4_096;
const CONTRACT_CAPTURE_MAX_TOTAL_ENTRIES = 65_536;
const CONTRACT_CAPTURE_MAX_FILES = 1_024;
const CONTRACT_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
const CONTRACT_CAPTURE_EXTENSIONS = new Set([...CONTRACT_API_EXTENSIONS, ".json", ".node"]);

type ChannelContractTsconfig = {
  extends?: unknown;
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
};

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function realpathExistingAncestor(candidate: string): string {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return fs.realpathSync(current);
}

export function capturedTsconfigIsSafe(
  configPath: string,
  rootRealPath: string,
  seen = new Set<string>(),
): boolean {
  const configRealPath = fs.realpathSync(configPath);
  if (!isPathWithinRoot(rootRealPath, configRealPath) || seen.has(configRealPath)) {
    return false;
  }
  seen.add(configRealPath);
  let config: ChannelContractTsconfig;
  try {
    // SAFETY: every consumed tsconfig field is validated below before it affects module loading.
    config = JSON5.parse(fs.readFileSync(configRealPath, "utf8")) as ChannelContractTsconfig;
  } catch {
    return false;
  }
  if (config.extends !== undefined) {
    if (typeof config.extends !== "string" || !config.extends.startsWith(".")) {
      return false;
    }
    const unresolved = path.resolve(path.dirname(configRealPath), config.extends);
    const parentConfig = fs.existsSync(unresolved) ? unresolved : `${unresolved}.json`;
    if (!fs.existsSync(parentConfig) || !capturedTsconfigIsSafe(parentConfig, rootRealPath, seen)) {
      return false;
    }
  }
  const compilerOptions = config.compilerOptions;
  if (!compilerOptions) {
    return true;
  }
  const baseUrl = compilerOptions.baseUrl ?? ".";
  if (typeof baseUrl !== "string" || path.isAbsolute(baseUrl)) {
    return false;
  }
  const mappingRoot = path.resolve(path.dirname(configRealPath), baseUrl);
  if (
    !isPathWithinRoot(rootRealPath, mappingRoot) ||
    !isPathWithinRoot(rootRealPath, realpathExistingAncestor(mappingRoot))
  ) {
    return false;
  }
  if (compilerOptions.paths === undefined) {
    return true;
  }
  if (!compilerOptions.paths || typeof compilerOptions.paths !== "object") {
    return false;
  }
  return Object.entries(compilerOptions.paths).every(
    ([pattern, targets]) =>
      typeof pattern === "string" &&
      (pattern.match(/\*/g)?.length ?? 0) <= 1 &&
      Array.isArray(targets) &&
      targets.every((target) => {
        if (typeof target !== "string" || path.isAbsolute(target)) {
          return false;
        }
        const wildcardCount = target.match(/\*/g)?.length ?? 0;
        if (wildcardCount > 1 || (wildcardCount === 1 && !pattern.includes("*"))) {
          return false;
        }
        const resolvedTarget = target.replaceAll("*", "__openclaw_capture__");
        if (resolvedTarget.split(/[\\/]/).includes("..")) {
          return false;
        }
        const resolved = path.resolve(mappingRoot, resolvedTarget);
        return (
          isPathWithinRoot(rootRealPath, resolved) &&
          isPathWithinRoot(rootRealPath, realpathExistingAncestor(resolved))
        );
      }),
  );
}

function resolveCapturedTsconfigPaths(
  sourceFiles: readonly string[],
  configPath: string,
  rootRealPath: string,
): Record<string, [string]> | undefined {
  const paths: Record<string, [string]> = {};
  for (const source of sourceFiles) {
    const extension = path.extname(source);
    if (
      path.basename(source) === "package.json" ||
      extension === ".json" ||
      extension === ".node"
    ) {
      continue;
    }
    if (extension !== "" && !/\.[cm]?[jt]sx?$/u.test(source)) {
      return undefined;
    }
    const sourceText = fs.readFileSync(source, "utf8");
    const resolver = createJiti(source, {
      fsCache: false,
      moduleCache: false,
      tryNative: false,
      tsconfigPaths: configPath,
    });
    const resolverWithoutTsconfig = createJiti(source, {
      fsCache: false,
      moduleCache: false,
      tryNative: false,
      tsconfigPaths: false,
    });
    try {
      visitPluginSourceReferences(source, sourceText, resolver, (reference, kind) => {
        if (
          kind === "asset" ||
          isBuiltin(reference) ||
          reference.startsWith(".") ||
          reference.startsWith("file:") ||
          path.isAbsolute(reference)
        ) {
          return;
        }
        const resolved = resolver.esmResolve(reference, {
          try: true,
          conditions: ["node", "module-sync", kind],
        });
        const resolvedWithoutTsconfig = resolverWithoutTsconfig.esmResolve(reference, {
          try: true,
          conditions: ["node", "module-sync", kind],
        });
        const controlledByTsconfig = resolved !== resolvedWithoutTsconfig;
        const target = resolved?.startsWith("file:")
          ? fileURLToPath(resolved)
          : resolved && path.isAbsolute(resolved)
            ? resolved
            : undefined;
        if (!target || !fs.existsSync(target)) {
          if (!controlledByTsconfig) {
            return;
          }
          throw new Error("Captured tsconfig alias target could not be resolved");
        }
        const targetRealPath = fs.realpathSync(target);
        const targetIsCaptured =
          isPathWithinRoot(rootRealPath, path.resolve(target)) &&
          isPathWithinRoot(rootRealPath, targetRealPath);
        if (!targetIsCaptured && !controlledByTsconfig) {
          return;
        }
        if (!targetIsCaptured) {
          throw new Error("Captured tsconfig alias target is outside the captured root");
        }
        if (!controlledByTsconfig) {
          return;
        }
        if (paths[reference]?.[0] && paths[reference][0] !== targetRealPath) {
          throw new Error("Captured tsconfig alias resolves inconsistently");
        }
        paths[reference] = [targetRealPath];
      });
    } catch {
      return undefined;
    }
  }
  return paths;
}

function findCapturedTsconfig(
  capturedPath: string,
  capturedRoot: string,
): { configPath?: string; rootRealPath: string } {
  const rootRealPath = fs.realpathSync(capturedRoot);
  let directory = path.dirname(fs.realpathSync(capturedPath));
  while (isPathWithinRoot(rootRealPath, directory)) {
    const configPath = path.join(directory, "tsconfig.json");
    if (fs.existsSync(configPath)) {
      return { configPath, rootRealPath };
    }
    if (directory === rootRealPath) {
      break;
    }
    directory = path.dirname(directory);
  }
  return { rootRealPath };
}

export function shouldDisableCapturedTsconfig(capturedPath: string, capturedRoot: string): boolean {
  const enabled = process.env.JITI_TSCONFIG_PATHS;
  if (enabled === undefined || enabled === "" || enabled === "0" || enabled === "false") {
    return false;
  }
  if (enabled !== "1" && enabled !== "true") {
    return true;
  }
  const { configPath, rootRealPath } = findCapturedTsconfig(capturedPath, capturedRoot);
  return !configPath || !capturedTsconfigIsSafe(configPath, rootRealPath);
}

function prepareCapturedTsconfig(
  capturedPath: string,
  capturedRoot: string,
  sourceFiles: readonly string[],
): { disableAutomaticTsconfig: boolean; tsconfigPath?: string } {
  if (shouldDisableCapturedTsconfig(capturedPath, capturedRoot)) {
    return { disableAutomaticTsconfig: true };
  }
  const enabled = process.env.JITI_TSCONFIG_PATHS;
  if (enabled !== "1" && enabled !== "true") {
    return { disableAutomaticTsconfig: false };
  }
  const { configPath, rootRealPath } = findCapturedTsconfig(capturedPath, capturedRoot);
  if (!configPath) {
    return { disableAutomaticTsconfig: true };
  }
  const exactPaths = resolveCapturedTsconfigPaths(sourceFiles, configPath, rootRealPath);
  if (!exactPaths) {
    return { disableAutomaticTsconfig: true };
  }
  const generatedDir = fs.mkdtempSync(path.join(capturedRoot, ".secret-contract-tsconfig-"));
  const generatedPath = path.join(generatedDir, "tsconfig.json");
  const relativePaths = Object.fromEntries(
    Object.entries(exactPaths).map(([reference, [target]]) => [
      reference,
      [path.relative(generatedDir, target).split(path.sep).join("/")],
    ]),
  );
  fs.writeFileSync(
    generatedPath,
    `${JSON.stringify({ compilerOptions: { baseUrl: ".", paths: relativePaths } }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return { disableAutomaticTsconfig: false, tsconfigPath: generatedPath };
}

function captureComputedContractDependencies(
  artifact: ReturnType<typeof capturePluginGenerationArtifact>,
  rootDir: string,
): readonly string[] {
  const rootRealPath = fs.realpathSync(rootDir);
  const directories: Array<{ path: string; ancestors: ReadonlySet<string> }> = [
    { path: rootRealPath, ancestors: new Set() },
  ];
  const sourceFiles: string[] = [];
  let entryCount = 0;
  while (directories.length > 0) {
    const pending = directories.pop();
    if (!pending) {
      continue;
    }
    const directory = pending.path;
    const directoryRealPath = fs.realpathSync(directory);
    const relativeDirectory = path.relative(rootRealPath, directoryRealPath);
    if (relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
      throw new Error("Channel secret contract dependency is outside the plugin root");
    }
    if (pending.ancestors.has(directoryRealPath)) {
      throw new Error("Channel secret contract source tree contains a directory cycle");
    }
    const ancestors = new Set(pending.ancestors).add(directoryRealPath);
    const handle = fs.opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        entryCount += 1;
        if (entryCount > CONTRACT_CAPTURE_MAX_ENTRIES) {
          throw new Error("Channel secret contract source tree exceeds the capture entry limit");
        }
        if (!isPluginSourceEntry(entry.name)) {
          continue;
        }
        const source = path.join(directory, entry.name);
        const stat = entry.isSymbolicLink()
          ? fs.statSync(source, { throwIfNoEntry: false })
          : undefined;
        if (entry.isSymbolicLink() && !stat) {
          continue;
        }
        if (entry.isDirectory() || stat?.isDirectory()) {
          directories.push({ path: source, ancestors });
          continue;
        }
        if (
          !(entry.isFile() || stat?.isFile()) ||
          (entry.name !== "package.json" &&
            path.extname(entry.name) !== "" &&
            !CONTRACT_CAPTURE_EXTENSIONS.has(path.extname(entry.name)))
        ) {
          continue;
        }
        const sourceRealPath = fs.realpathSync(source);
        const relativeSource = path.relative(rootRealPath, sourceRealPath);
        if (relativeSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSource)) {
          throw new Error("Channel secret contract dependency is outside the plugin root");
        }
        sourceFiles.push(source);
      }
    } finally {
      handle.closeSync();
    }
  }
  return artifact
    .captureResolvedModules(sourceFiles, rootRealPath)
    .filter((source): source is string => source !== undefined);
}

function loadExternalChannelSecretContractFromRecord(
  record: PluginManifestRecord,
  env: NodeJS.ProcessEnv = process.env,
  throwOnLoadError = false,
  ephemeral = false,
): BundledChannelSecretContractApi | undefined {
  const contractPath = resolvePluginContractApiPath(record.rootDir);
  if (!contractPath) {
    return undefined;
  }
  const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
    origin: record.origin,
    rootDir: record.rootDir,
    env,
  });
  const cache = getPluginCache();
  const cacheKey = `${path.resolve(record.rootDir)}\0${path.resolve(contractPath)}\0${rejectHardlinks}`;
  const cached = ephemeral ? undefined : cache.channelSecretContracts.get(cacheKey);
  if (cached) {
    if (cached.status === "loaded") {
      return cached.exports as BundledChannelSecretContractApi;
    }
    if (cached.error && throwOnLoadError) {
      throw cached.error instanceof Error
        ? cached.error
        : new Error(formatErrorMessage(cached.error), { cause: cached.error });
    }
    return undefined;
  }
  let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
  let admitted = false;
  let retainArtifact = false;
  let ephemeralContract: BundledChannelSecretContractApi | undefined;
  let loadError: unknown;
  let cleanupError: unknown;
  try {
    artifact = capturePluginGenerationArtifact(
      record.rootDir,
      contractPath,
      (run) => run(),
      undefined,
      undefined,
      undefined,
      {
        maxEntries: CONTRACT_CAPTURE_MAX_TOTAL_ENTRIES,
        maxFiles: CONTRACT_CAPTURE_MAX_FILES,
        maxBytes: CONTRACT_CAPTURE_MAX_BYTES,
        maxFileBytes: CONTRACT_CAPTURE_MAX_BYTES,
        maxTotalBytes: 512 * 1024 * 1024,
      },
    );
    const capturedPath = artifact.resolve(contractPath, rejectHardlinks);
    const capturedRoot = artifact.rootDir;
    const capturedSourceFiles = captureComputedContractDependencies(artifact, record.rootDir);
    artifact.prepareModule(capturedPath);
    if (rejectHardlinks) {
      artifact.assertNoHardlinks();
    }
    const aliases = preparePluginLoaderAliases({
      modulePath: contractPath,
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
    });
    if (aliases.packageRoot) {
      artifact.linkHost(aliases.packageRoot);
    }
    admitted = true;
    const capturedTsconfig = prepareCapturedTsconfig(
      capturedPath,
      capturedRoot,
      capturedSourceFiles,
    );
    const aliasMap = {
      ...aliases.getAliasMap(),
      ...artifact.sourceAliases,
    };
    const loadModule = () =>
      (ephemeral ? createUncachedPluginModuleLoader : getCachedPluginModuleLoader)({
        modulePath: contractPath,
        loaderFilename: capturedPath,
        disableAutomaticTsconfig: capturedTsconfig.disableAutomaticTsconfig,
        tsconfigPath: capturedTsconfig.tsconfigPath,
        importerUrl: import.meta.url,
        tryNative: false,
        aliasMap,
      })(capturedPath);
    const mod = (
      ephemeral ? withPluginCache(createPluginCache(), loadModule) : loadModule()
    ) as BundledChannelSecretContractApi; // SAFETY: only contract-shaped exports are observed below.
    const hasSupportedExports = Boolean(
      mod.collectRuntimeConfigAssignments || mod.secretTargetRegistryEntries,
    );
    if (path.basename(contractPath).startsWith("secret-contract-api.") && !hasSupportedExports) {
      throw new Error(`Channel secret contract for ${record.id} has no supported exports`);
    }
    if (hasSupportedExports && ephemeral) {
      ephemeralContract = mod;
    } else if (hasSupportedExports) {
      cache.channelSecretContractDisposers.set(cacheKey, () => artifact?.dispose());
      cache.channelSecretContracts.set(cacheKey, {
        status: "loaded",
        exports: mod,
      });
      retainArtifact = true;
      return mod;
    }
  } catch (error) {
    loadError = admitted
      ? error
      : new Error(`Unable to open channel secret contract for ${record.id}`, { cause: error });
  } finally {
    if (!retainArtifact) {
      try {
        artifact?.dispose();
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  const error =
    loadError && cleanupError
      ? new AggregateError(
          [loadError, cleanupError],
          "Channel secret contract loading and cleanup failed",
          { cause: loadError },
        )
      : (loadError ?? cleanupError);
  if (!ephemeral) {
    cache.channelSecretContracts.set(cacheKey, {
      status: "unavailable",
      ...(error ? { error } : {}),
    });
  }
  if (error) {
    if (throwOnLoadError) {
      throw error instanceof Error ? error : new Error(formatErrorMessage(error), { cause: error });
    }
    return undefined;
  }
  return ephemeralContract;
}

function recordOwnsChannel(record: PluginManifestRecord, channelId: string): boolean {
  return (
    record.channels.includes(channelId) ||
    Object.hasOwn(record.channelConfigs ?? {}, channelId) ||
    record.channelCatalogMeta?.id === channelId ||
    record.packageChannel?.id === channelId
  );
}

function listChannelSecretContractRecords(params: {
  channelId: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): PluginManifestRecord[] {
  const manifestRegistry = resolveConfigWidePluginManifestRegistry({
    config: params.config,
    env: params.env,
  });
  return manifestRegistry.plugins
    .filter((record) => record.origin !== "bundled")
    .filter((record) => recordOwnsChannel(record, params.channelId))
    .filter(
      (record) => !params.loadablePluginOrigins || params.loadablePluginOrigins.has(record.id),
    )
    .toSorted((left, right) => {
      if (left.id === params.channelId && right.id !== params.channelId) {
        return -1;
      }
      if (right.id === params.channelId && left.id !== params.channelId) {
        return 1;
      }
      return left.id.localeCompare(right.id);
    });
}

export function loadChannelSecretContractApi(params: {
  channelId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
  bundledOnly?: boolean;
}): BundledChannelSecretContractApi | undefined {
  const bundled = loadBundledChannelSecretContractApi(params.channelId);
  if (bundled || params.bundledOnly) {
    return bundled;
  }
  // External contracts are considered only after bundled artifacts so core channels keep their
  // shipped metadata stable even when similarly named plugins are installed.
  const env = params.env ?? process.env;
  const officialFallback = loadOfficialExternalChannelSecretContractApi(params.channelId);
  let records: PluginManifestRecord[];
  try {
    records = listChannelSecretContractRecords({
      channelId: params.channelId,
      config: params.config,
      env,
      loadablePluginOrigins: params.loadablePluginOrigins,
    });
  } catch (error) {
    // Catalog contracts are process-stable fallbacks when plugin metadata is unavailable.
    if (officialFallback) {
      return officialFallback;
    }
    throw error;
  }
  for (const record of records) {
    const contract = loadExternalChannelSecretContractFromRecord(record, env);
    if (contract) {
      return contract;
    }
  }
  return officialFallback;
}

export function loadChannelSecretContractApiForRecord(
  record: PluginManifestRecord,
  options?: { throwOnLoadError?: boolean; bindToRecord?: boolean; ephemeral?: boolean },
): BundledChannelSecretContractApi | undefined {
  if (record.origin === "bundled" && !options?.bindToRecord) {
    return loadBundledChannelSecretContractApi(record.id);
  }
  return loadExternalChannelSecretContractFromRecord(
    record,
    process.env,
    options?.throwOnLoadError,
    options?.ephemeral === true,
  );
}
