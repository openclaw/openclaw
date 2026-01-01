import {
  installLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  restartLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  restartScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import {
  installSystemdService,
  isSystemdServiceEnabled,
  readSystemdServiceExecStart,
  restartSystemdService,
  uninstallSystemdService,
} from "./systemd.js";

export type GatewayServiceInstallArgs = {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
};

export type GatewayService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: {
    env: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
  }) => Promise<void>;
  restart: (args: { stdout: NodeJS.WritableStream }) => Promise<void>;
  isLoaded: (args: {
    env: Record<string, string | undefined>;
  }) => Promise<boolean>;
  readCommand: (env: Record<string, string | undefined>) => Promise<{
    programArguments: string[];
    workingDirectory?: string;
  } | null>;
};

export function resolveGatewayService(): GatewayService {
  if (process.platform === "darwin") {
    return {
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      install: async (args) => {
        await installLaunchAgent(args);
      },
      uninstall: async (args) => {
        await uninstallLaunchAgent(args);
      },
      restart: async (args) => {
        await restartLaunchAgent(args);
      },
      isLoaded: async () => isLaunchAgentLoaded(),
      readCommand: readLaunchAgentProgramArguments,
    };
  }

  if (process.platform === "linux") {
    return {
      label: "systemd",
      loadedText: "enabled",
      notLoadedText: "disabled",
      install: async (args) => {
        await installSystemdService(args);
      },
      uninstall: async (args) => {
        await uninstallSystemdService(args);
      },
      restart: async (args) => {
        await restartSystemdService(args);
      },
      isLoaded: async () => isSystemdServiceEnabled(),
      readCommand: readSystemdServiceExecStart,
    };
  }

  if (process.platform === "win32") {
    return {
      label: "Scheduled Task",
      loadedText: "registered",
      notLoadedText: "missing",
      install: async (args) => {
        await installScheduledTask(args);
      },
      uninstall: async (args) => {
        await uninstallScheduledTask(args);
      },
      restart: async (args) => {
        await restartScheduledTask(args);
      },
      isLoaded: async () => isScheduledTaskInstalled(),
      readCommand: readScheduledTaskCommand,
    };
  }

  throw new Error(
    `Gateway service install not supported on ${process.platform}`,
  );
}
