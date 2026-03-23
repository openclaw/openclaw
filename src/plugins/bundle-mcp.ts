import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { matchBoundaryFileOpenFailure, openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
  CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
  mergeBundlePathLists,
  normalizeBundlePathList,
} from "./bundle-manifest.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginBundleFormat } from "./types.js";

export type BundleMcpServerConfig = Record<string, unknown>;

export type BundleMcpConfig = {
  mcpServers: Record<string, BundleMcpServerConfig>;
};

export type BundleMcpDiagnostic = {
  pluginId: string;
  message: string;
};

export type EnabledBundleMcpConfigResult = {
  config: BundleMcpConfig;
  diagnostics: BundleMcpDiagnostic[];
};
export type BundleMcpRuntimeSupport = {
  hasSupportedStdioServer: boolean;
  supportedServerNames: string[];
  unsupportedServerNames: string[];
  diagnostics: string[];
};

const MANIFEST_PATH_BY_FORMAT: Record<PluginBundleFormat, string> = {
  claude: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  codex: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
  cursor: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
};
const CLAUDE_PLUGIN_ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

function canonicalizeExistingDir(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

function readPluginJsonObject(params: {
  rootDir: string;
  relativePath: string;
  allowMissing?: boolean;
}): { ok: true; raw: Record<string, unknown> } | { ok: false; error: string } {
  const absolutePath = path.join(params.rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    return matchBoundaryFileOpenFailure(opened, {
      path: () => {
        if (params.allowMissing) {
          return { ok: true, raw: {} };
        }
        return { ok: false, error: `unable to read ${params.relativePath}: path` };
      },
      fallback: (failure) => ({
        ok: false,
        error: `unable to read ${params.relativePath}: ${failure.reason}`,
      }),
    });
  }
  try {
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
    if (!isRecord(raw)) {
      return { ok: false, error: `${params.relativePath} must contain a JSON object` };
    }
    return { ok: true, raw };
  } catch (error) {
    return { ok: false, error: `failed to parse ${params.relativePath}: ${String(error)}` };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function resolveBundleMcpConfigPaths(params: {
  raw: Record<string, unknown>;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): string[] {
  const declared = normalizeBundlePathList(params.raw.mcpServers);
  const defaults = fs.existsSync(path.join(params.rootDir, ".mcp.json")) ? [".mcp.json"] : [];
  if (params.bundleFormat === "claude") {
    return mergeBundlePathLists(defaults, declared);
  }
  return mergeBundlePathLists(defaults, declared);
}

export function extractMcpServerMap(raw: unknown): Record<string, BundleMcpServerConfig> {
  if (!isRecord(raw)) {
    return {};
  }
  const nested = isRecord(raw.mcpServers)
    ? raw.mcpServers
    : isRecord(raw.servers)
      ? raw.servers
      : raw;
  if (!isRecord(nested)) {
    return {};
  }
  const result: Record<string, BundleMcpServerConfig> = {};
  for (const [serverName, serverRaw] of Object.entries(nested)) {
    if (!isRecord(serverRaw)) {
      continue;
    }
    result[serverName] = { ...serverRaw };
  }
  return result;
}

function isExplicitRelativePath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");
}

function expandBundleRootPlaceholders(value: string, rootDir: string): string {
  if (!value.includes(CLAUDE_PLUGIN_ROOT_PLACEHOLDER)) {
    return value;
  }
  return value.split(CLAUDE_PLUGIN_ROOT_PLACEHOLDER).join(rootDir);
}

function normalizeBundlePath(targetPath: string): string {
  return canonicalizeExistingDir(path.normalize(path.resolve(targetPath)));
}

function normalizeExpandedAbsolutePath(value: string): string {
  return path.isAbsolute(value) ? canonicalizeExistingDir(path.normalize(value)) : value;
}

function resolveBundlePath(value: string, rootDir: string, baseDir: string): string {
  const expanded = expandBundleRootPlaceholders(value, rootDir);
  if (path.isAbsolute(expanded)) {
    return canonicalizeExistingDir(path.normalize(expanded));
  }
  if (isExplicitRelativePath(expanded)) {
    return canonicalizeExistingDir(path.resolve(baseDir, expanded));
  }
  return expanded;
}

function absolutizeBundleMcpServer(params: {
  rootDir: string;
  baseDir: string;
  server: BundleMcpServerConfig;
}): BundleMcpServerConfig {
  const rootDir = canonicalizeExistingDir(params.rootDir);
  const baseDir = canonicalizeExistingDir(params.baseDir);
  const next: BundleMcpServerConfig = { ...params.server };

  if (typeof next.cwd !== "string" && typeof next.workingDirectory !== "string") {
    next.cwd = baseDir;
  }

  const command = next.command;
  if (typeof command === "string") {
    next.command = resolveBundlePath(command, rootDir, baseDir);
  }

  const cwd = next.cwd;
  if (typeof cwd === "string") {
    next.cwd = resolveBundlePath(cwd, rootDir, baseDir);
  }

  const workingDirectory = next.workingDirectory;
  if (typeof workingDirectory === "string") {
    const expanded = expandBundleRootPlaceholders(workingDirectory, rootDir);
    next.workingDirectory = path.isAbsolute(expanded)
      ? canonicalizeExistingDir(path.normalize(expanded))
      : canonicalizeExistingDir(path.resolve(baseDir, expanded));
  }

  if (Array.isArray(next.args)) {
    next.args = next.args.map((entry) => {
      if (typeof entry !== "string") {
        return entry;
      }
      const expanded = expandBundleRootPlaceholders(entry, rootDir);
      if (!isExplicitRelativePath(expanded)) {
        return normalizeExpandedAbsolutePath(expanded);
      }
      return canonicalizeExistingDir(path.resolve(baseDir, expanded));
    });
  }

  if (isRecord(next.env)) {
    next.env = Object.fromEntries(
      Object.entries(next.env).map(([key, value]) => [
        key,
        typeof value === "string"
          ? normalizeExpandedAbsolutePath(expandBundleRootPlaceholders(value, rootDir))
          : value,
      ]),
    );
  }

  return next;
}

function loadBundleFileBackedMcpConfig(params: {
  rootDir: string;
  relativePath: string;
}): BundleMcpConfig {
  const rootDir = normalizeBundlePath(params.rootDir);
  const absolutePath = path.resolve(rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    rootPath: rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    return { mcpServers: {} };
  }
  try {
    const stat = fs.fstatSync(opened.fd);
    if (!stat.isFile()) {
      return { mcpServers: {} };
    }
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
    const servers = extractMcpServerMap(raw);
    const baseDir = normalizeBundlePath(path.dirname(absolutePath));
    return {
      mcpServers: Object.fromEntries(
        Object.entries(servers).map(([serverName, server]) => [
          serverName,
          absolutizeBundleMcpServer({ rootDir, baseDir, server }),
        ]),
      ),
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function loadBundleInlineMcpConfig(params: {
  raw: Record<string, unknown>;
  baseDir: string;
}): BundleMcpConfig {
  if (!isRecord(params.raw.mcpServers)) {
    return { mcpServers: {} };
  }
  const baseDir = normalizeBundlePath(params.baseDir);
  const servers = extractMcpServerMap(params.raw.mcpServers);
  return {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([serverName, server]) => [
        serverName,
        absolutizeBundleMcpServer({ rootDir: baseDir, baseDir, server }),
      ]),
    ),
  };
}

function loadBundleMcpConfig(params: {
  pluginId: string;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): { config: BundleMcpConfig; diagnostics: string[] } {
  const manifestRelativePath = MANIFEST_PATH_BY_FORMAT[params.bundleFormat];
  const manifestLoaded = readPluginJsonObject({
    rootDir: params.rootDir,
    relativePath: manifestRelativePath,
    allowMissing: params.bundleFormat === "claude",
  });
  if (!manifestLoaded.ok) {
    return { config: { mcpServers: {} }, diagnostics: [manifestLoaded.error] };
  }

  let merged: BundleMcpConfig = { mcpServers: {} };
  const filePaths = resolveBundleMcpConfigPaths({
    raw: manifestLoaded.raw,
    rootDir: params.rootDir,
    bundleFormat: params.bundleFormat,
  });
  for (const relativePath of filePaths) {
    merged = applyMergePatch(
      merged,
      loadBundleFileBackedMcpConfig({
        rootDir: params.rootDir,
        relativePath,
      }),
    ) as BundleMcpConfig;
  }

  merged = applyMergePatch(
    merged,
    loadBundleInlineMcpConfig({
      raw: manifestLoaded.raw,
      baseDir: params.rootDir,
    }),
  ) as BundleMcpConfig;

  return { config: merged, diagnostics: [] };
}

export function inspectBundleMcpRuntimeSupport(params: {
  pluginId: string;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): BundleMcpRuntimeSupport {
  const loaded = loadBundleMcpConfig(params);
  const supportedServerNames: string[] = [];
  const unsupportedServerNames: string[] = [];
  let hasSupportedStdioServer = false;
  for (const [serverName, server] of Object.entries(loaded.config.mcpServers)) {
    if (typeof server.command === "string" && server.command.trim().length > 0) {
      hasSupportedStdioServer = true;
      supportedServerNames.push(serverName);
      continue;
    }
    unsupportedServerNames.push(serverName);
  }
  return {
    hasSupportedStdioServer,
    supportedServerNames,
    unsupportedServerNames,
    diagnostics: loaded.diagnostics,
  };
}

export function loadEnabledBundleMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): EnabledBundleMcpConfigResult {
  const registry = loadPluginManifestRegistry({
    workspaceDir: params.workspaceDir,
    config: params.cfg,
  });
  const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
  const diagnostics: BundleMcpDiagnostic[] = [];
  let merged: BundleMcpConfig = { mcpServers: {} };

  for (const record of registry.plugins) {
    if (record.format !== "bundle" || !record.bundleFormat) {
      continue;
    }
    const enableState = resolveEffectiveEnableState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.cfg,
    });
    if (!enableState.enabled) {
      continue;
    }

    const loaded = loadBundleMcpConfig({
      pluginId: record.id,
      rootDir: record.rootDir,
      bundleFormat: record.bundleFormat,
    });
    merged = applyMergePatch(merged, loaded.config) as BundleMcpConfig;
    for (const message of loaded.diagnostics) {
      diagnostics.push({ pluginId: record.id, message });
    }
  }

  return { config: merged, diagnostics };
}
