import {
  installLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  restartLaunchAgent,
  stageLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  restartScheduledTask,
  stageScheduledTask,
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
  GatewayServiceRestartResult,
  GatewayServiceStageArgs,
} from "./service-types.js";
import {
  installSystemdService,
  isSystemdServiceEnabled,
  readSystemdServiceExecStart,
  readSystemdServiceRuntime,
  restartSystemdService,
  stageSystemdService,
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
  GatewayServiceRestartResult,
  GatewayServiceStageArgs,
} from "./service-types.js";

type WindowsServiceModule = typeof import("./windows-service.js");

function ignoreServiceWriteResult<TArgs extends GatewayServiceInstallArgs>(
  write: (args: TArgs) => Promise<unknown>,
): (args: TArgs) => Promise<void> {
  return async (args: TArgs) => {
    await write(args);
  };
}

export type GatewayService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  stage: (args: GatewayServiceStageArgs) => Promise<void>;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: GatewayServiceManageArgs) => Promise<void>;
  stop: (args: GatewayServiceControlArgs) => Promise<void>;
  restart: (args: GatewayServiceControlArgs) => Promise<GatewayServiceRestartResult>;
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (env: GatewayServiceEnv) => Promise<GatewayServiceRuntime>;
};

export function describeGatewayServiceRestart(
  serviceNoun: string,
  result: GatewayServiceRestartResult,
): {
  scheduled: boolean;
  daemonActionResult: "restarted" | "scheduled";
  message: string;
  progressMessage: string;
} {
  if (result.outcome === "scheduled") {
    return {
      scheduled: true,
      daemonActionResult: "scheduled",
      message: `restart scheduled, ${serviceNoun.toLowerCase()} will restart momentarily`,
      progressMessage: `${serviceNoun} service restart scheduled.`,
    };
  }
  return {
    scheduled: false,
    daemonActionResult: "restarted",
    message: `${serviceNoun} service restarted.`,
    progressMessage: `${serviceNoun} service restarted.`,
  };
}

type SupportedGatewayServicePlatform = "darwin" | "linux" | "win32";

const GATEWAY_SERVICE_REGISTRY: Record<SupportedGatewayServicePlatform, GatewayService> = {
  darwin: {
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: ignoreServiceWriteResult(stageLaunchAgent),
    install: ignoreServiceWriteResult(installLaunchAgent),
    uninstall: uninstallLaunchAgent,
    stop: stopLaunchAgent,
    restart: restartLaunchAgent,
    isLoaded: isLaunchAgentLoaded,
    readCommand: readLaunchAgentProgramArguments,
    readRuntime: readLaunchAgentRuntime,
  },
  linux: {
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    stage: ignoreServiceWriteResult(stageSystemdService),
    install: ignoreServiceWriteResult(installSystemdService),
    uninstall: uninstallSystemdService,
    stop: stopSystemdService,
    restart: restartSystemdService,
    isLoaded: isSystemdServiceEnabled,
    readCommand: readSystemdServiceExecStart,
    readRuntime: readSystemdServiceRuntime,
  },
  win32: {
    label: "Scheduled Task",
    loadedText: "registered",
    notLoadedText: "missing",
    stage: ignoreServiceWriteResult(stageScheduledTask),
    install: ignoreServiceWriteResult(installScheduledTask),
    uninstall: uninstallScheduledTask,
    stop: stopScheduledTask,
    restart: restartScheduledTask,
    isLoaded: isScheduledTaskInstalled,
    readCommand: readScheduledTaskCommand,
    readRuntime: readScheduledTaskRuntime,
  },
};

function isSupportedGatewayServicePlatform(
  platform: NodeJS.Platform,
): platform is SupportedGatewayServicePlatform {
  return Object.hasOwn(GATEWAY_SERVICE_REGISTRY, platform);
}

let windowsServiceModulePromise: Promise<WindowsServiceModule> | null = null;

async function loadWindowsServiceModule(): Promise<WindowsServiceModule> {
  windowsServiceModulePromise ??= import("./windows-service.js");
  return await windowsServiceModulePromise;
}

async function useWindowsService(env: GatewayServiceEnv): Promise<boolean> {
  const { isWindowsServiceInstalled } = await loadWindowsServiceModule();
  return await isWindowsServiceInstalled({ env }).catch(() => false);
}

async function readWindowsCommandOrScheduledTask(
  env: GatewayServiceEnv,
): Promise<GatewayServiceCommandConfig | null> {
  const { probeWindowsService, readWindowsServiceCommand } = await loadWindowsServiceModule();
  const probe = await probeWindowsService(env).catch(() => null);
  if (probe) {
    return await readWindowsServiceCommand(env, probe);
  }
  return await readScheduledTaskCommand(env);
}

async function readWindowsRuntimeOrScheduledTask(
  env: GatewayServiceEnv,
): Promise<GatewayServiceRuntime> {
  const { probeWindowsService, readWindowsServiceRuntime } = await loadWindowsServiceModule();
  if (await probeWindowsService(env).catch(() => null)) {
    return await readWindowsServiceRuntime(env);
  }
  return await readScheduledTaskRuntime(env);
}

async function stopWindowsRuntimeOrScheduledTask(args: GatewayServiceControlArgs): Promise<void> {
  const env = args.env ?? (process.env as GatewayServiceEnv);
  const { probeWindowsService, stopWindowsService } = await loadWindowsServiceModule();
  if (await probeWindowsService(env).catch(() => null)) {
    await stopWindowsService({ ...args, env });
    return;
  }
  await stopScheduledTask({ ...args, env });
}

async function restartWindowsRuntimeOrScheduledTask(
  args: GatewayServiceControlArgs,
): Promise<GatewayServiceRestartResult> {
  const env = args.env ?? (process.env as GatewayServiceEnv);
  const { probeWindowsService, restartWindowsService } = await loadWindowsServiceModule();
  if (await probeWindowsService(env).catch(() => null)) {
    return await restartWindowsService({ ...args, env });
  }
  return await restartScheduledTask({ ...args, env });
}

async function uninstallWindowsRuntimeOrScheduledTask(
  args: GatewayServiceManageArgs,
): Promise<void> {
  const { probeWindowsService, uninstallWindowsService } = await loadWindowsServiceModule();
  if (await probeWindowsService(args.env).catch(() => null)) {
    await uninstallWindowsService(args);
    return;
  }
  await uninstallScheduledTask(args);
}

export function resolveGatewayService(): GatewayService {
  if (isSupportedGatewayServicePlatform(process.platform)) {
    if (process.platform === "win32") {
      return {
        ...GATEWAY_SERVICE_REGISTRY.win32,
        uninstall: uninstallWindowsRuntimeOrScheduledTask,
        stop: stopWindowsRuntimeOrScheduledTask,
        restart: restartWindowsRuntimeOrScheduledTask,
        isLoaded: async (args) => {
          const env = args.env ?? (process.env as GatewayServiceEnv);
          if (await useWindowsService(env)) {
            return true;
          }
          return await isScheduledTaskInstalled({ env });
        },
        readCommand: async (env) => await readWindowsCommandOrScheduledTask(env),
        readRuntime: async (env) => await readWindowsRuntimeOrScheduledTask(env),
      };
    }
    return GATEWAY_SERVICE_REGISTRY[process.platform];
  }
  throw new Error(`Gateway service install not supported on ${process.platform}`);
}
