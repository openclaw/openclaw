import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  extractBundleServerMap,
  loadEnabledBundleConfig,
  readBundleJsonObject,
} from "./bundle-config-shared.js";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  resolveBundleComponentPaths,
} from "./bundle-manifest.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginBundleFormat } from "./manifest-types.js";

type BundleLspConfig = {
  lspServers: Record<string, Record<string, unknown>>;
};

type BundleLspRuntimeSupport = {
  supportedServerNames: string[];
  unsupportedServerNames: string[];
  diagnostics: string[];
};

function loadBundleLspConfig(params: { rootDir: string; bundleFormat: PluginBundleFormat }): {
  config: BundleLspConfig;
  diagnostics: string[];
} {
  if (params.bundleFormat !== "claude") {
    return { config: { lspServers: {} }, diagnostics: [] };
  }

  const manifestLoaded = readBundleJsonObject({
    rootDir: params.rootDir,
    relativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  });
  if (!manifestLoaded.ok) {
    return { config: { lspServers: {} }, diagnostics: [manifestLoaded.error] };
  }

  let merged: BundleLspConfig = { lspServers: {} };
  const filePaths = resolveBundleComponentPaths(manifestLoaded.raw.lspServers, params.rootDir, [
    ".lsp.json",
  ]);
  const diagnostics: string[] = [];
  for (const relativePath of filePaths) {
    const result = readBundleJsonObject({
      rootDir: params.rootDir,
      relativePath,
      allowMissing: true,
    });
    if (!result.ok) {
      diagnostics.push(
        result.reason === "open" ? result.error : `unable to read ${relativePath}: ${result.error}`,
      );
    }
    merged = applyMergePatch(merged, {
      lspServers: result.ok ? extractBundleServerMap(result.raw, ["lspServers"]) : {},
    }) as BundleLspConfig;
  }

  return { config: merged, diagnostics };
}

export function inspectBundleLspRuntimeSupport(params: {
  pluginId: string;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): BundleLspRuntimeSupport {
  const { config, diagnostics } = loadBundleLspConfig(params);
  const supportedServerNames: string[] = [];
  const unsupportedServerNames: string[] = [];
  for (const [name, server] of Object.entries(config.lspServers)) {
    const supported = typeof server.command === "string" && server.command.trim().length > 0;
    (supported ? supportedServerNames : unsupportedServerNames).push(name);
  }
  return {
    supportedServerNames,
    unsupportedServerNames,
    diagnostics,
  };
}

export function loadEnabledBundleLspConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): { config: BundleLspConfig; diagnostics: Array<{ pluginId: string; message: string }> } {
  return loadEnabledBundleConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
    createEmptyConfig: () => ({ lspServers: {} }),
    loadBundleConfig: loadBundleLspConfig,
  });
}
