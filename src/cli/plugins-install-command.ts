import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { installHooksFromNpmSpec, installHooksFromPath } from "../hooks/install.js";
import { recordHookInstall } from "../hooks/installs.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { parseClawHubPluginSpec } from "../infra/clawhub.js";
import { type BundledPluginSource, findBundledPluginSource } from "../plugins/bundled-sources.js";
import { formatClawHubSpecifier, installPluginFromClawHub } from "../plugins/clawhub.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { installPluginFromNpmSpec, installPluginFromPath } from "../plugins/install.js";
import { recordPluginInstall } from "../plugins/installs.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import {
  installPluginFromMarketplace,
  resolveMarketplaceInstallShortcut,
} from "../plugins/marketplace.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { looksLikeLocalInstallSpec } from "./install-spec.js";
import { resolvePinnedNpmInstallRecordForCli } from "./npm-resolution.js";
import {
  resolveBundledInstallPlanBeforeNpm,
  resolveBundledInstallPlanForNpmFailure,
} from "./plugin-install-plan.js";
import {
  applySlotSelectionForPlugin,
  buildPreferredClawHubSpec,
  createHookPackInstallLogger,
  createPluginInstallLogger,
  enableInternalHookEntries,
  formatPluginInstallWithHookFallbackError,
  logHookPackRestartHint,
  logSlotWarnings,
  resolveFileNpmSpecToLocalPath,
  shouldFallbackFromClawHubToNpm,
} from "./plugins-command-helpers.js";

async function installBundledPluginSource(params: {
  config: OpenClawConfig;
  rawSpec: string;
  bundledSource: BundledPluginSource;
  warning: string;
}) {
  const existing = params.config.plugins?.load?.paths ?? [];
  const mergedPaths = Array.from(new Set([...existing, params.bundledSource.localPath]));
  let next: OpenClawConfig = {
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
  next = recordPluginInstall(next, {
    pluginId: params.bundledSource.pluginId,
    source: "path",
    spec: params.rawSpec,
    sourcePath: params.bundledSource.localPath,
    installPath: params.bundledSource.localPath,
  });
  const slotResult = applySlotSelectionForPlugin(next, params.bundledSource.pluginId);
  next = slotResult.config;
  await writeConfigFile(next);
  logSlotWarnings(slotResult.warnings);
  defaultRuntime.log(theme.warn(params.warning));
  defaultRuntime.log(`Installed plugin: ${params.bundledSource.pluginId}`);
  defaultRuntime.log("Restart the gateway to load plugins.");
}

async function tryInstallHookPackFromLocalPath(params: {
  config: OpenClawConfig;
  resolvedPath: string;
  link?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (params.link) {
    const stat = fs.statSync(params.resolvedPath);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: "Linked hook pack paths must be directories.",
      };
    }

    const probe = await installHooksFromPath({
      path: params.resolvedPath,
      dryRun: true,
    });
    if (!probe.ok) {
      return probe;
    }

    const existing = params.config.hooks?.internal?.load?.extraDirs ?? [];
    const merged = Array.from(new Set([...existing, params.resolvedPath]));
    let next: OpenClawConfig = {
      ...params.config,
      hooks: {
        ...params.config.hooks,
        internal: {
          ...params.config.hooks?.internal,
          enabled: true,
          load: {
            ...params.config.hooks?.internal?.load,
            extraDirs: merged,
          },
        },
      },
    };
    next = enableInternalHookEntries(next, probe.hooks);
    next = recordHookInstall(next, {
      hookId: probe.hookPackId,
      source: "path",
      sourcePath: params.resolvedPath,
      installPath: params.resolvedPath,
      version: probe.version,
      hooks: probe.hooks,
    });
    await writeConfigFile(next);
    defaultRuntime.log(`Linked hook pack path: ${shortenHomePath(params.resolvedPath)}`);
    logHookPackRestartHint();
    return { ok: true };
  }

  const result = await installHooksFromPath({
    path: params.resolvedPath,
    logger: createHookPackInstallLogger(),
  });
  if (!result.ok) {
    return result;
  }

  let next = enableInternalHookEntries(params.config, result.hooks);
  const source: "archive" | "path" = resolveArchiveKind(params.resolvedPath) ? "archive" : "path";
  next = recordHookInstall(next, {
    hookId: result.hookPackId,
    source,
    sourcePath: params.resolvedPath,
    installPath: result.targetDir,
    version: result.version,
    hooks: result.hooks,
  });
  await writeConfigFile(next);
  defaultRuntime.log(`Installed hook pack: ${result.hookPackId}`);
  logHookPackRestartHint();
  return { ok: true };
}

async function tryInstallHookPackFromNpmSpec(params: {
  config: OpenClawConfig;
  spec: string;
  pin?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await installHooksFromNpmSpec({
    spec: params.spec,
    logger: createHookPackInstallLogger(),
  });
  if (!result.ok) {
    return result;
  }

  let next = enableInternalHookEntries(params.config, result.hooks);
  const installRecord = resolvePinnedNpmInstallRecordForCli(
    params.spec,
    Boolean(params.pin),
    result.targetDir,
    result.version,
    result.npmResolution,
    defaultRuntime.log,
    theme.warn,
  );
  next = recordHookInstall(next, {
    hookId: result.hookPackId,
    ...installRecord,
    hooks: result.hooks,
  });
  await writeConfigFile(next);
  defaultRuntime.log(`Installed hook pack: ${result.hookPackId}`);
  logHookPackRestartHint();
  return { ok: true };
}

export async function runPluginInstallCommand(params: {
  raw: string;
  opts: { link?: boolean; pin?: boolean; marketplace?: string };
}) {
  const shorthand = !params.opts.marketplace
    ? await resolveMarketplaceInstallShortcut(params.raw)
    : null;
  if (shorthand?.ok === false) {
    defaultRuntime.error(shorthand.error);
    return defaultRuntime.exit(1);
  }

  const raw = shorthand?.ok ? shorthand.plugin : params.raw;
  const opts = {
    ...params.opts,
    marketplace:
      params.opts.marketplace ?? (shorthand?.ok ? shorthand.marketplaceSource : undefined),
  };

  if (opts.marketplace) {
    if (opts.link) {
      defaultRuntime.error("`--link` is not supported with `--marketplace`.");
      return defaultRuntime.exit(1);
    }
    if (opts.pin) {
      defaultRuntime.error("`--pin` is not supported with `--marketplace`.");
      return defaultRuntime.exit(1);
    }

    const cfg = loadConfig();
    const result = await installPluginFromMarketplace({
      marketplace: opts.marketplace,
      plugin: raw,
      logger: createPluginInstallLogger(),
    });
    if (!result.ok) {
      defaultRuntime.error(result.error);
      return defaultRuntime.exit(1);
    }

    clearPluginManifestRegistryCache();

    let next = enablePluginInConfig(cfg, result.pluginId).config;
    next = recordPluginInstall(next, {
      pluginId: result.pluginId,
      source: "marketplace",
      installPath: result.targetDir,
      version: result.version,
      marketplaceName: result.marketplaceName,
      marketplaceSource: result.marketplaceSource,
      marketplacePlugin: result.marketplacePlugin,
    });
    const slotResult = applySlotSelectionForPlugin(next, result.pluginId);
    next = slotResult.config;
    await writeConfigFile(next);
    logSlotWarnings(slotResult.warnings);
    defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
    defaultRuntime.log("Restart the gateway to load plugins.");
    return;
  }

  const fileSpec = resolveFileNpmSpecToLocalPath(raw);
  if (fileSpec && !fileSpec.ok) {
    defaultRuntime.error(fileSpec.error);
    return defaultRuntime.exit(1);
  }
  const normalized = fileSpec && fileSpec.ok ? fileSpec.path : raw;
  const resolved = resolveUserPath(normalized);
  const cfg = loadConfig();

  if (fs.existsSync(resolved)) {
    if (opts.link) {
      const existing = cfg.plugins?.load?.paths ?? [];
      const merged = Array.from(new Set([...existing, resolved]));
      const probe = await installPluginFromPath({ path: resolved, dryRun: true });
      if (!probe.ok) {
        const hookFallback = await tryInstallHookPackFromLocalPath({
          config: cfg,
          resolvedPath: resolved,
          link: true,
        });
        if (hookFallback.ok) {
          return;
        }
        defaultRuntime.error(
          formatPluginInstallWithHookFallbackError(probe.error, hookFallback.error),
        );
        return defaultRuntime.exit(1);
      }

      let next: OpenClawConfig = enablePluginInConfig(
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
      next = recordPluginInstall(next, {
        pluginId: probe.pluginId,
        source: "path",
        sourcePath: resolved,
        installPath: resolved,
        version: probe.version,
      });
      const slotResult = applySlotSelectionForPlugin(next, probe.pluginId);
      next = slotResult.config;
      await writeConfigFile(next);
      logSlotWarnings(slotResult.warnings);
      defaultRuntime.log(`Linked plugin path: ${shortenHomePath(resolved)}`);
      defaultRuntime.log("Restart the gateway to load plugins.");
      return;
    }

    const result = await installPluginFromPath({
      path: resolved,
      logger: createPluginInstallLogger(),
    });
    if (!result.ok) {
      const hookFallback = await tryInstallHookPackFromLocalPath({
        config: cfg,
        resolvedPath: resolved,
      });
      if (hookFallback.ok) {
        return;
      }
      defaultRuntime.error(
        formatPluginInstallWithHookFallbackError(result.error, hookFallback.error),
      );
      return defaultRuntime.exit(1);
    }
    clearPluginManifestRegistryCache();

    let next = enablePluginInConfig(cfg, result.pluginId).config;
    const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
    next = recordPluginInstall(next, {
      pluginId: result.pluginId,
      source,
      sourcePath: resolved,
      installPath: result.targetDir,
      version: result.version,
    });
    const slotResult = applySlotSelectionForPlugin(next, result.pluginId);
    next = slotResult.config;
    await writeConfigFile(next);
    logSlotWarnings(slotResult.warnings);
    defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
    defaultRuntime.log("Restart the gateway to load plugins.");
    return;
  }

  if (opts.link) {
    defaultRuntime.error("`--link` requires a local path.");
    return defaultRuntime.exit(1);
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
    defaultRuntime.error(`Path not found: ${resolved}`);
    return defaultRuntime.exit(1);
  }

  const bundledPreNpmPlan = resolveBundledInstallPlanBeforeNpm({
    rawSpec: raw,
    findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
  });
  if (bundledPreNpmPlan) {
    await installBundledPluginSource({
      config: cfg,
      rawSpec: raw,
      bundledSource: bundledPreNpmPlan.bundledSource,
      warning: bundledPreNpmPlan.warning,
    });
    return;
  }

  const clawhubSpec = parseClawHubPluginSpec(raw);
  if (clawhubSpec) {
    const result = await installPluginFromClawHub({
      spec: raw,
      logger: createPluginInstallLogger(),
    });
    if (!result.ok) {
      defaultRuntime.error(result.error);
      return defaultRuntime.exit(1);
    }

    clearPluginManifestRegistryCache();

    let next = enablePluginInConfig(cfg, result.pluginId).config;
    next = recordPluginInstall(next, {
      pluginId: result.pluginId,
      source: "clawhub",
      spec: formatClawHubSpecifier({
        name: result.clawhub.clawhubPackage,
        version: result.clawhub.version,
      }),
      installPath: result.targetDir,
      version: result.version,
      integrity: result.clawhub.integrity,
      resolvedAt: result.clawhub.resolvedAt,
      clawhubUrl: result.clawhub.clawhubUrl,
      clawhubPackage: result.clawhub.clawhubPackage,
      clawhubFamily: result.clawhub.clawhubFamily,
      clawhubChannel: result.clawhub.clawhubChannel,
    });
    const slotResult = applySlotSelectionForPlugin(next, result.pluginId);
    next = slotResult.config;
    await writeConfigFile(next);
    logSlotWarnings(slotResult.warnings);
    defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
    defaultRuntime.log("Restart the gateway to load plugins.");
    return;
  }

  const preferredClawHubSpec = buildPreferredClawHubSpec(raw);
  if (preferredClawHubSpec) {
    const clawhubResult = await installPluginFromClawHub({
      spec: preferredClawHubSpec,
      logger: createPluginInstallLogger(),
    });
    if (clawhubResult.ok) {
      clearPluginManifestRegistryCache();

      let next = enablePluginInConfig(cfg, clawhubResult.pluginId).config;
      next = recordPluginInstall(next, {
        pluginId: clawhubResult.pluginId,
        source: "clawhub",
        spec: formatClawHubSpecifier({
          name: clawhubResult.clawhub.clawhubPackage,
          version: clawhubResult.clawhub.version,
        }),
        installPath: clawhubResult.targetDir,
        version: clawhubResult.version,
        integrity: clawhubResult.clawhub.integrity,
        resolvedAt: clawhubResult.clawhub.resolvedAt,
        clawhubUrl: clawhubResult.clawhub.clawhubUrl,
        clawhubPackage: clawhubResult.clawhub.clawhubPackage,
        clawhubFamily: clawhubResult.clawhub.clawhubFamily,
        clawhubChannel: clawhubResult.clawhub.clawhubChannel,
      });
      const slotResult = applySlotSelectionForPlugin(next, clawhubResult.pluginId);
      next = slotResult.config;
      await writeConfigFile(next);
      logSlotWarnings(slotResult.warnings);
      defaultRuntime.log(`Installed plugin: ${clawhubResult.pluginId}`);
      defaultRuntime.log("Restart the gateway to load plugins.");
      return;
    }
    if (!shouldFallbackFromClawHubToNpm(clawhubResult.error)) {
      defaultRuntime.error(clawhubResult.error);
      return defaultRuntime.exit(1);
    }
  }

  const result = await installPluginFromNpmSpec({
    spec: raw,
    logger: createPluginInstallLogger(),
  });
  if (!result.ok) {
    const bundledFallbackPlan = resolveBundledInstallPlanForNpmFailure({
      rawSpec: raw,
      code: result.code,
      findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
    });
    if (!bundledFallbackPlan) {
      const hookFallback = await tryInstallHookPackFromNpmSpec({
        config: cfg,
        spec: raw,
        pin: opts.pin,
      });
      if (hookFallback.ok) {
        return;
      }
      defaultRuntime.error(
        formatPluginInstallWithHookFallbackError(result.error, hookFallback.error),
      );
      return defaultRuntime.exit(1);
    }

    await installBundledPluginSource({
      config: cfg,
      rawSpec: raw,
      bundledSource: bundledFallbackPlan.bundledSource,
      warning: bundledFallbackPlan.warning,
    });
    return;
  }
  clearPluginManifestRegistryCache();

  let next = enablePluginInConfig(cfg, result.pluginId).config;
  const installRecord = resolvePinnedNpmInstallRecordForCli(
    raw,
    Boolean(opts.pin),
    result.targetDir,
    result.version,
    result.npmResolution,
    defaultRuntime.log,
    theme.warn,
  );
  next = recordPluginInstall(next, {
    pluginId: result.pluginId,
    ...installRecord,
  });
  const slotResult = applySlotSelectionForPlugin(next, result.pluginId);
  next = slotResult.config;
  await writeConfigFile(next);
  logSlotWarnings(slotResult.warnings);
  defaultRuntime.log(`Installed plugin: ${result.pluginId}`);
  defaultRuntime.log("Restart the gateway to load plugins.");
}
