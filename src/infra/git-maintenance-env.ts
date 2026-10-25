const AUTO_MAINTENANCE_CONFIG = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
] as const;

export const AGENT_GIT_CONFIG_PARAMETERS = AUTO_MAINTENANCE_CONFIG.map(
  ([key, value]) => `'${key}=${value}'`,
).join(" ");

export const gitMaintenanceEnvironment = () => appendGitConfig({}, AUTO_MAINTENANCE_CONFIG);

/** Self-contained so generated worker scripts use the same entry numbering. */
export function appendGitConfig(
  env: NodeJS.ProcessEnv,
  entries: readonly (readonly [string, string])[],
): NodeJS.ProcessEnv {
  const result = { ...env };
  let index = Number(env.GIT_CONFIG_COUNT ?? 0);
  for (const [key, value] of entries) {
    result[`GIT_CONFIG_KEY_${index}`] = key;
    result[`GIT_CONFIG_VALUE_${index++}`] = value;
  }
  result.GIT_CONFIG_COUNT = String(index);
  return result;
}
