import {
  installLaunchAgent,
  installLaunchDaemon,
  isLaunchAgentLoaded,
  isLaunchDaemonLoaded,
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  readLaunchDaemonProgramArguments,
  readLaunchDaemonRuntime,
  restartLaunchAgent,
  restartLaunchDaemon,
  stopLaunchAgent,
  stopLaunchDaemon,
  uninstallLaunchAgent,
  uninstallLaunchDaemon,
} from "./launchd.js";
import {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  restartScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
} from "./service-types.js";
import {
  installSystemdService,
  isSystemdServiceEnabled,
  readSystemdServiceExecStart,
  readSystemdServiceRuntime,
  restartSystemdService,
  stopSystemdService,
  uninstallSystemdService,
} from "./systemd.js";
export type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
} from "./service-types.js";

function ignoreInstallResult(
  install: (args: GatewayServiceInstallArgs) => Promise<unknown>,
): (args: GatewayServiceInstallArgs) => Promise<void> {
  return async (args) => {
    await install(args);
  };
}

export type GatewayServiceScope = "agent" | "daemon" | "auto";

export type GatewayService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: GatewayServiceManageArgs) => Promise<void>;
  stop: (args: GatewayServiceControlArgs) => Promise<void>;
  restart: (args: GatewayServiceControlArgs) => Promise<void>;
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (env: GatewayServiceEnv) => Promise<GatewayServiceRuntime>;
};

export function resolveGatewayService(opts?: {
  scope?: GatewayServiceScope;
  env?: Record<string, string | undefined>;
}): GatewayService {
  if (process.platform === "darwin") {
    const env = opts?.env ?? (process.env as Record<string, string | undefined>);
    const scope =
      opts?.scope ?? (env.OPENCLAW_LAUNCHD_SCOPE as GatewayServiceScope | undefined) ?? "auto";

    const launchAgentService: GatewayService = {
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      install: ignoreInstallResult(installLaunchAgent),
      uninstall: uninstallLaunchAgent,
      stop: stopLaunchAgent,
      restart: restartLaunchAgent,
      isLoaded: isLaunchAgentLoaded,
      readCommand: readLaunchAgentProgramArguments,
      readRuntime: readLaunchAgentRuntime,
    };

    const launchDaemonService: GatewayService = {
      label: "LaunchDaemon",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      install: ignoreInstallResult(installLaunchDaemon),
      uninstall: uninstallLaunchDaemon,
      stop: stopLaunchDaemon,
      restart: restartLaunchDaemon,
      isLoaded: isLaunchDaemonLoaded,
      readCommand: readLaunchDaemonProgramArguments,
      readRuntime: readLaunchDaemonRuntime,
    };

    if (scope === "daemon") {
      return launchDaemonService;
    }
    if (scope === "agent") {
      return launchAgentService;
    }

    // auto: prefer daemon when present; otherwise fall back to agent.
    // (This prevents misleading "LaunchAgent not installed" errors in headless daemon deployments.)
    return {
      ...launchDaemonService,
      label: "launchd (auto)",
      isLoaded: async (args) => {
        const daemonLoaded = await launchDaemonService
          .isLoaded({ env: args.env ?? env })
          .catch(() => false);
        if (daemonLoaded) {
          return true;
        }
        return await launchAgentService.isLoaded(args).catch(() => false);
      },
      readRuntime: async (e) => {
        const daemonRuntime = await launchDaemonService
          .readRuntime(e)
          .catch(() => ({ status: "unknown" }));
        if (daemonRuntime?.status && daemonRuntime.status !== "unknown") {
          return daemonRuntime;
        }
        return await launchAgentService.readRuntime(e);
      },
      readCommand: async (e) => {
        const daemonCmd = await launchDaemonService.readCommand(e).catch(() => null);
        if (daemonCmd) {
          return daemonCmd;
        }
        return await launchAgentService.readCommand(e);
      },
    };
  }

  if (process.platform === "linux") {
    return {
      label: "systemd",
      loadedText: "enabled",
      notLoadedText: "disabled",
      install: ignoreInstallResult(installSystemdService),
      uninstall: uninstallSystemdService,
      stop: stopSystemdService,
      restart: restartSystemdService,
      isLoaded: isSystemdServiceEnabled,
      readCommand: readSystemdServiceExecStart,
      readRuntime: readSystemdServiceRuntime,
    };
  }

  if (process.platform === "win32") {
    return {
      label: "Scheduled Task",
      loadedText: "registered",
      notLoadedText: "missing",
      install: ignoreInstallResult(installScheduledTask),
      uninstall: uninstallScheduledTask,
      stop: stopScheduledTask,
      restart: restartScheduledTask,
      isLoaded: isScheduledTaskInstalled,
      readCommand: readScheduledTaskCommand,
      readRuntime: readScheduledTaskRuntime,
    };
  }

  throw new Error(`Gateway service install not supported on ${process.platform}`);
}
