import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { matchRootFileOpenFailure, type RootFileOpenFailure } from "../infra/boundary-file-read.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginBundleFormat } from "./manifest-types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

type ReadBundleJsonResult =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string };

export type BundleServerRuntimeSupport = {
  hasSupportedServer: boolean;
  supportedServerNames: string[];
  unsupportedServerNames: string[];
  diagnostics: string[];
};

/** Reads a bundle-owned JSON object while keeping traversal inside the plugin root. */
export function readBundleJsonObject(params: {
  rootDir: string;
  relativePath: string;
  onOpenFailure?: (failure: RootFileOpenFailure) => ReadBundleJsonResult;
}): ReadBundleJsonResult {
  const result = readRootJsonObjectSync({
    rootDir: params.rootDir,
    relativePath: params.relativePath,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (result.ok) {
    return { ok: true, raw: result.value };
  }
  if (result.reason === "open") {
    return params.onOpenFailure?.(result.failure) ?? { ok: true, raw: {} };
  }
  return { ok: false, error: result.error };
}

/** Converts open failures into bundle-config load results with optional missing-file tolerance. */
export function resolveBundleJsonOpenFailure(params: {
  failure: RootFileOpenFailure;
  relativePath: string;
  allowMissing?: boolean;
}): ReadBundleJsonResult {
  return matchRootFileOpenFailure(params.failure, {
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

/** Classifies bundle servers by whether they expose a runnable command. */
export function inspectBundleServerRuntimeSupport<TConfig>(params: {
  loaded: { config: TConfig; diagnostics: string[] };
  resolveServers: (config: TConfig) => Record<string, Record<string, unknown>>;
}): BundleServerRuntimeSupport {
  const supportedServerNames: string[] = [];
  const unsupportedServerNames: string[] = [];
  let hasSupportedServer = false;
  for (const [serverName, server] of Object.entries(params.resolveServers(params.loaded.config))) {
    if (typeof server.command === "string" && server.command.trim().length > 0) {
      hasSupportedServer = true;
      supportedServerNames.push(serverName);
      continue;
    }
    unsupportedServerNames.push(serverName);
  }
  return {
    hasSupportedServer,
    supportedServerNames,
    unsupportedServerNames,
    diagnostics: params.loaded.diagnostics,
  };
}

/** Loads and merge-patches enabled bundle plugin config from active bundle manifests. */
export function loadEnabledBundleConfig<TConfig, TDiagnostic>(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  createEmptyConfig: () => TConfig;
  loadBundleConfig: (params: {
    pluginId: string;
    rootDir: string;
    bundleFormat: PluginBundleFormat;
  }) => { config: TConfig; diagnostics: string[] };
  createDiagnostic: (pluginId: string, message: string) => TDiagnostic;
}): { config: TConfig; diagnostics: TDiagnostic[] } {
  const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
  if (!normalizedPlugins.enabled) {
    return { config: params.createEmptyConfig(), diagnostics: [] };
  }

  const registry =
    params.manifestRegistry ??
    loadPluginManifestRegistryForPluginRegistry({
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      includeDisabled: true,
    });
  const diagnostics: TDiagnostic[] = [];
  let merged = params.createEmptyConfig();

  for (const record of registry.plugins) {
    if (record.format !== "bundle" || !record.bundleFormat) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.cfg,
    });
    if (!activationState.activated) {
      continue;
    }

    // Bundle configs are merged in registry order so later active bundles can
    // intentionally override defaults from earlier bundle manifests.
    const loaded = params.loadBundleConfig({
      pluginId: record.id,
      rootDir: record.rootDir,
      bundleFormat: record.bundleFormat,
    });
    merged = applyMergePatch(merged, loaded.config) as TConfig;
    for (const message of loaded.diagnostics) {
      diagnostics.push(params.createDiagnostic(record.id, message));
    }
  }

  return { config: merged, diagnostics };
}
