import type { GatewayService } from "./service-types.js";

export const readGatewayServiceCommand: GatewayService["readCommand"] = async (env, options) => {
  // Keep the selected service identity stable while its platform reader loads.
  const serviceEnv = { ...env };
  const readOptions = options && {
    ...options,
    systemdReadTarget: options.systemdReadTarget && { ...options.systemdReadTarget },
  };
  switch (process.platform) {
    case "darwin":
      return (await import("./launchd-runtime.js")).readLaunchAgentProgramArguments(
        serviceEnv,
        readOptions,
      );
    case "linux":
      return (await import("./systemd-service-files.js")).readSystemdServiceExecStart(
        serviceEnv,
        readOptions,
      );
    case "win32":
      return (await import("./schtasks-layout.js")).readScheduledTaskCommand(
        serviceEnv,
        readOptions,
      );
    default:
      return null;
  }
};
