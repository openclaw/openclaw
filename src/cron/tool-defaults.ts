export type CronToolDefaultsMode = "exact";

/**
 * Resolve a new tool selection before creator-policy intersection and approval.
 * This is request construction, never permission or a persisted-job migration.
 */
export function resolveCronToolDefaults(params: {
  toolsAllow: readonly string[] | null | undefined;
  defaultTools?: readonly string[];
  mode?: CronToolDefaultsMode;
}): readonly string[] | null | undefined {
  const { toolsAllow, defaultTools, mode } = params;
  if (mode === "exact" || !toolsAllow?.length || !defaultTools?.length) {
    return toolsAllow;
  }
  return [...new Set([...toolsAllow, ...defaultTools])];
}
