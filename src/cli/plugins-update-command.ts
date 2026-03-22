import type { OpenClawConfig } from "../config/config.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { installHooksFromNpmSpec, resolveHookInstallDir } from "../hooks/install.js";
import { recordHookInstall } from "../hooks/installs.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import {
  createHookPackInstallLogger,
  extractInstalledNpmHookPackageName,
  extractInstalledNpmPackageName,
  readInstalledPackageVersion,
} from "./plugins-command-helpers.js";
import { promptYesNo } from "./prompt.js";

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

export async function runPluginUpdateCommand(params: {
  id?: string;
  opts: { all?: boolean; dryRun?: boolean };
}) {
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
