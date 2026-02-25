import {
  NODE_SERVICE_KIND,
  NODE_SERVICE_MARKER,
  NODE_WINDOWS_TASK_SCRIPT_NAME,
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "./constants.js";
import type { GatewayService, GatewayServiceInstallArgs } from "./service.js";
import { resolveGatewayService } from "./service.js";

function withNodeServiceEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...env,
    ACTIVI_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
    ACTIVI_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
    ACTIVI_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
    ACTIVI_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
    ACTIVI_LOG_PREFIX: "node",
    ACTIVI_SERVICE_MARKER: NODE_SERVICE_MARKER,
    ACTIVI_SERVICE_KIND: NODE_SERVICE_KIND,
  };
}

function withNodeInstallEnv(args: GatewayServiceInstallArgs): GatewayServiceInstallArgs {
  return {
    ...args,
    env: withNodeServiceEnv(args.env),
    environment: {
      ...args.environment,
      ACTIVI_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
      ACTIVI_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
      ACTIVI_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
      ACTIVI_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
      ACTIVI_LOG_PREFIX: "node",
      ACTIVI_SERVICE_MARKER: NODE_SERVICE_MARKER,
      ACTIVI_SERVICE_KIND: NODE_SERVICE_KIND,
    },
  };
}

export function resolveNodeService(): GatewayService {
  const base = resolveGatewayService();
  return {
    ...base,
    install: async (args) => {
      return base.install(withNodeInstallEnv(args));
    },
    uninstall: async (args) => {
      return base.uninstall({ ...args, env: withNodeServiceEnv(args.env) });
    },
    stop: async (args) => {
      return base.stop({ ...args, env: withNodeServiceEnv(args.env ?? {}) });
    },
    restart: async (args) => {
      return base.restart({ ...args, env: withNodeServiceEnv(args.env ?? {}) });
    },
    isLoaded: async (args) => {
      return base.isLoaded({ env: withNodeServiceEnv(args.env ?? {}) });
    },
    readCommand: (env) => base.readCommand(withNodeServiceEnv(env)),
    readRuntime: (env) => base.readRuntime(withNodeServiceEnv(env)),
  };
}
