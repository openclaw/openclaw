const AUTO_MAINTENANCE_CONFIG = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
] as const;

export const AGENT_GIT_CONFIG_PARAMETERS = AUTO_MAINTENANCE_CONFIG.map(
  ([key, value]) => `'${key}=${value}'`,
).join(" ");

export const gitMaintenanceEnvironment = (env: NodeJS.ProcessEnv = {}) =>
  appendGitConfig(env, AUTO_MAINTENANCE_CONFIG);

/** Git parses GIT_CONFIG_COUNT as base-10 digits only; anything else makes every git command fail. */
function resolveGitConfigStartIndex(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return 0;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Append entries without replacing configuration already owned by the caller. */
export function appendGitConfig(
  env: NodeJS.ProcessEnv,
  entries: readonly (readonly [string, string])[],
): NodeJS.ProcessEnv {
  const result = { ...env };
  let index = resolveGitConfigStartIndex(env.GIT_CONFIG_COUNT);
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
