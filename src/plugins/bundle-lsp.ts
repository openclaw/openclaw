import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  mergeBundlePathLists,
  normalizeBundlePathList,
} from "./bundle-manifest.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginBundleFormat } from "./types.js";

export type BundleLspServerConfig = Record<string, unknown>;

export type BundleLspConfig = {
  lspServers: Record<string, BundleLspServerConfig>;
};

export type BundleLspRuntimeSupport = {
  hasStdioServer: boolean;
  supportedServerNames: string[];
  unsupportedServerNames: string[];
  diagnostics: string[];
};

const MANIFEST_PATH_BY_FORMAT: Partial<Record<PluginBundleFormat, string>> = {
  claude: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
};

function readPluginJsonObject(params: {
  rootDir: string;
  relativePath: string;
}): { ok: true; raw: Record<string, unknown> } | { ok: false; error: string } {
  const absolutePath = path.join(params.rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    return { ok: true, raw: {} };
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

function extractLspServerMap(raw: unknown): Record<string, BundleLspServerConfig> {
  if (!isRecord(raw)) {
    return {};
  }
  const nested = isRecord(raw.lspServers) ? raw.lspServers : raw;
  if (!isRecord(nested)) {
    return {};
  }
  const result: Record<string, BundleLspServerConfig> = {};
  for (const [serverName, serverRaw] of Object.entries(nested)) {
    if (!isRecord(serverRaw)) {
      continue;
    }
    result[serverName] = { ...serverRaw };
  }
  return result;
}

function resolveBundleLspConfigPaths(params: {
  raw: Record<string, unknown>;
  rootDir: string;
}): string[] {
  const declared = normalizeBundlePathList(params.raw.lspServers);
  const defaults = fs.existsSync(path.join(params.rootDir, ".lsp.json")) ? [".lsp.json"] : [];
  return mergeBundlePathLists(defaults, declared);
}

function loadBundleLspConfigFile(params: {
  rootDir: string;
  relativePath: string;
}): BundleLspConfig {
  const absolutePath = path.resolve(params.rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    return { lspServers: {} };
  }
  try {
    const stat = fs.fstatSync(opened.fd);
    if (!stat.isFile()) {
      return { lspServers: {} };
    }
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
    return { lspServers: extractLspServerMap(raw) };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function loadBundleLspConfig(params: {
  pluginId: string;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): { config: BundleLspConfig; diagnostics: string[] } {
  const manifestRelativePath = MANIFEST_PATH_BY_FORMAT[params.bundleFormat];
  if (!manifestRelativePath) {
    return { config: { lspServers: {} }, diagnostics: [] };
  }

  const manifestLoaded = readPluginJsonObject({
    rootDir: params.rootDir,
    relativePath: manifestRelativePath,
  });
  if (!manifestLoaded.ok) {
    return { config: { lspServers: {} }, diagnostics: [manifestLoaded.error] };
  }

  let merged: BundleLspConfig = { lspServers: {} };
  const filePaths = resolveBundleLspConfigPaths({
    raw: manifestLoaded.raw,
    rootDir: params.rootDir,
  });
  for (const relativePath of filePaths) {
    merged = applyMergePatch(
      merged,
      loadBundleLspConfigFile({
        rootDir: params.rootDir,
        relativePath,
      }),
    ) as BundleLspConfig;
  }

  return { config: merged, diagnostics: [] };
}

export function inspectBundleLspRuntimeSupport(params: {
  pluginId: string;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): BundleLspRuntimeSupport {
  const loaded = loadBundleLspConfig(params);
  const supportedServerNames: string[] = [];
  const unsupportedServerNames: string[] = [];
  let hasStdioServer = false;
  for (const [serverName, server] of Object.entries(loaded.config.lspServers)) {
    if (typeof server.command === "string" && server.command.trim().length > 0) {
      hasStdioServer = true;
      supportedServerNames.push(serverName);
      continue;
    }
    unsupportedServerNames.push(serverName);
  }
  return {
    hasStdioServer,
    supportedServerNames,
    unsupportedServerNames,
    diagnostics: loaded.diagnostics,
  };
}

export function loadEnabledBundleLspConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): { config: BundleLspConfig; diagnostics: Array<{ pluginId: string; message: string }> } {
  const registry = loadPluginManifestRegistry({
    workspaceDir: params.workspaceDir,
    config: params.cfg,
  });
  const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
  const diagnostics: Array<{ pluginId: string; message: string }> = [];
  let merged: BundleLspConfig = { lspServers: {} };

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

    const loaded = loadBundleLspConfig({
      pluginId: record.id,
      rootDir: record.rootDir,
      bundleFormat: record.bundleFormat,
    });
    merged = applyMergePatch(merged, loaded.config) as BundleLspConfig;
    for (const message of loaded.diagnostics) {
      diagnostics.push({ pluginId: record.id, message });
    }
  }

  return { config: merged, diagnostics };
}
