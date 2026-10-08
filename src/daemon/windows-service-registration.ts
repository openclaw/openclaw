import path from "node:path";
import { resolveStartupEntryPaths } from "./schtasks-layout.js";
import type { WindowsServiceRegistrationKind } from "./service-stage.js";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";

/** The effective command inspector emits Startup paths only after proving task absence. */
export function getWindowsServiceRegistrationKind(
  command: GatewayServiceCommandConfig | null,
): WindowsServiceRegistrationKind {
  return command?.startupEntryPaths?.length ? "startup" : "scheduled-task";
}

/** Retain the registration bytes, including absent aliases, while replacing its command. */
export function getWindowsStartupRegistrationGuards(
  env: GatewayServiceEnv,
  command: GatewayServiceCommandConfig,
): string[] {
  if (getWindowsServiceRegistrationKind(command) !== "startup") {
    return [];
  }
  const paths = resolveStartupEntryPaths(env);
  const normalize = (file: string) => path.win32.normalize(file).toLowerCase();
  const owned = new Set(paths.map(normalize));
  const observed = (command.startupEntryPaths ?? []).map(normalize);
  if (
    !observed.length ||
    new Set(observed).size !== observed.length ||
    observed.some((file) => !owned.has(file))
  ) {
    throw new Error("Startup registration selects an unrecognized launcher.");
  }
  return paths;
}
