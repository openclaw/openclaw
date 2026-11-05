const AUTO_MAINTENANCE_CONFIG = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
] as const;

export const AGENT_GIT_CONFIG_PARAMETERS = AUTO_MAINTENANCE_CONFIG.map(
  ([key, value]) => `'${key}=${value}'`,
).join(" ");

export const gitMaintenanceEnvironment = () => appendGitConfig({}, AUTO_MAINTENANCE_CONFIG);

/** Append entries without replacing configuration already owned by the caller. */
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

/** Serialize remote expressions without relying on compiled function source. */
export function gitMaintenanceEnvironmentExpression(
  entries: readonly (readonly [keyExpression: string, valueExpression: string])[],
): string {
  const base = gitMaintenanceEnvironment();
  const firstIndex = Number(base.GIT_CONFIG_COUNT);
  const expressions = new Set(
    entries.flatMap((_, offset) => [
      `GIT_CONFIG_KEY_${firstIndex + offset}`,
      `GIT_CONFIG_VALUE_${firstIndex + offset}`,
    ]),
  );
  const env = appendGitConfig(base, entries);
  return `{${Object.entries(env)
    .map(
      ([key, value]) =>
        `${JSON.stringify(key)}: ${expressions.has(key) ? value : JSON.stringify(value)}`,
    )
    .join(", ")}}`;
}
