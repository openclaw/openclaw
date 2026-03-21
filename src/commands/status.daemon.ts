import {
  NODE_SERVICE_KIND,
  NODE_SERVICE_MARKER,
  NODE_WINDOWS_TASK_SCRIPT_NAME,
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "../daemon/constants.js";
import { formatDaemonRuntimeShort } from "./status.format.js";
import {
  readServiceStatusSummary,
  type GatewayServiceStatusReader,
} from "./status.service-summary.js";

type DaemonStatusSummary = {
  label: string;
  installed: boolean | null;
  managedByOpenClaw: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtimeShort: string | null;
};

function withNodeServiceEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...env,
    OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
    OPENCLAW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
    OPENCLAW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
    OPENCLAW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
    OPENCLAW_LOG_PREFIX: "node",
    OPENCLAW_SERVICE_MARKER: NODE_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: NODE_SERVICE_KIND,
  };
}

async function loadGatewayServiceStatusReader(): Promise<GatewayServiceStatusReader> {
  if (process.platform === "darwin") {
    const launchd = await import("../daemon/launchd.js");
    return {
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      isLoaded: launchd.isLaunchAgentLoaded,
      readCommand: launchd.readLaunchAgentProgramArguments,
      readRuntime: launchd.readLaunchAgentRuntime,
    };
  }
  if (process.platform === "linux") {
    const systemd = await import("../daemon/systemd.js");
    return {
      label: "systemd",
      loadedText: "enabled",
      notLoadedText: "disabled",
      isLoaded: systemd.isSystemdServiceEnabled,
      readCommand: systemd.readSystemdServiceExecStart,
      readRuntime: systemd.readSystemdServiceRuntime,
    };
  }
  if (process.platform === "win32") {
    const schtasks = await import("../daemon/schtasks.js");
    return {
      label: "Scheduled Task",
      loadedText: "registered",
      notLoadedText: "missing",
      isLoaded: schtasks.isScheduledTaskInstalled,
      readCommand: schtasks.readScheduledTaskCommand,
      readRuntime: schtasks.readScheduledTaskRuntime,
    };
  }
  throw new Error(`Gateway service install not supported on ${process.platform}`);
}

async function loadNodeServiceStatusReader(): Promise<GatewayServiceStatusReader> {
  const base = await loadGatewayServiceStatusReader();
  return {
    ...base,
    isLoaded: async (args) => {
      return base.isLoaded({ env: withNodeServiceEnv(args.env ?? {}) });
    },
    readCommand: async (env) => {
      return base.readCommand(withNodeServiceEnv(env));
    },
    readRuntime: async (env) => {
      return base.readRuntime(withNodeServiceEnv(env));
    },
  };
}

async function buildDaemonStatusSummary(
  serviceLabel: "gateway" | "node",
): Promise<DaemonStatusSummary> {
  const service =
    serviceLabel === "gateway"
      ? await loadGatewayServiceStatusReader()
      : await loadNodeServiceStatusReader();
  const fallbackLabel = serviceLabel === "gateway" ? "Daemon" : "Node";
  const summary = await readServiceStatusSummary(service, fallbackLabel);
  return {
    label: summary.label,
    installed: summary.installed,
    managedByOpenClaw: summary.managedByOpenClaw,
    externallyManaged: summary.externallyManaged,
    loadedText: summary.loadedText,
    runtimeShort: formatDaemonRuntimeShort(summary.runtime),
  };
}

export async function getDaemonStatusSummary(): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary("gateway");
}

export async function getNodeDaemonStatusSummary(): Promise<DaemonStatusSummary> {
  return await buildDaemonStatusSummary("node");
}
