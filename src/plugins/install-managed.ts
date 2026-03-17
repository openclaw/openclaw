import fs from "node:fs";
import path from "node:path";
import { looksLikeLocalInstallSpec } from "../cli/install-spec.js";
import { resolvePinnedNpmInstallRecord } from "../cli/npm-resolution.js";
import {
  resolveBundledInstallPlanBeforeNpm,
  resolveBundledInstallPlanForNpmFailure,
} from "../cli/plugin-install-plan.js";
import { loadConfig, type OpenClawConfig, writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { resolveUserPath } from "../utils.js";
import { findBundledPluginSource, type BundledPluginSource } from "./bundled-sources.js";
import { clearPluginDiscoveryCache } from "./discovery.js";
import { enablePluginInConfig } from "./enable.js";
import {
  installPluginFromNpmSpec,
  installPluginFromPath,
  type PluginInstallErrorCode,
} from "./install.js";
import { recordPluginInstall } from "./installs.js";
import { clearPluginLoaderCache } from "./loader.js";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";
import { installPluginFromMarketplace, resolveMarketplaceInstallShortcut } from "./marketplace.js";
import { applyExclusiveSlotSelection } from "./slots.js";
import { buildPluginStatusReport } from "./status.js";

type ManagedPluginInstallMode = "installed" | "linked";
type ManagedPluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type ManagedPluginInstallResult =
  | {
      ok: true;
      pluginId: string;
      mode: ManagedPluginInstallMode;
      warnings: string[];
      notices: string[];
      installPath?: string;
      restartRequired: true;
    }
  | { ok: false; error: string; code?: PluginInstallErrorCode };

export type ManagedPluginInstallParams = {
  raw: string;
  link?: boolean;
  pin?: boolean;
  marketplace?: string;
  config?: OpenClawConfig;
  logger?: ManagedPluginInstallLogger;
};

function clearPluginInstallCaches(): void {
  clearPluginManifestRegistryCache();
  clearPluginDiscoveryCache();
  clearPluginLoaderCache();
}

function resolveFileNpmSpecToLocalPath(
  raw: string,
): { ok: true; path: string } | { ok: false; error: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("file:")) {
    return null;
  }
  const rest = trimmed.slice("file:".length);
  if (!rest) {
    return { ok: false, error: "unsupported file: spec: missing path" };
  }
  if (rest.startsWith("///")) {
    return { ok: true, path: rest.slice(2) };
  }
  if (rest.startsWith("//localhost/")) {
    return { ok: true, path: rest.slice("//localhost".length) };
  }
  if (rest.startsWith("//")) {
    return {
      ok: false,
      error: 'unsupported file: URL host (expected "file:<path>" or "file:///abs/path")',
    };
  }
  return { ok: true, path: rest };
}

function applySlotSelectionForPlugin(
  config: OpenClawConfig,
  pluginId: string,
): { config: OpenClawConfig; warnings: string[] } {
  const report = buildPluginStatusReport({ config });
  const plugin = report.plugins.find((entry) => entry.id === pluginId);
  if (!plugin) {
    return { config, warnings: [] };
  }
  const result = applyExclusiveSlotSelection({
    config,
    selectedId: plugin.id,
    selectedKind: plugin.kind,
    registry: report,
  });
  return { config: result.config, warnings: result.warnings };
}

async function finalizePluginInstall(params: {
  config: OpenClawConfig;
  pluginId: string;
  record: Parameters<typeof recordPluginInstall>[1];
}): Promise<{ warnings: string[] }> {
  let next = enablePluginInConfig(params.config, params.pluginId).config;
  next = recordPluginInstall(next, params.record);
  const slotResult = applySlotSelectionForPlugin(next, params.pluginId);
  await writeConfigFile(slotResult.config);
  return { warnings: slotResult.warnings };
}

async function installBundledPluginSource(params: {
  config: OpenClawConfig;
  rawSpec: string;
  bundledSource: BundledPluginSource;
  warning: string;
}): Promise<ManagedPluginInstallResult> {
  const existing = params.config.plugins?.load?.paths ?? [];
  const mergedPaths = Array.from(new Set([...existing, params.bundledSource.localPath]));
  const next: OpenClawConfig = {
    ...params.config,
    plugins: {
      ...params.config.plugins,
      load: {
        ...params.config.plugins?.load,
        paths: mergedPaths,
      },
      entries: {
        ...params.config.plugins?.entries,
        [params.bundledSource.pluginId]: {
          ...(params.config.plugins?.entries?.[params.bundledSource.pluginId] as
            | object
            | undefined),
          enabled: true,
        },
      },
    },
  };
  const finalized = await finalizePluginInstall({
    config: next,
    pluginId: params.bundledSource.pluginId,
    record: {
      pluginId: params.bundledSource.pluginId,
      source: "path",
      spec: params.rawSpec,
      sourcePath: params.bundledSource.localPath,
      installPath: params.bundledSource.localPath,
    },
  });
  return {
    ok: true,
    pluginId: params.bundledSource.pluginId,
    mode: "installed",
    warnings: [params.warning, ...finalized.warnings],
    notices: [],
    installPath: params.bundledSource.localPath,
    restartRequired: true,
  };
}

export async function installManagedPlugin(
  params: ManagedPluginInstallParams,
): Promise<ManagedPluginInstallResult> {
  const shorthand = !params.marketplace
    ? await resolveMarketplaceInstallShortcut(params.raw)
    : null;
  if (shorthand?.ok === false) {
    return { ok: false, error: shorthand.error };
  }

  const raw = shorthand?.ok ? shorthand.plugin : params.raw;
  const marketplace =
    params.marketplace ?? (shorthand?.ok ? shorthand.marketplaceSource : undefined);
  const cfg = params.config ?? loadConfig();
  const extensionsDir = path.join(resolveStateDir(process.env), "extensions");

  if (marketplace) {
    if (params.link) {
      return { ok: false, error: "`--link` is not supported with `--marketplace`." };
    }
    if (params.pin) {
      return { ok: false, error: "`--pin` is not supported with `--marketplace`." };
    }

    const result = await installPluginFromMarketplace({
      marketplace,
      plugin: raw,
      extensionsDir,
      logger: params.logger,
    });
    if (!result.ok) {
      return result;
    }

    clearPluginInstallCaches();
    const finalized = await finalizePluginInstall({
      config: cfg,
      pluginId: result.pluginId,
      record: {
        pluginId: result.pluginId,
        source: "marketplace",
        installPath: result.targetDir,
        version: result.version,
        marketplaceName: result.marketplaceName,
        marketplaceSource: result.marketplaceSource,
        marketplacePlugin: result.marketplacePlugin,
      },
    });
    return {
      ok: true,
      pluginId: result.pluginId,
      mode: "installed",
      warnings: finalized.warnings,
      notices: [],
      installPath: result.targetDir,
      restartRequired: true,
    };
  }

  const fileSpec = resolveFileNpmSpecToLocalPath(raw);
  if (fileSpec && !fileSpec.ok) {
    return { ok: false, error: fileSpec.error };
  }
  const normalized = fileSpec && fileSpec.ok ? fileSpec.path : raw;
  const resolved = resolveUserPath(normalized);

  if (fs.existsSync(resolved)) {
    if (params.link) {
      const existing = cfg.plugins?.load?.paths ?? [];
      const merged = Array.from(new Set([...existing, resolved]));
      const probe = await installPluginFromPath({
        path: resolved,
        extensionsDir,
        dryRun: true,
      });
      if (!probe.ok) {
        return probe;
      }

      const linkedCfg: OpenClawConfig = enablePluginInConfig(
        {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            load: {
              ...cfg.plugins?.load,
              paths: merged,
            },
          },
        },
        probe.pluginId,
      ).config;

      const finalized = await finalizePluginInstall({
        config: linkedCfg,
        pluginId: probe.pluginId,
        record: {
          pluginId: probe.pluginId,
          source: "path",
          sourcePath: resolved,
          installPath: resolved,
          version: probe.version,
        },
      });
      return {
        ok: true,
        pluginId: probe.pluginId,
        mode: "linked",
        warnings: finalized.warnings,
        notices: [],
        installPath: resolved,
        restartRequired: true,
      };
    }

    const result = await installPluginFromPath({
      path: resolved,
      extensionsDir,
      logger: params.logger,
    });
    if (!result.ok) {
      return result;
    }
    clearPluginInstallCaches();

    const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
    const finalized = await finalizePluginInstall({
      config: cfg,
      pluginId: result.pluginId,
      record: {
        pluginId: result.pluginId,
        source,
        sourcePath: resolved,
        installPath: result.targetDir,
        version: result.version,
      },
    });
    return {
      ok: true,
      pluginId: result.pluginId,
      mode: "installed",
      warnings: finalized.warnings,
      notices: [],
      installPath: result.targetDir,
      restartRequired: true,
    };
  }

  if (params.link) {
    return { ok: false, error: "`--link` requires a local path." };
  }

  if (
    looksLikeLocalInstallSpec(raw, [
      ".ts",
      ".js",
      ".mjs",
      ".cjs",
      ".tgz",
      ".tar.gz",
      ".tar",
      ".zip",
    ])
  ) {
    return { ok: false, error: `Path not found: ${resolved}` };
  }

  const bundledPreNpmPlan = resolveBundledInstallPlanBeforeNpm({
    rawSpec: raw,
    findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
  });
  if (bundledPreNpmPlan) {
    return await installBundledPluginSource({
      config: cfg,
      rawSpec: raw,
      bundledSource: bundledPreNpmPlan.bundledSource,
      warning: bundledPreNpmPlan.warning,
    });
  }

  const npmNotices: string[] = [];
  const npmWarnings: string[] = [];
  const result = await installPluginFromNpmSpec({
    spec: raw,
    extensionsDir,
    logger: params.logger,
  });
  if (!result.ok) {
    const bundledFallbackPlan = resolveBundledInstallPlanForNpmFailure({
      rawSpec: raw,
      code: result.code,
      findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
    });
    if (!bundledFallbackPlan) {
      return result;
    }
    return await installBundledPluginSource({
      config: cfg,
      rawSpec: raw,
      bundledSource: bundledFallbackPlan.bundledSource,
      warning: bundledFallbackPlan.warning,
    });
  }

  clearPluginInstallCaches();
  const installRecord = resolvePinnedNpmInstallRecord({
    rawSpec: raw,
    pin: Boolean(params.pin),
    installPath: result.targetDir,
    version: result.version,
    resolution: result.npmResolution,
    log: (message) => npmNotices.push(message),
    warn: (message) => npmWarnings.push(message),
  });
  const finalized = await finalizePluginInstall({
    config: cfg,
    pluginId: result.pluginId,
    record: {
      pluginId: result.pluginId,
      ...installRecord,
    },
  });
  return {
    ok: true,
    pluginId: result.pluginId,
    mode: "installed",
    warnings: [...npmWarnings, ...finalized.warnings],
    notices: npmNotices,
    installPath: result.targetDir,
    restartRequired: true,
  };
}
