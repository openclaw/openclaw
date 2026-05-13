export function resolveStrictToolMode(params: {
  strict?: boolean | null | undefined;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (params.strict !== undefined && params.strict !== null) {
    return params.strict;
  }
  const env = params.env ?? process.env;
  const envValue = (env.OPENCLAW_STRICT_TOOL_MODE ?? "").trim().toLowerCase();
  if (envValue === "1" || envValue === "true") {
    return true;
  }
  return false;
}
