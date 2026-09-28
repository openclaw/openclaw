// Resolves plugin SDK aliases for public package imports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  filterStringEntries,
  sortUniqueStrings,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolveOpenClawDevSourceRoot } from "./dev-source-root.js";
import { PLUGIN_SOURCE_MODULE_EXTENSIONS } from "./native-module-require.js";
import {
  parsePluginCacheJson,
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  pluginCacheStatSync,
  readPluginCacheDirectory,
  readPluginCacheFile,
} from "./plugin-cache-files.js";
import {
  getPluginSdkAliasFacts,
  getPluginSdkHostFacts,
  type PluginRuntimeModuleResolution,
  type PluginSdkPackageJson,
  type WorkspacePackageAliasEntry,
} from "./plugin-cache-sdk.js";
import { getPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  createJitiAliasContentCacheKey,
  normalizePluginLoaderAliasMapForJiti,
} from "./sdk-alias-normalization.js";
import {
  WORKSPACE_PACKAGE_ALIAS_ENTRIES,
  WORKSPACE_PACKAGE_EXPORT_DIRS,
  WORKSPACE_PACKAGE_ALIAS_NAMES,
  ROOT_PACKAGED_WORKSPACE_PACKAGE_DIRS,
} from "./sdk-alias-workspace.js";

type PluginSdkAliasCandidateKind = "dist" | "src";
export type PluginSdkResolutionPreference = "auto" | "dist" | "src";

type LoaderModuleResolveParams = {
  modulePath?: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
};

export type { PluginRuntimeModuleResolution } from "./plugin-cache-sdk.js";

const STARTUP_ARGV1 = process.argv[1];

function sdkHost(packageRoot: string) {
  return getPluginSdkHostFacts(getPluginCache().sdk, path.resolve(packageRoot));
}

function readSdkJsonFile(filePath: string): unknown {
  const file = readPluginCacheFile({
    rootDir: path.dirname(filePath),
    relativePath: path.basename(filePath),
    rejectHardlinks: false,
  });
  const parsed = file.ok ? parsePluginCacheJson(file) : undefined;
  return parsed?.ok ? parsed.value : null;
}

function sanitizeJitiCachePathSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

function resolveJitiFsCacheRoot(): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim();
  if (xdgCacheHome && path.isAbsolute(xdgCacheHome)) {
    return xdgCacheHome;
  }
  const homeDir = resolveRequiredHomeDir(process.env, os.homedir);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return localAppData && path.isAbsolute(localAppData)
      ? localAppData
      : path.join(homeDir, "AppData", "Local");
  }
  return process.platform === "darwin"
    ? path.join(homeDir, "Library", "Caches")
    : path.join(homeDir, ".cache");
}

function readJitiBooleanEnv(name: string, defaultValue: boolean): boolean {
  if (!(name in process.env)) {
    return defaultValue;
  }
  try {
    return Boolean(JSON.parse(process.env[name] ?? ""));
  } catch {
    return defaultValue;
  }
}

function resolvePluginLoaderJitiNativeModules(): string[] {
  try {
    const configured: unknown = JSON.parse(process.env.JITI_NATIVE_MODULES ?? "[]");
    return uniqueStrings([...filterStringEntries(configured), "openclaw"]);
  } catch {
    return ["openclaw"];
  }
}

function normalizeJitiAliasTargetPath(targetPath: string): string {
  const canonicalPath = pluginCacheRealpathSync(targetPath) ?? targetPath;
  return process.platform === "win32" ? canonicalPath.replace(/\\/g, "/") : canonicalPath;
}

function resolveLoaderModulePath(params: LoaderModuleResolveParams = {}): string {
  return params.modulePath ?? fileURLToPath(params.moduleUrl ?? import.meta.url);
}

function readPluginSdkPackageJson(packageRoot: string): PluginSdkPackageJson | null {
  const facts = sdkHost(packageRoot);
  if (facts.packageJson !== undefined) {
    return facts.packageJson;
  }
  const parsed = readSdkJsonFile(path.join(packageRoot, "package.json"));
  facts.packageJson = isRecord(parsed)
    ? {
        ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
        ...(isRecord(parsed.exports) ? { exports: parsed.exports } : {}),
        ...(typeof parsed.bin === "string" || isRecord(parsed.bin) ? { bin: parsed.bin } : {}),
        ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
      }
    : null;
  return facts.packageJson;
}

function resolveJitiCacheModulePath(params: LoaderModuleResolveParams = {}): string {
  if (params.modulePath?.startsWith("file://")) {
    try {
      return fileURLToPath(params.modulePath);
    } catch {
      // Fall through to the shared module resolver for malformed test inputs.
    }
  }
  return resolveLoaderModulePath(params);
}

function resolvePluginLoaderJitiFsCacheDir(params: LoaderModuleResolveParams = {}): string {
  const modulePath = resolveJitiCacheModulePath(params);
  const packageRoot =
    resolveLoaderPackageRoot({ ...params, modulePath }) ?? path.dirname(modulePath);
  const packageJsonPath = path.join(packageRoot, "package.json");
  const version = sanitizeJitiCachePathSegment(
    readPluginSdkPackageJson(packageRoot)?.version ?? "unknown",
  );
  let installMarker = "no-package-json";
  const stat = pluginCacheStatSync(packageJsonPath);
  if (stat) {
    installMarker = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
  }
  return path.join(
    resolveJitiFsCacheRoot(),
    "openclaw",
    "jiti",
    version,
    sanitizeJitiCachePathSegment(installMarker),
  );
}

function isSafePluginSdkSubpathSegment(subpath: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath);
}

function listPluginSdkSubpathsFromPackageJson(pkg: PluginSdkPackageJson): string[] {
  return Object.keys(pkg.exports ?? {})
    .filter((key) => key.startsWith("./plugin-sdk/"))
    .map((key) => key.slice("./plugin-sdk/".length))
    .filter((subpath) => isSafePluginSdkSubpathSegment(subpath))
    .toSorted();
}

function hasTrustedOpenClawRootIndicator(params: {
  packageRoot: string;
  packageJson: PluginSdkPackageJson;
}): boolean {
  const facts = sdkHost(params.packageRoot);
  if (facts.trustedRoot !== undefined) {
    return facts.trustedRoot;
  }
  const packageExports = params.packageJson.exports ?? {};
  const hasPluginSdkSubpathExport = Object.keys(packageExports).some((key) =>
    key.startsWith("./plugin-sdk/"),
  );
  if (!hasPluginSdkSubpathExport) {
    return (facts.trustedRoot = false);
  }
  const hasCliEntryExport = Object.hasOwn(packageExports, "./cli-entry");
  const hasOpenClawBin =
    (typeof params.packageJson.bin === "string" &&
      normalizeLowercaseStringOrEmpty(params.packageJson.bin).includes("openclaw")) ||
    (typeof params.packageJson.bin === "object" &&
      params.packageJson.bin !== null &&
      typeof params.packageJson.bin.openclaw === "string");
  return (facts.trustedRoot =
    hasCliEntryExport ||
    hasOpenClawBin ||
    pluginCacheExistsSync(path.join(params.packageRoot, "openclaw.mjs")));
}

function readPluginSdkSubpathsFromPackageRoot(packageRoot: string): string[] | null {
  const facts = sdkHost(packageRoot);
  if (facts.exportedSubpaths !== undefined) {
    return facts.exportedSubpaths;
  }
  const pkg = readPluginSdkPackageJson(packageRoot);
  if (!pkg || !hasTrustedOpenClawRootIndicator({ packageRoot, packageJson: pkg })) {
    return (facts.exportedSubpaths = null);
  }
  const subpaths = listPluginSdkSubpathsFromPackageJson(pkg);
  return (facts.exportedSubpaths = subpaths.length > 0 ? subpaths : null);
}

function resolveTrustedOpenClawRootFromArgvHint(params: {
  argv1?: string;
  cwd: string;
}): string | null {
  if (!params.argv1) {
    return null;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    cwd: params.cwd,
    argv1: params.argv1,
  });
  if (!packageRoot) {
    return null;
  }
  const packageJson = readPluginSdkPackageJson(packageRoot);
  if (!packageJson) {
    return null;
  }
  return hasTrustedOpenClawRootIndicator({ packageRoot, packageJson }) ? packageRoot : null;
}

function findNearestPluginSdkPackageRoot(startDir: string, maxDepth = 12): string | null {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i += 1) {
    const subpaths = readPluginSdkSubpathsFromPackageRoot(cursor);
    if (subpaths) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
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

function listPluginRuntimeModuleCandidates(
  packageRoot: string,
  orderedKinds: readonly PluginSdkAliasCandidateKind[],
): string[] {
  return orderedKinds.map((kind) =>
    path.join(packageRoot, kind, "plugins", "runtime", kind === "src" ? "index.ts" : "index.js"),
  );
}

function dedupeResolvedPaths(paths: readonly string[]): string[] {
  return uniqueStrings(paths.map((candidate) => path.resolve(candidate)));
}

function listAncestorPluginRuntimeModuleCandidates(params: {
  starts: readonly (string | undefined)[];
  orderedKinds: readonly PluginSdkAliasCandidateKind[];
  maxDepth?: number;
}): string[] {
  const candidates: string[] = [];
  for (const start of params.starts) {
    if (!start) {
      continue;
    }
    let cursor = path.resolve(start);
    const maxDepth = params.maxDepth ?? 12;
    for (let i = 0; i < maxDepth; i += 1) {
      candidates.push(...listPluginRuntimeModuleCandidates(cursor, params.orderedKinds));
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  }
  return dedupeResolvedPaths(candidates);
}

function listArgvRuntimeFallbackStartDirs(argv1: string | undefined): string[] {
  if (!argv1) {
    return [];
  }
  const normalized = path.resolve(argv1);
  const starts: string[] = [];
  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
    const binName = path.basename(normalized);
    const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
    starts.push(path.join(nodeModulesDir, binName));
  }
  try {
    const resolved = pluginCacheRealpathSync(normalized);
    if (resolved && resolved !== normalized) {
      starts.push(path.dirname(resolved));
    }
  } catch {
    // Keep the unresolved argv path; startup shims may not exist in tests.
  }
  starts.push(path.dirname(normalized));
  return dedupeResolvedPaths(starts);
}

function resolveDevSourceRootParam(params: { devSourceRoot?: string | null }): string | null {
  return params.devSourceRoot !== undefined
    ? params.devSourceRoot
    : resolveOpenClawDevSourceRoot(process.env);
}

function resolveLoaderPluginSdkPackageRoot(
  params: LoaderModuleResolveParams & { modulePath: string },
): string | null {
  const devSourceRoot = resolveDevSourceRootParam(params);
  if (devSourceRoot) {
    return devSourceRoot;
  }
  const cwd = params.cwd ?? path.dirname(params.modulePath);
  // The running loader owns the SDK, even when plugin source lives in another checkout.
  return (
    (params.moduleUrl ? resolveOpenClawPackageRootSync({ moduleUrl: params.moduleUrl }) : null) ??
    resolveOpenClawPackageRootSync({ cwd }) ??
    resolveTrustedOpenClawRootFromArgvHint({ cwd, argv1: params.argv1 }) ??
    findNearestPluginSdkPackageRoot(path.dirname(params.modulePath)) ??
    (params.cwd ? findNearestPluginSdkPackageRoot(params.cwd) : null) ??
    findNearestPluginSdkPackageRoot(process.cwd())
  );
}

function resolvePluginSdkAliasCandidateOrder(params: {
  modulePath: string;
  isProduction: boolean;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): PluginSdkAliasCandidateKind[] {
  if (params.pluginSdkResolution === "dist") {
    return ["dist", "src"];
  }
  if (params.pluginSdkResolution === "src") {
    return ["src", "dist"];
  }
  const normalizedModulePath = params.modulePath.replace(/\\/g, "/");
  const isDistRuntime = /\/dist(?:-runtime)?\//.test(normalizedModulePath);
  const isSourceRuntime = normalizedModulePath.includes("/src/");
  return isDistRuntime || (!isSourceRuntime && params.isProduction)
    ? ["dist", "src"]
    : ["src", "dist"];
}

const PLUGIN_SDK_PACKAGE_NAMES = ["openclaw/plugin-sdk", "@openclaw/plugin-sdk"] as const;
const CODEX_MCP_PROJECTION_PLUGIN_SDK_SUBPATH = "codex-mcp-projection";
const CODEX_SESSION_TRANSCRIPT_PLUGIN_SDK_SUBPATH = "codex-session-transcript-runtime";
const NATIVE_HOOK_RELAY_RUNTIME_PLUGIN_SDK_SUBPATH = "native-hook-relay-runtime";
const CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH = "ssrf-runtime-internal";
const PRIVATE_QA_ONLY_PLUGIN_SDK_SUBPATHS = new Set([
  "agent-runtime-test-contracts",
  "channel-contract-testing",
  "channel-ingress-test-runtime",
  "channel-target-testing",
  "channel-test-helpers",
  "plugin-test-api",
  "plugin-test-contracts",
  "plugin-state-test-runtime",
  "plugin-test-runtime",
  "provider-http-test-mocks",
  "provider-test-contracts",
  "qa-channel",
  "qa-channel-protocol",
  "qa-lab",
  "qa-runtime",
  "reply-payload-testing",
  "sqlite-runtime-testing",
  "test-env",
  "test-fixtures",
  "test-live",
  "test-live-auth",
  "test-media-generation",
  "test-media-understanding",
  "test-node-mocks",
]);
type PrivatePluginSdkSubpathOwner = {
  bundledPluginId: string;
  officialInstalledPackageName?: string;
  allowPrivateQaCli: boolean;
  subpaths: readonly string[];
};
const PRIVATE_PLUGIN_SDK_SUBPATH_OWNERS: readonly PrivatePluginSdkSubpathOwner[] = [
  {
    bundledPluginId: "codex",
    officialInstalledPackageName: "@openclaw/codex",
    allowPrivateQaCli: true,
    subpaths: [
      CODEX_MCP_PROJECTION_PLUGIN_SDK_SUBPATH,
      CODEX_SESSION_TRANSCRIPT_PLUGIN_SDK_SUBPATH,
      NATIVE_HOOK_RELAY_RUNTIME_PLUGIN_SDK_SUBPATH,
    ],
  },
  {
    bundledPluginId: "ollama",
    allowPrivateQaCli: false,
    subpaths: [CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH],
  },
  {
    bundledPluginId: "browser",
    allowPrivateQaCli: false,
    subpaths: [CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH],
  },
  {
    bundledPluginId: "llama-cpp",
    officialInstalledPackageName: "@openclaw/llama-cpp-provider",
    allowPrivateQaCli: false,
    subpaths: [CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH],
  },
];
const PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS = [
  ".ts",
  ".mts",
  ".js",
  ".mjs",
  ".cts",
  ".cjs",
] as const;
const BUNDLED_PLUGIN_PUBLIC_SURFACE_SOURCE_PATTERN = /^(?:api|runtime-api|test-api|.+-api)$/u;
const JS_STATIC_RELATIVE_DEPENDENCY_PATTERN =
  /(?:\bfrom\s*["']|\bimport\s*\(\s*["']|\brequire\s*\(\s*["'])(\.{1,2}\/[^"']+)["']/g;

function normalizePackageExportSubpath(exportKey: string): string | null {
  if (exportKey === ".") {
    return "";
  }
  if (!exportKey.startsWith("./")) {
    return null;
  }
  const subpath = exportKey.slice(2);
  return subpath && !subpath.includes("..") ? subpath : null;
}

function resolvePackageExportImportPath(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }
  return typeof value.import === "string"
    ? value.import
    : typeof value.default === "string"
      ? value.default
      : null;
}

function listRootPackagedWorkspacePackageAliasEntries(params: {
  packageRoot: string;
  packageName: string;
  packageDir: string;
}): WorkspacePackageAliasEntry[] {
  const distRoot = path.join(params.packageRoot, "dist", params.packageDir);
  if (!pluginCacheExistsSync(distRoot)) {
    return [];
  }
  const entries: WorkspacePackageAliasEntry[] = [];
  const visit = (dir: string, prefix = "") => {
    for (const entry of readPluginCacheDirectory(dir)) {
      const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile() || !relativePath.endsWith(".js")) {
        continue;
      }
      const normalizedRelativePath = relativePath.split(path.sep).join("/");
      const subpath =
        normalizedRelativePath === "index.js" ? "" : normalizedRelativePath.slice(0, -".js".length);
      if (subpath.includes("..")) {
        continue;
      }
      entries.push({
        packageName: params.packageName,
        packageDir: params.packageDir,
        subpath,
        srcFile: `${subpath || "index"}.ts`,
        distFile: relativePath,
      });
    }
  };
  visit(distRoot);
  return entries.toSorted((a, b) => a.subpath.localeCompare(b.subpath));
}

export function listWorkspacePackageExportAliasEntries(params: {
  packageRoot: string;
  packageName: string;
  packageDir: string;
}): WorkspacePackageAliasEntry[] {
  const cache = sdkHost(params.packageRoot).workspaceExports;
  const key = `${params.packageName}\0${params.packageDir}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const packageJson = readPluginSdkPackageJson(
    path.join(params.packageRoot, "packages", params.packageDir),
  );
  const entries: WorkspacePackageAliasEntry[] = [];
  for (const [exportKey, value] of Object.entries(packageJson?.exports ?? {})) {
    const subpath = normalizePackageExportSubpath(exportKey);
    const importPath = resolvePackageExportImportPath(value);
    if (subpath === null || !importPath?.startsWith("./dist/") || !importPath.endsWith(".mjs")) {
      continue;
    }
    const distFile = importPath.slice("./dist/".length);
    const srcFile = distFile.replace(/\.mjs$/u, ".ts");
    entries.push({
      packageName: params.packageName,
      packageDir: params.packageDir,
      subpath,
      srcFile,
      distFile,
    });
  }
  const result =
    entries.length > 0
      ? entries.toSorted((a, b) => a.subpath.localeCompare(b.subpath))
      : listRootPackagedWorkspacePackageAliasEntries(params);
  cache.set(key, result);
  return result;
}

function isUsableDistPluginSdkArtifact(candidate: string): boolean {
  const cache = getPluginCache().sdk.usableDistArtifacts;
  const cached = cache.get(candidate);
  if (cached !== undefined) {
    return cached;
  }
  const usable = checkDistPluginSdkArtifact(candidate);
  cache.set(candidate, usable);
  return usable;
}

function checkDistPluginSdkArtifact(candidate: string): boolean {
  if (!pluginCacheExistsSync(candidate)) {
    return false;
  }
  switch (normalizeLowercaseStringOrEmpty(path.extname(candidate))) {
    case ".js":
    case ".mjs":
    case ".cjs":
      break;
    default:
      return true;
  }
  try {
    const source = fs.readFileSync(candidate, "utf-8");
    for (const match of source.matchAll(JS_STATIC_RELATIVE_DEPENDENCY_PATTERN)) {
      const specifier = match[1];
      if (!specifier || pluginCacheExistsSync(path.resolve(path.dirname(candidate), specifier))) {
        continue;
      }
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function readPrivateLocalOnlyPluginSdkSubpaths(packageRoot: string): string[] {
  const facts = sdkHost(packageRoot);
  if (facts.privateSubpaths) {
    return facts.privateSubpaths;
  }
  const parsed = readSdkJsonFile(
    path.join(packageRoot, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
  );
  return (facts.privateSubpaths = uniqueStrings([
    CODEX_MCP_PROJECTION_PLUGIN_SDK_SUBPATH,
    NATIVE_HOOK_RELAY_RUNTIME_PLUGIN_SDK_SUBPATH,
    CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH,
    ...filterStringEntries(parsed).filter(isSafePluginSdkSubpathSegment),
  ]));
}

function readBundledPluginPackageName(packageJsonPath: string): string | null {
  const parsed = readPluginSdkPackageJson(path.dirname(packageJsonPath));
  const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
  return name.startsWith("@openclaw/") ? name : null;
}

function listBundledPluginPublicSurfaceSourceBasenames(params: {
  extensionSourceRoot: string;
  includePrivateQa: boolean;
}): string[] {
  try {
    return readPluginCacheDirectory(params.extensionSourceRoot)
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .flatMap((fileName) => {
        const ext = PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS.find((candidateExt) =>
          fileName.endsWith(candidateExt),
        );
        if (!ext) {
          return [];
        }
        const basename = fileName.slice(0, -ext.length);
        return (basename !== "test-api" || params.includePrivateQa) &&
          BUNDLED_PLUGIN_PUBLIC_SURFACE_SOURCE_PATTERN.test(basename)
          ? [basename]
          : [];
      })
      .toSorted();
  } catch {
    return [];
  }
}

function resolveBundledPluginPublicSurfaceAliasTarget(params: {
  packageRoot: string;
  dirName: string;
  basename: string;
  orderedKinds: PluginSdkAliasCandidateKind[];
}): string | null {
  for (const kind of params.orderedKinds) {
    const root = path.join(
      params.packageRoot,
      ...(kind === "dist" ? ["dist"] : []),
      "extensions",
      params.dirName,
    );
    for (const ext of kind === "dist" ? [".js"] : PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS) {
      const candidate = path.join(root, `${params.basename}${ext}`);
      if (pluginCacheExistsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

type PluginLoaderAliasContext = {
  packageRoot: string | null;
  orderedKinds: PluginSdkAliasCandidateKind[];
  includePrivateQa: boolean;
  trustedPrivateOwners: string[];
  bundledPlugin: boolean;
};

function resolveBundledPluginPackagePublicSurfaceAliasMap(
  context: PluginLoaderAliasContext,
): Record<string, string> {
  const { packageRoot, orderedKinds, includePrivateQa } = context;
  if (!packageRoot) {
    return {};
  }
  const cachedBundledPluginPublicSurfaceAliasMaps = sdkHost(packageRoot).bundledAliasesByMode;
  const cacheKey = `${packageRoot}::${orderedKinds.join(",")}::privateQa=${includePrivateQa ? "1" : "0"}`;
  const cached = cachedBundledPluginPublicSurfaceAliasMaps.get(cacheKey);
  if (cached) {
    return cached;
  }
  const extensionsRoot = path.join(packageRoot, "extensions");
  let extensionDirs: fs.Dirent[];
  try {
    extensionDirs = readPluginCacheDirectory(extensionsRoot);
  } catch {
    cachedBundledPluginPublicSurfaceAliasMaps.set(cacheKey, {});
    return {};
  }
  const aliasMap: Record<string, string> = {};
  for (const entry of extensionDirs) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dirName = entry.name;
    const packageName = readBundledPluginPackageName(
      path.join(extensionsRoot, dirName, "package.json"),
    );
    if (!packageName) {
      continue;
    }
    for (const basename of listBundledPluginPublicSurfaceSourceBasenames({
      extensionSourceRoot: path.join(extensionsRoot, dirName),
      includePrivateQa,
    })) {
      const target = resolveBundledPluginPublicSurfaceAliasTarget({
        packageRoot,
        dirName,
        basename,
        orderedKinds,
      });
      if (!target) {
        continue;
      }
      aliasMap[`${packageName}/${basename}.js`] = normalizeJitiAliasTargetPath(target);
    }
  }
  cachedBundledPluginPublicSurfaceAliasMaps.set(cacheKey, aliasMap);
  return aliasMap;
}

function resolveWorkspacePackageAliasMap(
  context: PluginLoaderAliasContext,
): Record<string, string> {
  const { packageRoot, orderedKinds } = context;
  if (!packageRoot) {
    return {};
  }
  // Raw modes with the same effective preference order resolve identical targets.
  // Key the process-stable cache by that target-affecting order, not the caller spelling.
  const cacheKey = `${packageRoot}::${orderedKinds.join(",")}`;
  const cachedWorkspacePackageAliasMaps = sdkHost(packageRoot).workspaceAliasesByMode;
  const cached = cachedWorkspacePackageAliasMaps.get(cacheKey);
  if (cached) {
    return cached;
  }
  const aliasMap: Record<string, string> = {};
  const workspacePackageAliasEntries = [
    ...WORKSPACE_PACKAGE_ALIAS_ENTRIES,
    ...WORKSPACE_PACKAGE_EXPORT_DIRS.flatMap((packageDir) =>
      listWorkspacePackageExportAliasEntries({
        packageRoot,
        packageName: `@openclaw/${packageDir}`,
        packageDir,
      }),
    ),
  ];
  for (const entry of workspacePackageAliasEntries) {
    const alias = entry.subpath ? `${entry.packageName}/${entry.subpath}` : entry.packageName;
    for (const kind of orderedKinds) {
      const candidates =
        kind === "dist"
          ? [
              ...(ROOT_PACKAGED_WORKSPACE_PACKAGE_DIRS.has(entry.packageDir)
                ? [
                    path.join(
                      packageRoot,
                      "dist",
                      entry.packageDir,
                      entry.distFile.replace(/\.mjs$/u, ".js"),
                    ),
                  ]
                : []),
              path.join(packageRoot, "packages", entry.packageDir, "dist", entry.distFile),
            ]
          : [path.join(packageRoot, "packages", entry.packageDir, "src", entry.srcFile)];
      const candidate = candidates.find((candidatePath) => pluginCacheExistsSync(candidatePath));
      if (candidate) {
        aliasMap[alias] = normalizeJitiAliasTargetPath(candidate);
        break;
      }
    }
  }
  cachedWorkspacePackageAliasMaps.set(cacheKey, aliasMap);
  return aliasMap;
}

function isBundledPluginModulePath(params: {
  packageRoot: string;
  modulePath: string;
  pluginId: string;
}) {
  const normalizedModulePath = path.resolve(params.modulePath);
  const roots = [
    path.join(params.packageRoot, "extensions", params.pluginId),
    path.join(params.packageRoot, "dist", "extensions", params.pluginId),
    path.join(params.packageRoot, "dist-runtime", "extensions", params.pluginId),
  ];
  return roots.some(
    (root) =>
      normalizedModulePath === root || normalizedModulePath.startsWith(`${root}${path.sep}`),
  );
}

function isAnyBundledPluginModulePath(params: { packageRoot: string; modulePath: string }) {
  const normalizedModulePath = path.resolve(params.modulePath);
  return ["extensions", path.join("dist", "extensions"), path.join("dist-runtime", "extensions")]
    .map((segment) => path.join(params.packageRoot, segment))
    .some((root) => normalizedModulePath.startsWith(`${root}${path.sep}`));
}

function isOfficialInstalledPluginPackageRoot(params: {
  packageRoot: string;
  packageName: string;
}) {
  const [scope, name] = params.packageName.split("/");
  if (!scope || !name) {
    return false;
  }
  const segments = path.resolve(params.packageRoot).split(path.sep).filter(Boolean);
  const last = segments.at(-1);
  const packageScope = segments.at(-2);
  const nodeModules = segments.at(-3);
  return last === name && packageScope === scope && nodeModules === "node_modules";
}

function isOfficialInstalledPluginModulePath(params: { modulePath: string; packageName: string }) {
  let cursor = path.dirname(path.resolve(params.modulePath));
  for (let depth = 0; depth < 12; depth += 1) {
    const packageJson = readPluginSdkPackageJson(cursor);
    if (packageJson) {
      return (
        packageJson.name === params.packageName &&
        isOfficialInstalledPluginPackageRoot({
          packageRoot: cursor,
          packageName: params.packageName,
        })
      );
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return false;
}

function isTrustedPrivatePluginSdkOwnerPath(params: {
  packageRoot: string;
  modulePath: string;
  owner: PrivatePluginSdkSubpathOwner;
}) {
  if (
    isBundledPluginModulePath({
      packageRoot: params.packageRoot,
      modulePath: params.modulePath,
      pluginId: params.owner.bundledPluginId,
    })
  ) {
    return true;
  }
  return params.owner.officialInstalledPackageName
    ? isOfficialInstalledPluginModulePath({
        modulePath: params.modulePath,
        packageName: params.owner.officialInstalledPackageName,
      })
    : false;
}

function listTrustedPrivatePluginSdkOwnerKeys(params: {
  packageRoot: string;
  modulePath: string;
}): string[] {
  return PRIVATE_PLUGIN_SDK_SUBPATH_OWNERS.filter((owner) =>
    isTrustedPrivatePluginSdkOwnerPath({ ...params, owner }),
  ).map((owner) => owner.bundledPluginId);
}

function shouldIncludePrivateLocalOnlyPluginSdkSubpath(
  context: PluginLoaderAliasContext,
  subpath: string,
) {
  if (PRIVATE_QA_ONLY_PLUGIN_SDK_SUBPATHS.has(subpath)) {
    return context.includePrivateQa;
  }
  const owners = PRIVATE_PLUGIN_SDK_SUBPATH_OWNERS.filter((owner) =>
    owner.subpaths.includes(subpath),
  );
  if (owners.length === 0) {
    // Demoted public helpers remain available to bundled plugins; sensitive
    // helpers retain their explicitly captured owner grants.
    return context.bundledPlugin || context.includePrivateQa;
  }
  return owners.some(
    (owner) =>
      context.trustedPrivateOwners.includes(owner.bundledPluginId) ||
      (owner.allowPrivateQaCli && context.includePrivateQa),
  );
}

function listDistPluginSdkArtifactSubpaths(packageRoot: string): Set<string> {
  try {
    const distPluginSdkDir = path.join(packageRoot, "dist", "plugin-sdk");
    return new Set(
      readPluginCacheDirectory(distPluginSdkDir)
        .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
        .map((entry) => entry.name.slice(0, -".js".length))
        .filter((subpath) => isSafePluginSdkSubpathSegment(subpath)),
    );
  } catch {
    return new Set();
  }
}

function pluginSdkAuthorityCacheKey(context: PluginLoaderAliasContext): string {
  return `${context.packageRoot}::privateQa=${context.includePrivateQa ? "1" : "0"}::privateOwners=${context.trustedPrivateOwners.join(",")}::bundled=${context.bundledPlugin ? "1" : "0"}`;
}

function listPluginSdkExportedSubpaths(context: PluginLoaderAliasContext): string[] {
  const { packageRoot } = context;
  if (!packageRoot) {
    return [];
  }
  const cacheKey = pluginSdkAuthorityCacheKey(context);
  const cachedPluginSdkExportedSubpaths = sdkHost(packageRoot).subpathsByOwner;
  const cached = cachedPluginSdkExportedSubpaths.get(cacheKey);
  if (cached) {
    return cached;
  }
  const subpaths = sortUniqueStrings([
    ...(readPluginSdkSubpathsFromPackageRoot(packageRoot) ?? []),
    ...readPrivateLocalOnlyPluginSdkSubpaths(packageRoot).filter((subpath) =>
      shouldIncludePrivateLocalOnlyPluginSdkSubpath(context, subpath),
    ),
  ]);
  cachedPluginSdkExportedSubpaths.set(cacheKey, subpaths);
  return subpaths;
}

function createPluginSdkScopedAliases(context: PluginLoaderAliasContext) {
  const { packageRoot, orderedKinds } = context;
  // Only permitted inventory names enter the cache; missing targets are also
  // generation-owned facts. A first import must not validate every SDK artifact.
  const targets = new Map<string, string | null | undefined>(
    listPluginSdkExportedSubpaths(context).map((subpath) => [subpath, undefined]),
  );
  let distArtifacts: Set<string> | undefined;
  let aliasMap: Record<string, string> | undefined;
  const resolveSubpath = (subpath: string): string | undefined => {
    if (!packageRoot || !targets.has(subpath)) {
      return undefined;
    }
    const cachedTarget = targets.get(subpath);
    if (cachedTarget !== undefined) {
      return cachedTarget ?? undefined;
    }
    for (const kind of orderedKinds) {
      if (kind === "dist") {
        distArtifacts ??= listDistPluginSdkArtifactSubpaths(packageRoot);
        const candidate = path.join(packageRoot, "dist", "plugin-sdk", `${subpath}.js`);
        if (distArtifacts.has(subpath) && isUsableDistPluginSdkArtifact(candidate)) {
          targets.set(subpath, candidate);
          return candidate;
        }
        continue;
      }
      for (const ext of PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS) {
        const candidate = path.join(packageRoot, "src", "plugin-sdk", `${subpath}${ext}`);
        if (pluginCacheExistsSync(candidate)) {
          targets.set(subpath, candidate);
          return candidate;
        }
      }
    }
    targets.set(subpath, null);
    return undefined;
  };
  const buildAliasMap = () => {
    const aliases: Record<string, string> = {};
    for (const subpath of targets.keys()) {
      const target = resolveSubpath(subpath);
      if (!target) {
        continue;
      }
      for (const packageName of PLUGIN_SDK_PACKAGE_NAMES) {
        aliases[`${packageName}/${subpath}`] = normalizeJitiAliasTargetPath(target);
      }
    }
    return aliases;
  };
  return {
    resolveSubpath,
    getAliasMap: (): Record<string, string> => (aliasMap ??= buildAliasMap()),
  };
}

/** Captures host and private authority now; only complete artifact preparation is deferred. */
export function preparePluginLoaderAliases(
  params: LoaderModuleResolveParams & { modulePath: string },
) {
  const modulePath = path.resolve(params.modulePath);
  let hostModulePath = modulePath;
  if (params.moduleUrl) {
    try {
      hostModulePath = fileURLToPath(params.moduleUrl);
    } catch {
      // Invalid optional host hints follow the package-root resolver's fallback.
    }
  }
  const captured = { ...params, modulePath, devSourceRoot: resolveDevSourceRootParam(params) };
  const packageRoot = resolveLoaderPluginSdkPackageRoot(captured);
  const ownerPackageRoot = packageRoot
    ? (resolveLoaderPackageRoot({
        modulePath,
        argv1: captured.argv1,
        moduleUrl: captured.moduleUrl,
      }) ?? packageRoot)
    : null;
  const context: PluginLoaderAliasContext = {
    packageRoot,
    orderedKinds: resolvePluginSdkAliasCandidateOrder({
      modulePath: hostModulePath,
      isProduction: process.env.NODE_ENV === "production",
      pluginSdkResolution: params.pluginSdkResolution,
    }),
    includePrivateQa: process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1",
    trustedPrivateOwners: ownerPackageRoot
      ? listTrustedPrivatePluginSdkOwnerKeys({ packageRoot: ownerPackageRoot, modulePath })
      : [],
    bundledPlugin: ownerPackageRoot
      ? isAnyBundledPluginModulePath({ packageRoot: ownerPackageRoot, modulePath })
      : false,
  };
  const cache = getPluginCache();
  const cacheKey = JSON.stringify(context);
  const cached = cache.sdk.contexts.get(cacheKey);
  if (cached) {
    return cached;
  }
  let sourceTransformAliasMap: Record<string, string> | undefined;
  let aliasMap: Record<string, string> | undefined;
  let sdkAliases: ReturnType<typeof createPluginSdkScopedAliases> | undefined;
  const getSdkAliases = () => (sdkAliases ??= createPluginSdkScopedAliases(context));
  const getSourceTransformAliasMap = () =>
    withPluginCache(
      cache,
      () =>
        (sourceTransformAliasMap ??= {
          ...resolveBundledPluginPackagePublicSurfaceAliasMap(context),
          ...resolveWorkspacePackageAliasMap(context),
        }),
    );
  const getAliasMap = () =>
    withPluginCache(
      cache,
      () =>
        (aliasMap ??= {
          ...getSourceTransformAliasMap(),
          ...getSdkAliases().getAliasMap(),
        }),
    );
  const prepared = {
    packageRoot,
    // These are all inputs to the three map builders; installed artifacts stay
    // stable for the loader lifecycle. Key the captured authority, not raw hints.
    cacheKey,
    sdkRoots: packageRoot
      ? context.orderedKinds.map((kind) => {
          const root = path.join(packageRoot, kind, "plugin-sdk");
          return pluginCacheRealpathSync(root) ?? root;
        })
      : [],
    getAliasMap,
    getSourceTransformAliasMap,
    resolveAlias: (specifier: string): string | undefined => {
      if (!isPluginLoaderAliasSpecifier(specifier)) {
        return undefined;
      }
      if (aliasMap) {
        return aliasMap[specifier];
      }
      return withPluginCache(cache, () => {
        const prefix = PLUGIN_SDK_PACKAGE_NAMES.find((name) => specifier.startsWith(`${name}/`));
        if (!prefix) {
          return getAliasMap()[specifier];
        }
        const target = getSdkAliases().resolveSubpath(specifier.slice(prefix.length + 1));
        return target ? normalizeJitiAliasTargetPath(target) : undefined;
      });
    },
  };
  cache.sdk.contexts.set(cacheKey, prepared);
  return prepared;
}

// SDK and workspace namespaces are canonical above. Bundled package names are
// manifest-owned, but their alias surface is restricted to these API basenames.
function isPluginLoaderAliasSpecifier(specifier: string): boolean {
  const packageName = specifier.split("/", 2).join("/");
  const basename = specifier.slice(packageName.length + 1);
  return (
    isPluginSdkAliasSpecifier(specifier) ||
    WORKSPACE_PACKAGE_ALIAS_NAMES.has(packageName) ||
    (packageName.startsWith("@openclaw/") &&
      !basename.includes("/") &&
      basename.endsWith(".js") &&
      BUNDLED_PLUGIN_PUBLIC_SURFACE_SOURCE_PATTERN.test(basename.slice(0, -3)))
  );
}

export function isPluginSdkAliasSpecifier(specifier: string): boolean {
  return PLUGIN_SDK_PACKAGE_NAMES.some((prefix) => specifier.startsWith(`${prefix}/`));
}

export function buildPluginLoaderAliasMap(
  modulePath: string,
  argv1: string | undefined = STARTUP_ARGV1,
  moduleUrl?: string,
  pluginSdkResolution: PluginSdkResolutionPreference = "auto",
  devSourceRoot?: string | null,
): Record<string, string> {
  return preparePluginLoaderAliases({
    modulePath,
    argv1,
    moduleUrl,
    pluginSdkResolution,
    devSourceRoot,
  }).getAliasMap();
}

export function resolvePluginRuntimeModulePathWithDiagnostics(
  params: LoaderModuleResolveParams = {},
): PluginRuntimeModuleResolution {
  const cache = getPluginCache().sdk.runtimeModules;
  const key = JSON.stringify([
    params.modulePath,
    params.argv1 ?? process.argv[1],
    params.cwd,
    params.moduleUrl,
    resolveDevSourceRootParam(params),
    params.pluginSdkResolution,
    process.cwd(),
    process.env.NODE_ENV,
  ]);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const result = resolvePluginRuntimeModuleCandidates(params);
  cache.set(key, result);
  return result;
}

function resolvePluginRuntimeModuleCandidates(
  params: LoaderModuleResolveParams,
): PluginRuntimeModuleResolution {
  let modulePath: string | undefined;
  let packageRoot: string | null = null;
  const candidates: string[] = [];
  try {
    modulePath = resolveLoaderModulePath(params);
    const orderedKinds = resolvePluginSdkAliasCandidateOrder({
      modulePath,
      isProduction: process.env.NODE_ENV === "production",
      pluginSdkResolution: params.pluginSdkResolution,
    });
    packageRoot =
      resolveDevSourceRootParam(params) ?? resolveLoaderPackageRoot({ ...params, modulePath });
    if (packageRoot) {
      candidates.push(...listPluginRuntimeModuleCandidates(packageRoot, orderedKinds));
    } else {
      const argv1 = params.argv1 ?? process.argv[1];
      const runtimeDir = path.join(path.dirname(modulePath), "runtime");
      candidates.push(
        ...listAncestorPluginRuntimeModuleCandidates({
          starts: listArgvRuntimeFallbackStartDirs(argv1),
          orderedKinds,
        }),
        ...orderedKinds.map((kind) =>
          path.join(runtimeDir, kind === "src" ? "index.ts" : "index.js"),
        ),
      );
    }
    const dedupedCandidates = dedupeResolvedPaths(candidates);
    for (const candidate of dedupedCandidates) {
      if (pluginCacheExistsSync(candidate)) {
        return {
          modulePath,
          packageRoot,
          candidates: dedupedCandidates,
          resolvedPath: candidate,
        };
      }
    }
  } catch (error) {
    return {
      modulePath,
      packageRoot,
      candidates: dedupeResolvedPaths(candidates),
      resolvedPath: null,
      error: formatErrorMessage(error),
    };
  }
  return {
    modulePath,
    packageRoot,
    candidates: dedupeResolvedPaths(candidates),
    resolvedPath: null,
  };
}

export function buildPluginLoaderJitiOptions(
  aliasMap: Record<string, string>,
  params: LoaderModuleResolveParams = {},
) {
  const hasAliases = Object.keys(aliasMap).length > 0;
  const jitiAliasMap = hasAliases ? normalizePluginLoaderAliasMapForJiti(aliasMap) : aliasMap;
  const fsCache: false | string = readJitiBooleanEnv(
    "JITI_FS_CACHE",
    readJitiBooleanEnv("JITI_CACHE", true),
  )
    ? resolvePluginLoaderJitiFsCacheDir(params)
    : false;
  return {
    interopDefault: true,
    fsCache,
    // Prefer Node's native sync ESM loader for built dist/*.js modules so
    // bundled plugins and plugin-sdk subpaths stay on the canonical module graph.
    tryNative: true,
    // When jiti must transform a plugin entry, keep OpenClaw's own package
    // chunks on the native module graph instead of re-evaluating them in jiti.
    nativeModules: resolvePluginLoaderJitiNativeModules(),
    extensions: [...PLUGIN_SOURCE_MODULE_EXTENSIONS, ".js", ".mjs", ".cjs", ".json"],
    ...(hasAliases
      ? {
          alias: jitiAliasMap,
        }
      : {}),
  };
}

export function createPluginLoaderModuleCacheKey(params: {
  tryNative: boolean;
  aliasMap: Record<string, string>;
}): string {
  const facts = getPluginSdkAliasFacts(getPluginCache().sdk, params.aliasMap);
  const aliasMapKey = (facts.moduleKey ??= createJitiAliasContentCacheKey(params.aliasMap));
  return `${params.tryNative ? "native" : "transform"}\0${aliasMapKey}`;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
