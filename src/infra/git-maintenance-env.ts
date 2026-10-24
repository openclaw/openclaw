const AUTO_MAINTENANCE_CONFIG = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
] as const;

export const AGENT_GIT_CONFIG_PARAMETERS = AUTO_MAINTENANCE_CONFIG.map(
  ([key, value]) => `'${key}=${value}'`,
).join(" ");

/** Append to the command owner's config; explicit scheduled maintenance still runs. */
export function gitMaintenanceEnvironment(offset = 0): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: String(offset + AUTO_MAINTENANCE_CONFIG.length),
    ...Object.fromEntries(
      AUTO_MAINTENANCE_CONFIG.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${offset + index}`, key],
        [`GIT_CONFIG_VALUE_${offset + index}`, value],
      ]),
    ),
  };
}
