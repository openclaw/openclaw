import { replaceConfigFile } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type HookInstallUpdate, recordHookInstall } from "../hooks/installs.js";
import { buildPluginInstallPersistState } from "../plugins/install-persist-core.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import type { PluginInstallUpdate } from "../plugins/installs.js";
import { tracePluginLifecyclePhaseAsync } from "../plugins/plugin-lifecycle-trace.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import {
  applySlotSelectionForPlugin,
  enableInternalHookEntries,
  logHookPackRestartHint,
  logSlotWarnings,
} from "./plugins-command-helpers.js";
import { commitPluginInstallRecordsWithConfig } from "./plugins-install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "./plugins-registry-refresh.js";

export type ConfigSnapshotForInstallPersist = {
  config: OpenClawConfig;
  baseHash: string | undefined;
};

export async function persistPluginInstall(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  pluginId: string;
  install: Omit<PluginInstallUpdate, "pluginId">;
  enable?: boolean;
  successMessage?: string;
  warningMessage?: string;
}): Promise<OpenClawConfig> {
  const installRecords = await tracePluginLifecyclePhaseAsync(
    "install records load",
    () => loadInstalledPluginIndexInstallRecords(),
    { command: "install" },
  );
  const installState = await buildPluginInstallPersistState({
    config: params.snapshot.config,
    pluginId: params.pluginId,
    install: params.install,
    installRecords,
    ...(params.enable !== undefined ? { enable: params.enable } : {}),
    applySlotSelection: (config, pluginId) =>
      tracePluginLifecyclePhaseAsync(
        "slot selection",
        async () => applySlotSelectionForPlugin(config, pluginId),
        { command: "install", pluginId },
      ),
  });
  await tracePluginLifecyclePhaseAsync(
    "config mutation",
    () =>
      commitPluginInstallRecordsWithConfig({
        previousInstallRecords: installRecords,
        nextInstallRecords: installState.installRecords,
        nextConfig: installState.config,
        baseHash: params.snapshot.baseHash,
      }),
    { command: "install" },
  );
  await refreshPluginRegistryAfterConfigMutation({
    config: installState.config,
    reason: "source-changed",
    installRecords: installState.installRecords,
    traceCommand: "install",
    logger: {
      warn: (message) => defaultRuntime.log(theme.warn(message)),
    },
  });
  logSlotWarnings(installState.warnings);
  if (params.warningMessage) {
    defaultRuntime.log(theme.warn(params.warningMessage));
  }
  defaultRuntime.log(params.successMessage ?? `Installed plugin: ${params.pluginId}`);
  defaultRuntime.log("Restart the gateway to load plugins.");
  return installState.config;
}

export async function persistHookPackInstall(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  hookPackId: string;
  hooks: string[];
  install: Omit<HookInstallUpdate, "hookId" | "hooks">;
  successMessage?: string;
}): Promise<OpenClawConfig> {
  let next = enableInternalHookEntries(params.snapshot.config, params.hooks);
  next = recordHookInstall(next, {
    hookId: params.hookPackId,
    hooks: params.hooks,
    ...params.install,
  });
  await replaceConfigFile({
    nextConfig: next,
    baseHash: params.snapshot.baseHash,
  });
  defaultRuntime.log(params.successMessage ?? `Installed hook pack: ${params.hookPackId}`);
  logHookPackRestartHint();
  return next;
}
