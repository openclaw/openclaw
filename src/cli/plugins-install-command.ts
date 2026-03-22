import fs from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { installHooksFromNpmSpec, installHooksFromPath } from "../hooks/install.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { parseClawHubPluginSpec } from "../infra/clawhub.js";
import { type BundledPluginSource, findBundledPluginSource } from "../plugins/bundled-sources.js";
import { formatClawHubSpecifier, installPluginFromClawHub } from "../plugins/clawhub.js";
import { installPluginFromNpmSpec, installPluginFromPath } from "../plugins/install.js";
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
  buildPreferredClawHubSpec,
  createHookPackInstallLogger,
  createPluginInstallLogger,
  formatPluginInstallWithHookFallbackError,
  resolveFileNpmSpecToLocalPath,
  shouldFallbackFromClawHubToNpm,
} from "./plugins-command-helpers.js";
import { persistHookPackInstall, persistPluginInstall } from "./plugins-install-persist.js";

async function installBundledPluginSource(params: {
  config: OpenClawConfig;
  rawSpec: string;
  bundledSource: BundledPluginSource;
  warning: string;
}) {
  const existing = params.config.plugins?.load?.paths ?? [];
  const mergedPaths = Array.from(new Set([...existing, params.bundledSource.localPath]));
  await persistPluginInstall({
    config: {
      ...params.config,
      plugins: {
        ...params.config.plugins,
        load: {
          ...params.config.plugins?.load,
          paths: mergedPaths,
        },
      },
    },
    pluginId: params.bundledSource.pluginId,
    install: {
      source: "path",
      spec: params.rawSpec,
      sourcePath: params.bundledSource.localPath,
      installPath: params.bundledSource.localPath,
    },
    warningMessage: params.warning,
  });
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
    await persistHookPackInstall({
      config: {
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
      },
      hookPackId: probe.hookPackId,
      hooks: probe.hooks,
      install: {
        source: "path",
        sourcePath: params.resolvedPath,
        installPath: params.resolvedPath,
        version: probe.version,
      },
      successMessage: `Linked hook pack path: ${shortenHomePath(params.resolvedPath)}`,
    });
    return { ok: true };
  }

  const result = await installHooksFromPath({
    path: params.resolvedPath,
    logger: createHookPackInstallLogger(),
  });
  if (!result.ok) {
    return result;
  }

  const source: "archive" | "path" = resolveArchiveKind(params.resolvedPath) ? "archive" : "path";
  await persistHookPackInstall({
    config: params.config,
    hookPackId: result.hookPackId,
    hooks: result.hooks,
    install: {
      source,
      sourcePath: params.resolvedPath,
      installPath: result.targetDir,
      version: result.version,
    },
  });
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

  const installRecord = resolvePinnedNpmInstallRecordForCli(
    params.spec,
    Boolean(params.pin),
    result.targetDir,
    result.version,
    result.npmResolution,
    defaultRuntime.log,
    theme.warn,
  );
  await persistHookPackInstall({
    config: params.config,
    hookPackId: result.hookPackId,
    hooks: result.hooks,
    install: installRecord,
  });
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
    await persistPluginInstall({
      config: cfg,
      pluginId: result.pluginId,
      install: {
        source: "marketplace",
        installPath: result.targetDir,
        version: result.version,
        marketplaceName: result.marketplaceName,
        marketplaceSource: result.marketplaceSource,
        marketplacePlugin: result.marketplacePlugin,
      },
    });
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

      await persistPluginInstall({
        config: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            load: {
              ...cfg.plugins?.load,
              paths: merged,
            },
          },
        },
        pluginId: probe.pluginId,
        install: {
          source: "path",
          sourcePath: resolved,
          installPath: resolved,
          version: probe.version,
        },
        successMessage: `Linked plugin path: ${shortenHomePath(resolved)}`,
      });
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
    const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
    await persistPluginInstall({
      config: cfg,
      pluginId: result.pluginId,
      install: {
        source,
        sourcePath: resolved,
        installPath: result.targetDir,
        version: result.version,
      },
    });
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
    await persistPluginInstall({
      config: cfg,
      pluginId: result.pluginId,
      install: {
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
      },
    });
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
      await persistPluginInstall({
        config: cfg,
        pluginId: clawhubResult.pluginId,
        install: {
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
        },
      });
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
  const installRecord = resolvePinnedNpmInstallRecordForCli(
    raw,
    Boolean(opts.pin),
    result.targetDir,
    result.version,
    result.npmResolution,
    defaultRuntime.log,
    theme.warn,
  );
  await persistPluginInstall({
    config: cfg,
    pluginId: result.pluginId,
    install: installRecord,
  });
}
