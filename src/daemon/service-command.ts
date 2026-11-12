import { readLaunchAgentProgramArguments } from "./launchd-runtime.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";
import type { GatewayService } from "./service-types.js";
import { readSystemdServiceExecStart } from "./systemd-service-files.js";

export const GATEWAY_SERVICE_COMMAND_READERS = {
  darwin: readLaunchAgentProgramArguments,
  linux: readSystemdServiceExecStart,
  win32: readScheduledTaskCommand,
} satisfies Record<string, GatewayService["readCommand"]>;

export function isSupportedGatewayServicePlatform(
  platform: NodeJS.Platform,
): platform is keyof typeof GATEWAY_SERVICE_COMMAND_READERS {
  return Object.hasOwn(GATEWAY_SERVICE_COMMAND_READERS, platform);
}

export const readGatewayServiceCommand: GatewayService["readCommand"] = (env, options) =>
  isSupportedGatewayServicePlatform(process.platform)
    ? GATEWAY_SERVICE_COMMAND_READERS[process.platform](env, options)
    : Promise.resolve(null);
