import fs from "node:fs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import type { PluginCandidate } from "./discovery.js";
import {
  channelPluginIdBelongsToManifest,
  loadBundledRuntimeChannelPlugin,
  mergeSetupRuntimeChannelPlugin,
  resolveBundledRuntimeChannelRegistration,
  resolveSetupChannelRegistration,
  shouldDeferConfiguredChannelFullRuntimeMerge,
} from "./loader-channel-setup.js";
import type { PluginModuleLoader } from "./loader-module.js";
import { runPluginRegisterSync } from "./loader-module.js";
import { recordPluginError } from "./loader-records.js";
import type { PluginRegistrationPlan } from "./loader-registration.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { withProfile } from "./plugin-load-profile.js";
import { createPluginRegistrationTransaction } from "./plugin-registration-transaction.js";
import {
  resolveCanonicalDistRuntimeSource,
  type resolvePluginRuntimeArtifact,
} from "./plugin-runtime-artifact-resolution.js";
import type { createPluginRegistry } from "./registry.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import type { OpenClawPluginModule, PluginLogger } from "./types.js";

type PluginRegistryBuilder = ReturnType<typeof createPluginRegistry>;

/**
 * Register a channel setup entry when the selected plan uses one.
 * Returns true once the setup path owns the candidate, including handled failures.
 */
export function registerSetupChannelPlugin(params: {
  registrationPlan: PluginRegistrationPlan;
  manifestRecord: PluginManifestRecord;
  moduleExport: OpenClawPluginModule;
  record: PluginRecord;
  registry: PluginRegistry;
  seenIds: Map<string, PluginRecord["origin"]>;
  candidate: PluginCandidate;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  entryHooks: Parameters<PluginRegistryBuilder["createApi"]>[1]["hookPolicy"];
  createApi: PluginRegistryBuilder["createApi"];
  loadPluginModule: PluginModuleLoader;
  runtimeCandidateEntry: ReturnType<typeof resolvePluginRuntimeArtifact>;
  rejectHardlinks: boolean;
  safeSetupSource: string;
  preferSetupRuntimeForChannelPlugins: boolean;
  logger: PluginLogger;
  pushPluginLoadError: (message: string) => void;
}): boolean {
  const { registrationPlan, manifestRecord } = params;
  if (!registrationPlan.loadSetupEntry || !manifestRecord.setupSource) {
    return false;
  }
  const setupRegistration = resolveSetupChannelRegistration(params.moduleExport);
  if (setupRegistration.loadError) {
    recordSetupError(params, {
      phase: "load",
      error: setupRegistration.loadError,
      logMessage: "failed to load setup entry",
      diagnosticMessage: "failed to load setup entry: ",
    });
    return true;
  }
  if (!setupRegistration.plugin) {
    return false;
  }
  if (
    !channelPluginIdBelongsToManifest({
      channelId: setupRegistration.plugin.id,
      pluginId: params.record.id,
      manifestChannels: manifestRecord.channels,
    })
  ) {
    params.pushPluginLoadError(
      `plugin id mismatch (config uses "${params.record.id}", setup export uses "${setupRegistration.plugin.id}")`,
    );
    return true;
  }

  const api = params.createApi(params.record, {
    config: params.cfg,
    pluginConfig: {},
    hookPolicy: params.entryHooks,
    registrationMode: registrationPlan.mode,
  });
  let mergedSetupRegistration = setupRegistration;
  let runtimeSetterApplied = false;
  if (
    registrationPlan.loadSetupRuntimeEntry &&
    setupRegistration.usesBundledSetupContract &&
    !shouldDeferConfiguredChannelFullRuntimeMerge({
      manifestChannels: manifestRecord.channels,
      startupDeferConfiguredChannelFullLoadUntilAfterListen:
        manifestRecord.startupDeferConfiguredChannelFullLoadUntilAfterListen,
      cfg: params.cfg,
      env: params.env,
      preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
    }) &&
    resolveCanonicalDistRuntimeSource(params.runtimeCandidateEntry.source) !==
      params.safeSetupSource
  ) {
    const runtimeSource = resolveCanonicalDistRuntimeSource(params.runtimeCandidateEntry.source);
    const runtimeRoot = resolveCanonicalDistRuntimeSource(params.runtimeCandidateEntry.rootDir);
    const opened = openRootFileSync({
      absolutePath: runtimeSource,
      rootPath: runtimeRoot,
      boundaryLabel: "plugin root",
      rejectHardlinks: params.rejectHardlinks,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      params.pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
      return true;
    }
    const safeRuntimeSource = opened.path;
    fs.closeSync(opened.fd);
    let runtimeModule: OpenClawPluginModule;
    try {
      runtimeModule = withProfile(
        { pluginId: params.record.id, source: safeRuntimeSource },
        "load-setup-runtime-entry",
        () => params.loadPluginModule(safeRuntimeSource) as OpenClawPluginModule,
      );
    } catch (error) {
      recordSetupError(params, {
        phase: "load",
        error,
        logMessage: "failed to load setup-runtime entry",
        diagnosticMessage: "failed to load setup-runtime entry: ",
      });
      return true;
    }
    const runtimeRegistration = resolveBundledRuntimeChannelRegistration(runtimeModule);
    if (runtimeRegistration.id && runtimeRegistration.id !== params.record.id) {
      params.pushPluginLoadError(
        `plugin id mismatch (config uses "${params.record.id}", runtime entry uses "${runtimeRegistration.id}")`,
      );
      return true;
    }
    if (runtimeRegistration.setChannelRuntime) {
      try {
        runtimeRegistration.setChannelRuntime(api.runtime);
        runtimeSetterApplied = true;
      } catch (error) {
        recordSetupError(params, {
          phase: "load",
          error,
          logMessage: "failed to apply setup-runtime channel runtime",
          diagnosticMessage: "failed to apply setup-runtime channel runtime: ",
        });
        return true;
      }
    }
    const runtimePluginRegistration = loadBundledRuntimeChannelPlugin({
      registration: runtimeRegistration,
    });
    if (runtimePluginRegistration.loadError) {
      recordSetupError(params, {
        phase: "load",
        error: runtimePluginRegistration.loadError,
        logMessage: "failed to load setup-runtime channel entry",
        diagnosticMessage: "failed to load setup-runtime channel entry: ",
      });
      return true;
    }
    if (runtimePluginRegistration.plugin) {
      if (
        runtimePluginRegistration.plugin.id &&
        runtimePluginRegistration.plugin.id !== params.record.id
      ) {
        params.pushPluginLoadError(
          `plugin id mismatch (config uses "${params.record.id}", runtime export uses "${runtimePluginRegistration.plugin.id}")`,
        );
        return true;
      }
      mergedSetupRegistration = {
        ...setupRegistration,
        plugin: mergeSetupRuntimeChannelPlugin(
          runtimePluginRegistration.plugin,
          setupRegistration.plugin,
        ),
        setChannelRuntime:
          runtimeRegistration.setChannelRuntime ?? setupRegistration.setChannelRuntime,
      };
    }
  }

  const setupPlugin = mergedSetupRegistration.plugin;
  if (!setupPlugin) {
    return true;
  }
  if (
    !channelPluginIdBelongsToManifest({
      channelId: setupPlugin.id,
      pluginId: params.record.id,
      manifestChannels: manifestRecord.channels,
    })
  ) {
    params.pushPluginLoadError(
      `plugin id mismatch (config uses "${params.record.id}", setup export uses "${setupPlugin.id}")`,
    );
    return true;
  }
  if (!runtimeSetterApplied) {
    try {
      mergedSetupRegistration.setChannelRuntime?.(api.runtime);
    } catch (error) {
      recordSetupError(params, {
        phase: "load",
        error,
        logMessage: "failed to apply setup channel runtime",
        diagnosticMessage: "failed to apply setup channel runtime: ",
      });
      return true;
    }
  }
  if (registrationPlan.mode === "setup-runtime") {
    const registerSetupRuntime = mergedSetupRegistration.registerSetupRuntime;
    if (registerSetupRuntime) {
      const transaction = createPluginRegistrationTransaction({ registry: params.registry });
      try {
        runPluginRegisterSync((registrationApi) => registerSetupRuntime(registrationApi), api);
        transaction.commit({ activate: true });
      } catch (error) {
        transaction.rollback();
        recordSetupError(params, {
          phase: "register",
          error,
          logMessage: "failed to register setup-runtime channel side effects",
          diagnosticMessage: "failed to register setup-runtime channel side effects: ",
        });
        return true;
      }
    }
  }
  try {
    api.registerChannel(setupPlugin);
  } catch (error) {
    recordSetupError(params, {
      phase: "load",
      error,
      logMessage: "failed to register setup channel",
      diagnosticMessage: "failed to register setup channel: ",
    });
    return true;
  }
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.record.id, params.candidate.origin);
  return true;
}

function recordSetupError(
  params: {
    logger: PluginLogger;
    registry: PluginRegistry;
    record: PluginRecord;
    seenIds: Map<string, PluginRecord["origin"]>;
    candidate: PluginCandidate;
  },
  error: {
    phase: PluginRecord["failurePhase"];
    error: unknown;
    logMessage: string;
    diagnosticMessage: string;
  },
): void {
  recordPluginError({
    logger: params.logger,
    registry: params.registry,
    record: params.record,
    seenIds: params.seenIds,
    pluginId: params.record.id,
    origin: params.candidate.origin,
    phase: error.phase,
    error: error.error,
    logPrefix: `[plugins] ${params.record.id} ${error.logMessage} from ${params.record.source}: `,
    diagnosticMessagePrefix: error.diagnosticMessage,
    diagnosticCode: "channel-setup-failure",
  });
}
