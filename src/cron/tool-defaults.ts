export type CronToolDefaultsMode = "exact" | "defaults";

/**
 * Resolve requested tools before ordinary policy intersection. Run callers use
 * the result only for execution, never to rewrite a saved or approved job.
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
