import type { GatewayService, GatewayServiceInstallArgs } from "./service.js";
import {
  NODE_SERVICE_KIND,
  NODE_SERVICE_MARKER,
  NODE_WINDOWS_TASK_SCRIPT_NAME,
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "./constants.js";
import { resolveGatewayService } from "./service.js";

function withNodeServiceEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...env,
    SMART_AGENT_NEO_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
    SMART_AGENT_NEO_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
    SMART_AGENT_NEO_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
    SMART_AGENT_NEO_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
    SMART_AGENT_NEO_LOG_PREFIX: "node",
    SMART_AGENT_NEO_SERVICE_MARKER: NODE_SERVICE_MARKER,
    SMART_AGENT_NEO_SERVICE_KIND: NODE_SERVICE_KIND,
  };
}

function withNodeInstallEnv(args: GatewayServiceInstallArgs): GatewayServiceInstallArgs {
  return {
    ...args,
    env: withNodeServiceEnv(args.env),
    environment: {
      ...args.environment,
      SMART_AGENT_NEO_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
      SMART_AGENT_NEO_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
      SMART_AGENT_NEO_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
      SMART_AGENT_NEO_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
      SMART_AGENT_NEO_LOG_PREFIX: "node",
      SMART_AGENT_NEO_SERVICE_MARKER: NODE_SERVICE_MARKER,
      SMART_AGENT_NEO_SERVICE_KIND: NODE_SERVICE_KIND,
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
