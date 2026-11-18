import { readLaunchAgentProgramArguments } from "./launchd-runtime.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";
import type { GatewayService } from "./service-types.js";
import { readSystemdServiceExecStart } from "./systemd-service-files.js";

const commandReaders: Partial<Record<NodeJS.Platform, GatewayService["readCommand"]>> = {
  darwin: readLaunchAgentProgramArguments,
  linux: readSystemdServiceExecStart,
  win32: readScheduledTaskCommand,
};

export const readGatewayServiceCommand: GatewayService["readCommand"] = (env, options) =>
  commandReaders[process.platform]?.(env, options) ?? Promise.resolve(null);
