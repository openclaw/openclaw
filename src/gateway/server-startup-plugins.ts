import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { runChannelPluginStartupMaintenance } from "../channels/plugins/lifecycle-startup.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  installBundledRuntimeDeps,
  resolveBundledRuntimeDependencyPackageInstallRoot,
  scanBundledPluginRuntimeDeps,
} from "../plugins/bundled-runtime-deps.js";
import {
  resolveConfiguredDeferredChannelPluginIds,
  resolveGatewayStartupPluginIds,
} from "../plugins/channel-plugin-ids.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { loadGatewayStartupPlugins } from "./server-plugin-bootstrap.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

type GatewayPluginBootstrapLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

async function maybeRepairBundledPluginRuntimeDepsForGatewayStartup(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: GatewayPluginBootstrapLog;
  packageRoot?: string | null;
  installDeps?: (params: { installRoot: string; missingSpecs: string[]; installSpecs: string[] }) => void;
}) {
  const env = params.env ?? process.env;
  const packageRoot =
    params.packageRoot ??
    resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      cwd: process.cwd(),
      moduleUrl: import.meta.url,
    });
  if (!packageRoot) {
    return;
  }

  const { deps, missing, conflicts } = scanBundledPluginRuntimeDeps({
    packageRoot,
    config: params.cfg,
    includeConfiguredChannels: true,
    env,
  });
  if (conflicts.length > 0) {
    params.log.warn(
      `gateway: bundled plugin runtime deps have version conflicts; skipping preflight repair for ${conflicts.map((conflict) => conflict.name).join(", ")}`,
    );
  }
  if (missing.length === 0) {
    return;
  }

  const installRoot = resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot, { env });
  const missingSpecs = missing.map((dep) => `${dep.name}@${dep.version}`);
  const installSpecs = deps.map((dep) => `${dep.name}@${dep.version}`);
  params.log.info(
    `gateway: installing missing bundled plugin runtime deps before startup: ${missingSpecs.join(", ")}`,
  );
  const install =
    params.installDeps ??
    ((installParams) =>
      installBundledRuntimeDeps({
        installRoot: installParams.installRoot,
        missingSpecs: installParams.missingSpecs,
        env,
      }));
  install({ installRoot, missingSpecs, installSpecs });
}

export async function prepareGatewayPluginBootstrap(params: {
  cfgAtStart: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
}) {
  const startupMaintenanceConfig =
    params.cfgAtStart.channels === undefined && params.startupRuntimeConfig.channels !== undefined
      ? {
          ...params.cfgAtStart,
          channels: params.startupRuntimeConfig.channels,
        }
      : params.cfgAtStart;

  if (!params.minimalTestGateway) {
    await maybeRepairBundledPluginRuntimeDepsForGatewayStartup({
      cfg: startupMaintenanceConfig,
      log: params.log,
    });
    await Promise.all([
      runChannelPluginStartupMaintenance({
        cfg: startupMaintenanceConfig,
        env: process.env,
        log: params.log,
      }),
      runStartupSessionMigration({
        cfg: params.cfgAtStart,
        env: process.env,
        log: params.log,
      }),
    ]);
  }

  initSubagentRegistry();

  const gatewayPluginConfigAtStart = params.minimalTestGateway
    ? params.cfgAtStart
    : applyPluginAutoEnable({
        config: params.cfgAtStart,
        env: process.env,
      }).config;
  const defaultAgentId = resolveDefaultAgentId(gatewayPluginConfigAtStart);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(gatewayPluginConfigAtStart, defaultAgentId);
  const deferredConfiguredChannelPluginIds = params.minimalTestGateway
    ? []
    : resolveConfiguredDeferredChannelPluginIds({
        config: gatewayPluginConfigAtStart,
        workspaceDir: defaultWorkspaceDir,
        env: process.env,
      });
  const startupPluginIds = params.minimalTestGateway
    ? []
    : resolveGatewayStartupPluginIds({
        config: gatewayPluginConfigAtStart,
        activationSourceConfig: params.cfgAtStart,
        workspaceDir: defaultWorkspaceDir,
        env: process.env,
      });

  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  let pluginRegistry = emptyPluginRegistry;
  let baseGatewayMethods = baseMethods;

  if (!params.minimalTestGateway) {
    ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = loadGatewayStartupPlugins({
      cfg: gatewayPluginConfigAtStart,
      activationSourceConfig: params.cfgAtStart,
      workspaceDir: defaultWorkspaceDir,
      log: params.log,
      coreGatewayHandlers,
      baseMethods,
      pluginIds: startupPluginIds,
      preferSetupRuntimeForChannelPlugins: deferredConfiguredChannelPluginIds.length > 0,
      suppressPluginInfoLogs: deferredConfiguredChannelPluginIds.length > 0,
    }));
  } else {
    pluginRegistry = getActivePluginRegistry() ?? emptyPluginRegistry;
    setActivePluginRegistry(pluginRegistry);
  }

  return {
    gatewayPluginConfigAtStart,
    defaultWorkspaceDir,
    deferredConfiguredChannelPluginIds,
    startupPluginIds,
    baseMethods,
    pluginRegistry,
    baseGatewayMethods,
  };
}
