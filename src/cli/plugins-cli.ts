import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  installHooksFromNpmSpec,
  installHooksFromPath,
  resolveHookInstallDir,
} from "../hooks/install.js";
import { recordHookInstall } from "../hooks/installs.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { parseClawHubPluginSpec } from "../infra/clawhub.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { type BundledPluginSource, findBundledPluginSource } from "../plugins/bundled-sources.js";
import { formatClawHubSpecifier, installPluginFromClawHub } from "../plugins/clawhub.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { installPluginFromNpmSpec, installPluginFromPath } from "../plugins/install.js";
import { recordPluginInstall } from "../plugins/installs.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import {
  installPluginFromMarketplace,
  listMarketplacePlugins,
  resolveMarketplaceInstallShortcut,
} from "../plugins/marketplace.js";
import type { PluginRecord } from "../plugins/registry.js";
import { applyExclusiveSlotSelection } from "../plugins/slots.js";
import { resolvePluginSourceRoots, formatPluginSourceForTable } from "../plugins/source-display.js";
import {
  buildAllPluginInspectReports,
  buildPluginCompatibilityNotices,
  buildPluginInspectReport,
  buildPluginStatusReport,
  formatPluginCompatibilityNotice,
} from "../plugins/status.js";
import { resolveUninstallDirectoryTarget, uninstallPlugin } from "../plugins/uninstall.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { resolveUserPath, shortenHomeInString, shortenHomePath } from "../utils.js";
import { looksLikeLocalInstallSpec } from "./install-spec.js";
import { resolvePinnedNpmInstallRecordForCli } from "./npm-resolution.js";
import {
  resolveBundledInstallPlanBeforeNpm,
  resolveBundledInstallPlanForNpmFailure,
} from "./plugin-install-plan.js";
import { setPluginEnabledInConfig } from "./plugins-config.js";
import { promptYesNo } from "./prompt.js";

export type PluginsListOptions = {
  json?: boolean;
  enabled?: boolean;
  verbose?: boolean;
};

export type PluginInspectOptions = {
  json?: boolean;
  all?: boolean;
};

export type PluginUpdateOptions = {
  all?: boolean;
  dryRun?: boolean;
};

export type PluginMarketplaceListOptions = {
  json?: boolean;
};

export type PluginUninstallOptions = {
  keepFiles?: boolean;
  keepConfig?: boolean;
  force?: boolean;
  dryRun?: boolean;
};

type HookInternalEntryLike = Record<string, unknown> & { enabled?: boolean };

type HookPackUpdateOutcome = {
  hookId: string;
  status: "updated" | "unchanged" | "skipped" | "error";
  message: string;
  currentVersion?: string;
  nextVersion?: string;
};

type HookPackUpdateSummary = {
  config: OpenClawConfig;
  changed: boolean;
  outcomes: HookPackUpdateOutcome[];
};

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
    // file:///abs/path -> /abs/path
    return { ok: true, path: rest.slice(2) };
  }
  if (rest.startsWith("//localhost/")) {
    // file://localhost/abs/path -> /abs/path
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

function formatPluginLine(plugin: PluginRecord, verbose = false): string {
  const status =
    plugin.status === "loaded"
      ? theme.success("loaded")
      : plugin.status === "disabled"
        ? theme.warn("disabled")
        : theme.error("error");
  const name = theme.command(plugin.name || plugin.id);
  const idSuffix = plugin.name && plugin.name !== plugin.id ? theme.muted(` (${plugin.id})`) : "";
  const desc = plugin.description
    ? theme.muted(
        plugin.description.length > 60
          ? `${plugin.description.slice(0, 57)}...`
          : plugin.description,
      )
    : theme.muted("(no description)");
  const format = plugin.format ?? "openclaw";

  if (!verbose) {
    return `${name}${idSuffix} ${status} ${theme.muted(`[${format}]`)} - ${desc}`;
  }

  const parts = [
    `${name}${idSuffix} ${status}`,
    `  format: ${format}`,
    `  source: ${theme.muted(shortenHomeInString(plugin.source))}`,
    `  origin: ${plugin.origin}`,
  ];
  if (plugin.bundleFormat) {
    parts.push(`  bundle format: ${plugin.bundleFormat}`);
  }
  if (plugin.version) {
    parts.push(`  version: ${plugin.version}`);
  }
  if (plugin.providerIds.length > 0) {
    parts.push(`  providers: ${plugin.providerIds.join(", ")}`);
  }
  if (plugin.error) {
    parts.push(theme.error(`  error: ${plugin.error}`));
  }
  return parts.join("\n");
}

function formatInspectSection(title: string, lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }
  return ["", theme.muted(`${title}:`), ...lines];
}

function formatCapabilityKinds(
  capabilities: Array<{
    kind: string;
  }>,
): string {
  if (capabilities.length === 0) {
    return "-";
  }
  return capabilities.map((entry) => entry.kind).join(", ");
}

function formatHookSummary(params: {
  usesLegacyBeforeAgentStart: boolean;
  typedHookCount: number;
  customHookCount: number;
}): string {
  const parts: string[] = [];
  if (params.usesLegacyBeforeAgentStart) {
    parts.push("before_agent_start");
  }
  const nonLegacyTypedHookCount =
    params.typedHookCount - (params.usesLegacyBeforeAgentStart ? 1 : 0);
  if (nonLegacyTypedHookCount > 0) {
    parts.push(`${nonLegacyTypedHookCount} typed`);
  }
  if (params.customHookCount > 0) {
    parts.push(`${params.customHookCount} custom`);
  }
  return parts.length > 0 ? parts.join(", ") : "-";
}

function formatInstallLines(install: PluginInstallRecord | undefined): string[] {
  if (!install) {
    return [];
  }
  const lines = [`Source: ${install.source}`];
  if (install.spec) {
    lines.push(`Spec: ${install.spec}`);
  }
  if (install.sourcePath) {
    lines.push(`Source path: ${shortenHomePath(install.sourcePath)}`);
  }
  if (install.installPath) {
    lines.push(`Install path: ${shortenHomePath(install.installPath)}`);
  }
  if (install.version) {
    lines.push(`Recorded version: ${install.version}`);
  }
  if (install.installedAt) {
    lines.push(`Installed at: ${install.installedAt}`);
  }
  return lines;
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

function createPluginInstallLogger(): { info: (msg: string) => void; warn: (msg: string) => void } {
  return {
    info: (msg) => defaultRuntime.log(msg),
    warn: (msg) => defaultRuntime.log(theme.warn(msg)),
  };
}

function createHookPackInstallLogger(): {
  info: (msg: string) => void;
  warn: (msg: string) => void;
} {
  return {
    info: (msg) => defaultRuntime.log(msg),
    warn: (msg) => defaultRuntime.log(theme.warn(msg)),
  };
}

function enableInternalHookEntries(config: OpenClawConfig, hookNames: string[]): OpenClawConfig {
  const entries = { ...config.hooks?.internal?.entries } as Record<string, HookInternalEntryLike>;

  for (const hookName of hookNames) {
    entries[hookName] = {
      ...entries[hookName],
      enabled: true,
    };
  }

  return {
    ...config,
    hooks: {
      ...config.hooks,
      internal: {
        ...config.hooks?.internal,
        enabled: true,
        entries,
      },
    },
  };
}

function extractInstalledNpmPackageName(install: PluginInstallRecord): string | undefined {
  if (install.source !== "npm") {
    return undefined;
  }
  const resolvedName = install.resolvedName?.trim();
  if (resolvedName) {
    return resolvedName;
  }
  return (
    (install.spec ? parseRegistryNpmSpec(install.spec)?.name : undefined) ??
    (install.resolvedSpec ? parseRegistryNpmSpec(install.resolvedSpec)?.name : undefined)
  );
}

function extractInstalledNpmHookPackageName(install: HookInstallRecord): string | undefined {
  const resolvedName = install.resolvedName?.trim();
  if (resolvedName) {
    return resolvedName;
  }
  return (
    (install.spec ? parseRegistryNpmSpec(install.spec)?.name : undefined) ??
    (install.resolvedSpec ? parseRegistryNpmSpec(install.resolvedSpec)?.name : undefined)
  );
}

function resolvePluginUpdateSelection(params: {
  installs: Record<string, PluginInstallRecord>;
  rawId?: string;
  all?: boolean;
}): { pluginIds: string[]; specOverrides?: Record<string, string> } {
  if (params.all) {
    return { pluginIds: Object.keys(params.installs) };
  }
  if (!params.rawId) {
    return { pluginIds: [] };
  }

  const parsedSpec = parseRegistryNpmSpec(params.rawId);
  if (!parsedSpec || parsedSpec.selectorKind === "none") {
    return { pluginIds: [params.rawId] };
  }

  const matches = Object.entries(params.installs).filter(([, install]) => {
    return extractInstalledNpmPackageName(install) === parsedSpec.name;
  });
  if (matches.length !== 1) {
    return { pluginIds: [params.rawId] };
  }

  const [pluginId] = matches[0];
  if (!pluginId) {
    return { pluginIds: [params.rawId] };
  }
  return {
    pluginIds: [pluginId],
    specOverrides: {
      [pluginId]: parsedSpec.raw,
    },
  };
}

function resolveHookPackUpdateSelection(params: {
  installs: Record<string, HookInstallRecord>;
  rawId?: string;
  all?: boolean;
}): { hookIds: string[]; specOverrides?: Record<string, string> } {
  if (params.all) {
    return { hookIds: Object.keys(params.installs) };
  }
  if (!params.rawId) {
    return { hookIds: [] };
  }
  if (params.rawId in params.installs) {
    return { hookIds: [params.rawId] };
  }

  const parsedSpec = parseRegistryNpmSpec(params.rawId);
  if (!parsedSpec || parsedSpec.selectorKind === "none") {
    return { hookIds: [] };
  }

  const matches = Object.entries(params.installs).filter(([, install]) => {
    return extractInstalledNpmHookPackageName(install) === parsedSpec.name;
  });
  if (matches.length !== 1) {
    return { hookIds: [] };
  }

  const [hookId] = matches[0];
  if (!hookId) {
    return { hookIds: [] };
  }
  return {
    hookIds: [hookId],
    specOverrides: {
      [hookId]: parsedSpec.raw,
    },
  };
}

function formatPluginInstallWithHookFallbackError(pluginError: string, hookError: string): string {
  return `${pluginError}\nAlso not a valid hook pack: ${hookError}`;
}

function logHookPackRestartHint() {
  defaultRuntime.log("Restart the gateway to load hooks.");
}

async function readInstalledPackageVersion(dir: string): Promise<string | undefined> {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function logSlotWarnings(warnings: string[]) {
  if (warnings.length === 0) {
    return;
  }
  for (const warning of warnings) {
    defaultRuntime.log(theme.warn(warning));
  }
}

function buildPreferredClawHubSpec(raw: string): string | null {
  const parsed = parseRegistryNpmSpec(raw);
  if (!parsed) {
    return null;
  }
  return formatClawHubSpecifier({
    name: parsed.name,
    version: parsed.selector,
  });
}

function shouldFallbackFromClawHubToNpm(error: string): boolean {
  const normalized = error.trim();
  return (
    /Package not found on ClawHub/i.test(normalized) ||
    /ClawHub .* failed \(404\)/i.test(normalized) ||
    /Version not found/i.test(normalized)
  );
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

async function updateTrackedHookPacks(params: {
  config: OpenClawConfig;
  hookIds?: string[];
  dryRun?: boolean;
  specOverrides?: Record<string, string>;
}): Promise<HookPackUpdateSummary> {
  const installs = params.config.hooks?.internal?.installs ?? {};
  const targets = params.hookIds?.length ? params.hookIds : Object.keys(installs);
  const outcomes: HookPackUpdateOutcome[] = [];
  let next = params.config;
  let changed = false;

  for (const hookId of targets) {
    const record = installs[hookId];
    if (!record) {
      outcomes.push({
        hookId,
        status: "skipped",
        message: `No install record for hook pack "${hookId}".`,
      });
      continue;
    }
    if (record.source !== "npm") {
      outcomes.push({
        hookId,
        status: "skipped",
        message: `Skipping hook pack "${hookId}" (source: ${record.source}).`,
      });
      continue;
    }

    const effectiveSpec = params.specOverrides?.[hookId] ?? record.spec;
    if (!effectiveSpec) {
      outcomes.push({
        hookId,
        status: "skipped",
        message: `Skipping hook pack "${hookId}" (missing npm spec).`,
      });
      continue;
    }

    let installPath: string;
    try {
      installPath = record.installPath ?? resolveHookInstallDir(hookId);
    } catch (err) {
      outcomes.push({
        hookId,
        status: "error",
        message: `Invalid install path for hook pack "${hookId}": ${String(err)}`,
      });
      continue;
    }
    const currentVersion = await readInstalledPackageVersion(installPath);

    const onIntegrityDrift = async (drift: {
      spec: string;
      expectedIntegrity: string;
      actualIntegrity: string;
      resolution: { resolvedSpec?: string };
    }) => {
      const specLabel = drift.resolution.resolvedSpec ?? drift.spec;
      defaultRuntime.log(
        theme.warn(
          `Integrity drift detected for hook pack "${hookId}" (${specLabel})` +
            `\nExpected: ${drift.expectedIntegrity}` +
            `\nActual:   ${drift.actualIntegrity}`,
        ),
      );
      if (params.dryRun) {
        return true;
      }
      return await promptYesNo(`Continue updating hook pack "${hookId}" with this artifact?`);
    };

    const result = params.dryRun
      ? await installHooksFromNpmSpec({
          spec: effectiveSpec,
          mode: "update",
          dryRun: true,
          expectedHookPackId: hookId,
          expectedIntegrity: record.integrity,
          onIntegrityDrift,
          logger: createHookPackInstallLogger(),
        })
      : await installHooksFromNpmSpec({
          spec: effectiveSpec,
          mode: "update",
          expectedHookPackId: hookId,
          expectedIntegrity: record.integrity,
          onIntegrityDrift,
          logger: createHookPackInstallLogger(),
        });

    if (!result.ok) {
      outcomes.push({
        hookId,
        status: "error",
        message: `Failed to ${params.dryRun ? "check" : "update"} hook pack "${hookId}": ${result.error}`,
      });
      continue;
    }

    const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
    const currentLabel = currentVersion ?? "unknown";
    const nextLabel = nextVersion ?? "unknown";

    if (params.dryRun) {
      outcomes.push({
        hookId,
        status:
          currentVersion && nextVersion && currentVersion === nextVersion ? "unchanged" : "updated",
        currentVersion: currentVersion ?? undefined,
        nextVersion: nextVersion ?? undefined,
        message:
          currentVersion && nextVersion && currentVersion === nextVersion
            ? `Hook pack "${hookId}" is up to date (${currentLabel}).`
            : `Would update hook pack "${hookId}": ${currentLabel} -> ${nextLabel}.`,
      });
      continue;
    }

    next = recordHookInstall(next, {
      hookId,
      source: "npm",
      spec: effectiveSpec,
      installPath: result.targetDir,
      version: nextVersion,
      resolvedName: result.npmResolution?.name,
      resolvedSpec: result.npmResolution?.resolvedSpec,
      integrity: result.npmResolution?.integrity,
      hooks: result.hooks,
    });
    changed = true;

    outcomes.push({
      hookId,
      status:
        currentVersion && nextVersion && currentVersion === nextVersion ? "unchanged" : "updated",
      currentVersion: currentVersion ?? undefined,
      nextVersion: nextVersion ?? undefined,
      message:
        currentVersion && nextVersion && currentVersion === nextVersion
          ? `Hook pack "${hookId}" already at ${currentLabel}.`
          : `Updated hook pack "${hookId}": ${currentLabel} -> ${nextLabel}.`,
    });
  }

  return { config: next, changed, outcomes };
}
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
  defaultRuntime.log(`Restart the gateway to load plugins.`);
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
    defaultRuntime.log(`Restart the gateway to load plugins.`);
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
      defaultRuntime.log(`Restart the gateway to load plugins.`);
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
    // Plugin CLI registrars may have warmed the manifest registry cache before install;
    // force a rescan so config validation sees the freshly installed plugin.
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
    defaultRuntime.log(`Restart the gateway to load plugins.`);
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
    defaultRuntime.log(`Restart the gateway to load plugins.`);
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
      defaultRuntime.log(`Restart the gateway to load plugins.`);
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
  // Ensure config validation sees newly installed plugin(s) even if the cache was warmed at startup.
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
  defaultRuntime.log(`Restart the gateway to load plugins.`);
}

export async function runPluginUpdateCommand(params: { id?: string; opts: PluginUpdateOptions }) {
  const cfg = loadConfig();
  const pluginSelection = resolvePluginUpdateSelection({
    installs: cfg.plugins?.installs ?? {},
    rawId: params.id,
    all: params.opts.all,
  });
  const hookSelection = resolveHookPackUpdateSelection({
    installs: cfg.hooks?.internal?.installs ?? {},
    rawId: params.id,
    all: params.opts.all,
  });

  if (pluginSelection.pluginIds.length === 0 && hookSelection.hookIds.length === 0) {
    if (params.opts.all) {
      defaultRuntime.log("No tracked plugins or hook packs to update.");
      return;
    }
    defaultRuntime.error("Provide a plugin or hook-pack id, or use --all.");
    return defaultRuntime.exit(1);
  }

  const pluginResult = await updateNpmInstalledPlugins({
    config: cfg,
    pluginIds: pluginSelection.pluginIds,
    specOverrides: pluginSelection.specOverrides,
    dryRun: params.opts.dryRun,
    logger: {
      info: (msg) => defaultRuntime.log(msg),
      warn: (msg) => defaultRuntime.log(theme.warn(msg)),
    },
    onIntegrityDrift: async (drift) => {
      const specLabel = drift.resolvedSpec ?? drift.spec;
      defaultRuntime.log(
        theme.warn(
          `Integrity drift detected for "${drift.pluginId}" (${specLabel})` +
            `\nExpected: ${drift.expectedIntegrity}` +
            `\nActual:   ${drift.actualIntegrity}`,
        ),
      );
      if (drift.dryRun) {
        return true;
      }
      return await promptYesNo(`Continue updating "${drift.pluginId}" with this artifact?`);
    },
  });
  const hookResult = await updateTrackedHookPacks({
    config: pluginResult.config,
    hookIds: hookSelection.hookIds,
    specOverrides: hookSelection.specOverrides,
    dryRun: params.opts.dryRun,
  });

  for (const outcome of pluginResult.outcomes) {
    if (outcome.status === "error") {
      defaultRuntime.log(theme.error(outcome.message));
      continue;
    }
    if (outcome.status === "skipped") {
      defaultRuntime.log(theme.warn(outcome.message));
      continue;
    }
    defaultRuntime.log(outcome.message);
  }

  for (const outcome of hookResult.outcomes) {
    if (outcome.status === "error") {
      defaultRuntime.log(theme.error(outcome.message));
      continue;
    }
    if (outcome.status === "skipped") {
      defaultRuntime.log(theme.warn(outcome.message));
      continue;
    }
    defaultRuntime.log(outcome.message);
  }

  if (!params.opts.dryRun && (pluginResult.changed || hookResult.changed)) {
    await writeConfigFile(hookResult.config);
    defaultRuntime.log("Restart the gateway to load plugins and hooks.");
  }
}

export function registerPluginsCli(program: Command) {
  const plugins = program
    .command("plugins")
    .description("Manage OpenClaw plugins and extensions")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/plugins", "docs.openclaw.ai/cli/plugins")}\n`,
    );

  plugins
    .command("list")
    .description("List discovered plugins")
    .option("--json", "Print JSON")
    .option("--enabled", "Only show enabled plugins", false)
    .option("--verbose", "Show detailed entries", false)
    .action((opts: PluginsListOptions) => {
      const report = buildPluginStatusReport();
      const list = opts.enabled
        ? report.plugins.filter((p) => p.status === "loaded")
        : report.plugins;

      if (opts.json) {
        const payload = {
          workspaceDir: report.workspaceDir,
          plugins: list,
          diagnostics: report.diagnostics,
        };
        defaultRuntime.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (list.length === 0) {
        defaultRuntime.log(theme.muted("No plugins found."));
        return;
      }

      const loaded = list.filter((p) => p.status === "loaded").length;
      defaultRuntime.log(
        `${theme.heading("Plugins")} ${theme.muted(`(${loaded}/${list.length} loaded)`)}`,
      );

      if (!opts.verbose) {
        const tableWidth = getTerminalTableWidth();
        const sourceRoots = resolvePluginSourceRoots({
          workspaceDir: report.workspaceDir,
        });
        const usedRoots = new Set<keyof typeof sourceRoots>();
        const rows = list.map((plugin) => {
          const desc = plugin.description ? theme.muted(plugin.description) : "";
          const formattedSource = formatPluginSourceForTable(plugin, sourceRoots);
          if (formattedSource.rootKey) {
            usedRoots.add(formattedSource.rootKey);
          }
          const sourceLine = desc ? `${formattedSource.value}\n${desc}` : formattedSource.value;
          return {
            Name: plugin.name || plugin.id,
            ID: plugin.name && plugin.name !== plugin.id ? plugin.id : "",
            Format: plugin.format ?? "openclaw",
            Status:
              plugin.status === "loaded"
                ? theme.success("loaded")
                : plugin.status === "disabled"
                  ? theme.warn("disabled")
                  : theme.error("error"),
            Source: sourceLine,
            Version: plugin.version ?? "",
          };
        });

        if (usedRoots.size > 0) {
          defaultRuntime.log(theme.muted("Source roots:"));
          for (const key of ["stock", "workspace", "global"] as const) {
            if (!usedRoots.has(key)) {
              continue;
            }
            const dir = sourceRoots[key];
            if (!dir) {
              continue;
            }
            defaultRuntime.log(`  ${theme.command(`${key}:`)} ${theme.muted(dir)}`);
          }
          defaultRuntime.log("");
        }

        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Name", header: "Name", minWidth: 14, flex: true },
              { key: "ID", header: "ID", minWidth: 10, flex: true },
              { key: "Format", header: "Format", minWidth: 9 },
              { key: "Status", header: "Status", minWidth: 10 },
              { key: "Source", header: "Source", minWidth: 26, flex: true },
              { key: "Version", header: "Version", minWidth: 8 },
            ],
            rows,
          }).trimEnd(),
        );
        return;
      }

      const lines: string[] = [];
      for (const plugin of list) {
        lines.push(formatPluginLine(plugin, true));
        lines.push("");
      }
      defaultRuntime.log(lines.join("\n").trim());
    });

  plugins
    .command("inspect")
    .alias("info")
    .description("Inspect plugin details")
    .argument("[id]", "Plugin id")
    .option("--all", "Inspect all plugins")
    .option("--json", "Print JSON")
    .action((id: string | undefined, opts: PluginInspectOptions) => {
      const cfg = loadConfig();
      const report = buildPluginStatusReport({ config: cfg });
      if (opts.all) {
        if (id) {
          defaultRuntime.error("Pass either a plugin id or --all, not both.");
          return defaultRuntime.exit(1);
        }
        const inspectAll = buildAllPluginInspectReports({
          config: cfg,
          report,
        });
        const inspectAllWithInstall = inspectAll.map((inspect) => ({
          ...inspect,
          install: cfg.plugins?.installs?.[inspect.plugin.id],
        }));

        if (opts.json) {
          defaultRuntime.log(JSON.stringify(inspectAllWithInstall, null, 2));
          return;
        }

        const tableWidth = getTerminalTableWidth();
        const rows = inspectAll.map((inspect) => ({
          Name: inspect.plugin.name || inspect.plugin.id,
          ID:
            inspect.plugin.name && inspect.plugin.name !== inspect.plugin.id
              ? inspect.plugin.id
              : "",
          Status:
            inspect.plugin.status === "loaded"
              ? theme.success("loaded")
              : inspect.plugin.status === "disabled"
                ? theme.warn("disabled")
                : theme.error("error"),
          Shape: inspect.shape,
          Capabilities: formatCapabilityKinds(inspect.capabilities),
          Compatibility:
            inspect.compatibility.length > 0
              ? inspect.compatibility
                  .map((entry) => (entry.severity === "warn" ? `warn:${entry.code}` : entry.code))
                  .join(", ")
              : "none",
          Bundle:
            inspect.bundleCapabilities.length > 0 ? inspect.bundleCapabilities.join(", ") : "-",
          Hooks: formatHookSummary({
            usesLegacyBeforeAgentStart: inspect.usesLegacyBeforeAgentStart,
            typedHookCount: inspect.typedHooks.length,
            customHookCount: inspect.customHooks.length,
          }),
        }));
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Name", header: "Name", minWidth: 14, flex: true },
              { key: "ID", header: "ID", minWidth: 10, flex: true },
              { key: "Status", header: "Status", minWidth: 10 },
              { key: "Shape", header: "Shape", minWidth: 18 },
              { key: "Capabilities", header: "Capabilities", minWidth: 28, flex: true },
              { key: "Compatibility", header: "Compatibility", minWidth: 24, flex: true },
              { key: "Bundle", header: "Bundle", minWidth: 14, flex: true },
              { key: "Hooks", header: "Hooks", minWidth: 20, flex: true },
            ],
            rows,
          }).trimEnd(),
        );
        return;
      }

      if (!id) {
        defaultRuntime.error("Provide a plugin id or use --all.");
        return defaultRuntime.exit(1);
      }

      const inspect = buildPluginInspectReport({
        id,
        config: cfg,
        report,
      });
      if (!inspect) {
        defaultRuntime.error(`Plugin not found: ${id}`);
        return defaultRuntime.exit(1);
      }
      const install = cfg.plugins?.installs?.[inspect.plugin.id];

      if (opts.json) {
        defaultRuntime.log(
          JSON.stringify(
            {
              ...inspect,
              install,
            },
            null,
            2,
          ),
        );
        return;
      }

      const lines: string[] = [];
      lines.push(theme.heading(inspect.plugin.name || inspect.plugin.id));
      if (inspect.plugin.name && inspect.plugin.name !== inspect.plugin.id) {
        lines.push(theme.muted(`id: ${inspect.plugin.id}`));
      }
      if (inspect.plugin.description) {
        lines.push(inspect.plugin.description);
      }
      lines.push("");
      lines.push(`${theme.muted("Status:")} ${inspect.plugin.status}`);
      lines.push(`${theme.muted("Format:")} ${inspect.plugin.format ?? "openclaw"}`);
      if (inspect.plugin.bundleFormat) {
        lines.push(`${theme.muted("Bundle format:")} ${inspect.plugin.bundleFormat}`);
      }
      lines.push(`${theme.muted("Source:")} ${shortenHomeInString(inspect.plugin.source)}`);
      lines.push(`${theme.muted("Origin:")} ${inspect.plugin.origin}`);
      if (inspect.plugin.version) {
        lines.push(`${theme.muted("Version:")} ${inspect.plugin.version}`);
      }
      lines.push(`${theme.muted("Shape:")} ${inspect.shape}`);
      lines.push(`${theme.muted("Capability mode:")} ${inspect.capabilityMode}`);
      lines.push(
        `${theme.muted("Legacy before_agent_start:")} ${inspect.usesLegacyBeforeAgentStart ? "yes" : "no"}`,
      );
      if (inspect.bundleCapabilities.length > 0) {
        lines.push(
          `${theme.muted("Bundle capabilities:")} ${inspect.bundleCapabilities.join(", ")}`,
        );
      }
      lines.push(
        ...formatInspectSection(
          "Capabilities",
          inspect.capabilities.map(
            (entry) =>
              `${entry.kind}: ${entry.ids.length > 0 ? entry.ids.join(", ") : "(registered)"}`,
          ),
        ),
      );
      lines.push(
        ...formatInspectSection(
          "Typed hooks",
          inspect.typedHooks.map((entry) =>
            entry.priority == null ? entry.name : `${entry.name} (priority ${entry.priority})`,
          ),
        ),
      );
      lines.push(
        ...formatInspectSection(
          "Compatibility warnings",
          inspect.compatibility.map(formatPluginCompatibilityNotice),
        ),
      );
      lines.push(
        ...formatInspectSection(
          "Custom hooks",
          inspect.customHooks.map((entry) => `${entry.name}: ${entry.events.join(", ")}`),
        ),
      );
      lines.push(
        ...formatInspectSection(
          "Tools",
          inspect.tools.map((entry) => {
            const names = entry.names.length > 0 ? entry.names.join(", ") : "(anonymous)";
            return entry.optional ? `${names} [optional]` : names;
          }),
        ),
      );
      lines.push(...formatInspectSection("Commands", inspect.commands));
      lines.push(...formatInspectSection("CLI commands", inspect.cliCommands));
      lines.push(...formatInspectSection("Services", inspect.services));
      lines.push(...formatInspectSection("Gateway methods", inspect.gatewayMethods));
      lines.push(
        ...formatInspectSection(
          "MCP servers",
          inspect.mcpServers.map((entry) =>
            entry.hasStdioTransport ? entry.name : `${entry.name} (unsupported transport)`,
          ),
        ),
      );
      lines.push(
        ...formatInspectSection(
          "LSP servers",
          inspect.lspServers.map((entry) =>
            entry.hasStdioTransport ? entry.name : `${entry.name} (unsupported transport)`,
          ),
        ),
      );
      if (inspect.httpRouteCount > 0) {
        lines.push(...formatInspectSection("HTTP routes", [String(inspect.httpRouteCount)]));
      }
      const policyLines: string[] = [];
      if (typeof inspect.policy.allowPromptInjection === "boolean") {
        policyLines.push(`allowPromptInjection: ${inspect.policy.allowPromptInjection}`);
      }
      if (typeof inspect.policy.allowModelOverride === "boolean") {
        policyLines.push(`allowModelOverride: ${inspect.policy.allowModelOverride}`);
      }
      if (inspect.policy.hasAllowedModelsConfig) {
        policyLines.push(
          `allowedModels: ${
            inspect.policy.allowedModels.length > 0
              ? inspect.policy.allowedModels.join(", ")
              : "(configured but empty)"
          }`,
        );
      }
      lines.push(...formatInspectSection("Policy", policyLines));
      lines.push(
        ...formatInspectSection(
          "Diagnostics",
          inspect.diagnostics.map((entry) => `${entry.level.toUpperCase()}: ${entry.message}`),
        ),
      );
      lines.push(...formatInspectSection("Install", formatInstallLines(install)));
      if (inspect.plugin.error) {
        lines.push("", `${theme.error("Error:")} ${inspect.plugin.error}`);
      }
      defaultRuntime.log(lines.join("\n"));
    });

  plugins
    .command("enable")
    .description("Enable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      const enableResult = enablePluginInConfig(cfg, id);
      let next: OpenClawConfig = enableResult.config;
      const slotResult = applySlotSelectionForPlugin(next, id);
      next = slotResult.config;
      await writeConfigFile(next);
      logSlotWarnings(slotResult.warnings);
      if (enableResult.enabled) {
        defaultRuntime.log(`Enabled plugin "${id}". Restart the gateway to apply.`);
        return;
      }
      defaultRuntime.log(
        theme.warn(
          `Plugin "${id}" could not be enabled (${enableResult.reason ?? "unknown reason"}).`,
        ),
      );
    });

  plugins
    .command("disable")
    .description("Disable a plugin in config")
    .argument("<id>", "Plugin id")
    .action(async (id: string) => {
      const cfg = loadConfig();
      const next = setPluginEnabledInConfig(cfg, id, false);
      await writeConfigFile(next);
      defaultRuntime.log(`Disabled plugin "${id}". Restart the gateway to apply.`);
    });

  plugins
    .command("uninstall")
    .description("Uninstall a plugin")
    .argument("<id>", "Plugin id")
    .option("--keep-files", "Keep installed files on disk", false)
    .option("--keep-config", "Deprecated alias for --keep-files", false)
    .option("--force", "Skip confirmation prompt", false)
    .option("--dry-run", "Show what would be removed without making changes", false)
    .action(async (id: string, opts: PluginUninstallOptions) => {
      const cfg = loadConfig();
      const report = buildPluginStatusReport({ config: cfg });
      const extensionsDir = path.join(resolveStateDir(process.env, os.homedir), "extensions");
      const keepFiles = Boolean(opts.keepFiles || opts.keepConfig);

      if (opts.keepConfig) {
        defaultRuntime.log(theme.warn("`--keep-config` is deprecated, use `--keep-files`."));
      }

      // Find plugin by id or name
      const plugin = report.plugins.find((p) => p.id === id || p.name === id);
      const pluginId = plugin?.id ?? id;

      // Check if plugin exists in config
      const hasEntry = pluginId in (cfg.plugins?.entries ?? {});
      const hasInstall = pluginId in (cfg.plugins?.installs ?? {});

      if (!hasEntry && !hasInstall) {
        if (plugin) {
          defaultRuntime.error(
            `Plugin "${pluginId}" is not managed by plugins config/install records and cannot be uninstalled.`,
          );
        } else {
          defaultRuntime.error(`Plugin not found: ${id}`);
        }
        return defaultRuntime.exit(1);
      }

      const install = cfg.plugins?.installs?.[pluginId];
      const isLinked = install?.source === "path";

      // Build preview of what will be removed
      const preview: string[] = [];
      if (hasEntry) {
        preview.push("config entry");
      }
      if (hasInstall) {
        preview.push("install record");
      }
      if (cfg.plugins?.allow?.includes(pluginId)) {
        preview.push("allowlist entry");
      }
      if (
        isLinked &&
        install?.sourcePath &&
        cfg.plugins?.load?.paths?.includes(install.sourcePath)
      ) {
        preview.push("load path");
      }
      if (cfg.plugins?.slots?.memory === pluginId) {
        preview.push(`memory slot (will reset to "memory-core")`);
      }
      const deleteTarget = !keepFiles
        ? resolveUninstallDirectoryTarget({
            pluginId,
            hasInstall,
            installRecord: install,
            extensionsDir,
          })
        : null;
      if (deleteTarget) {
        preview.push(`directory: ${shortenHomePath(deleteTarget)}`);
      }

      const pluginName = plugin?.name || pluginId;
      defaultRuntime.log(
        `Plugin: ${theme.command(pluginName)}${pluginName !== pluginId ? theme.muted(` (${pluginId})`) : ""}`,
      );
      defaultRuntime.log(`Will remove: ${preview.length > 0 ? preview.join(", ") : "(nothing)"}`);

      if (opts.dryRun) {
        defaultRuntime.log(theme.muted("Dry run, no changes made."));
        return;
      }

      if (!opts.force) {
        const confirmed = await promptYesNo(`Uninstall plugin "${pluginId}"?`);
        if (!confirmed) {
          defaultRuntime.log("Cancelled.");
          return;
        }
      }

      const result = await uninstallPlugin({
        config: cfg,
        pluginId,
        deleteFiles: !keepFiles,
        extensionsDir,
      });

      if (!result.ok) {
        defaultRuntime.error(result.error);
        return defaultRuntime.exit(1);
      }
      for (const warning of result.warnings) {
        defaultRuntime.log(theme.warn(warning));
      }

      await writeConfigFile(result.config);

      const removed: string[] = [];
      if (result.actions.entry) {
        removed.push("config entry");
      }
      if (result.actions.install) {
        removed.push("install record");
      }
      if (result.actions.allowlist) {
        removed.push("allowlist");
      }
      if (result.actions.loadPath) {
        removed.push("load path");
      }
      if (result.actions.memorySlot) {
        removed.push("memory slot");
      }
      if (result.actions.directory) {
        removed.push("directory");
      }

      defaultRuntime.log(
        `Uninstalled plugin "${pluginId}". Removed: ${removed.length > 0 ? removed.join(", ") : "nothing"}.`,
      );
      defaultRuntime.log("Restart the gateway to apply changes.");
    });

  plugins
    .command("install")
    .description(
      "Install a plugin or hook pack (path, archive, npm spec, clawhub:package, or marketplace entry)",
    )
    .argument(
      "<path-or-spec-or-plugin>",
      "Path (.ts/.js/.zip/.tgz/.tar.gz), npm package spec, or marketplace plugin name",
    )
    .option("-l, --link", "Link a local path instead of copying", false)
    .option("--pin", "Record npm installs as exact resolved <name>@<version>", false)
    .option(
      "--marketplace <source>",
      "Install a Claude marketplace plugin from a local repo/path or git/GitHub source",
    )
    .action(async (raw: string, opts: { link?: boolean; pin?: boolean; marketplace?: string }) => {
      await runPluginInstallCommand({ raw, opts });
    });

  plugins
    .command("update")
    .description("Update installed plugins and tracked hook packs")
    .argument("[id]", "Plugin or hook-pack id (omit with --all)")
    .option("--all", "Update all tracked plugins and hook packs", false)
    .option("--dry-run", "Show what would change without writing", false)
    .action(async (id: string | undefined, opts: PluginUpdateOptions) => {
      await runPluginUpdateCommand({ id, opts });
    });

  plugins
    .command("doctor")
    .description("Report plugin load issues")
    .action(() => {
      const report = buildPluginStatusReport();
      const errors = report.plugins.filter((p) => p.status === "error");
      const diags = report.diagnostics.filter((d) => d.level === "error");
      const compatibility = buildPluginCompatibilityNotices({ report });

      if (errors.length === 0 && diags.length === 0 && compatibility.length === 0) {
        defaultRuntime.log("No plugin issues detected.");
        return;
      }

      const lines: string[] = [];
      if (errors.length > 0) {
        lines.push(theme.error("Plugin errors:"));
        for (const entry of errors) {
          lines.push(`- ${entry.id}: ${entry.error ?? "failed to load"} (${entry.source})`);
        }
      }
      if (diags.length > 0) {
        if (lines.length > 0) {
          lines.push("");
        }
        lines.push(theme.warn("Diagnostics:"));
        for (const diag of diags) {
          const target = diag.pluginId ? `${diag.pluginId}: ` : "";
          lines.push(`- ${target}${diag.message}`);
        }
      }
      if (compatibility.length > 0) {
        if (lines.length > 0) {
          lines.push("");
        }
        lines.push(theme.warn("Compatibility:"));
        for (const notice of compatibility) {
          const marker = notice.severity === "warn" ? theme.warn("warn") : theme.muted("info");
          lines.push(`- ${formatPluginCompatibilityNotice(notice)} [${marker}]`);
        }
      }
      const docs = formatDocsLink("/plugin", "docs.openclaw.ai/plugin");
      lines.push("");
      lines.push(`${theme.muted("Docs:")} ${docs}`);
      defaultRuntime.log(lines.join("\n"));
    });

  const marketplace = plugins
    .command("marketplace")
    .description("Inspect Claude-compatible plugin marketplaces");

  marketplace
    .command("list")
    .description("List plugins published by a marketplace source")
    .argument("<source>", "Local marketplace path/repo or git/GitHub source")
    .option("--json", "Print JSON")
    .action(async (source: string, opts: PluginMarketplaceListOptions) => {
      const result = await listMarketplacePlugins({
        marketplace: source,
        logger: createPluginInstallLogger(),
      });
      if (!result.ok) {
        defaultRuntime.error(result.error);
        return defaultRuntime.exit(1);
      }

      if (opts.json) {
        defaultRuntime.log(
          JSON.stringify(
            {
              source: result.sourceLabel,
              name: result.manifest.name,
              version: result.manifest.version,
              plugins: result.manifest.plugins,
            },
            null,
            2,
          ),
        );
        return;
      }

      if (result.manifest.plugins.length === 0) {
        defaultRuntime.log(`No plugins found in marketplace ${result.sourceLabel}.`);
        return;
      }

      defaultRuntime.log(
        `${theme.heading("Marketplace")} ${theme.muted(result.manifest.name ?? result.sourceLabel)}`,
      );
      for (const plugin of result.manifest.plugins) {
        const suffix = plugin.version ? theme.muted(` v${plugin.version}`) : "";
        const desc = plugin.description ? ` - ${theme.muted(plugin.description)}` : "";
        defaultRuntime.log(`${theme.command(plugin.name)}${suffix}${desc}`);
      }
    });
}
