import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
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
import { safeRealpathSync } from "./path-safety.js";
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
    if (opened.reason === "path" && params.allowMissing) {
      return { ok: true, raw: {} };
    }
    return { ok: false, error: `unable to read ${params.relativePath}: ${opened.reason}` };
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

function canonicalizeBundlePath(targetPath: string): string {
  return path.normalize(safeRealpathSync(targetPath) ?? path.resolve(targetPath));
}

function normalizeExpandedAbsolutePath(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : value;
}

function absolutizeBundleMcpServer(params: {
  rootDir: string;
  baseDir: string;
  server: BundleMcpServerConfig;
}): BundleMcpServerConfig {
  const next: BundleMcpServerConfig = { ...params.server };

  if (typeof next.cwd !== "string" && typeof next.workingDirectory !== "string") {
    next.cwd = params.baseDir;
  }

  const command = next.command;
  if (typeof command === "string") {
    const expanded = expandBundleRootPlaceholders(command, params.rootDir);
    next.command = isExplicitRelativePath(expanded)
      ? path.resolve(params.baseDir, expanded)
      : normalizeExpandedAbsolutePath(expanded);
  }

  const cwd = next.cwd;
  if (typeof cwd === "string") {
    const expanded = expandBundleRootPlaceholders(cwd, params.rootDir);
    next.cwd = path.isAbsolute(expanded) ? expanded : path.resolve(params.baseDir, expanded);
  }

  const workingDirectory = next.workingDirectory;
  if (typeof workingDirectory === "string") {
    const expanded = expandBundleRootPlaceholders(workingDirectory, params.rootDir);
    next.workingDirectory = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(params.baseDir, expanded);
  }

  if (Array.isArray(next.args)) {
    next.args = next.args.map((entry) => {
      if (typeof entry !== "string") {
        return entry;
      }
      const expanded = expandBundleRootPlaceholders(entry, params.rootDir);
      if (!isExplicitRelativePath(expanded)) {
        return normalizeExpandedAbsolutePath(expanded);
      }
      return path.resolve(params.baseDir, expanded);
    });
  }

  if (isRecord(next.env)) {
    next.env = Object.fromEntries(
      Object.entries(next.env).map(([key, value]) => [
        key,
        typeof value === "string"
          ? normalizeExpandedAbsolutePath(expandBundleRootPlaceholders(value, params.rootDir))
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
  const rootDir = canonicalizeBundlePath(params.rootDir);
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
    const baseDir = canonicalizeBundlePath(path.dirname(absolutePath));
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
  const baseDir = canonicalizeBundlePath(params.baseDir);
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
