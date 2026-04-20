export type ToolStrictnessMode = "off" | "strict";

export function resolveToolStrictnessMode(params: {
  mode?: ToolStrictnessMode | null | undefined;
  env?: NodeJS.ProcessEnv;
}): ToolStrictnessMode {
  const env = params.env ?? process.env;
  const envMode = (env.OPENCLAW_TOOL_STRICTNESS_MODE ?? "").trim().toLowerCase();
  if (envMode === "off" || envMode === "strict") {
    return envMode;
  }
  return params.mode === "strict" ? "strict" : "off";
}

export function isStrictToolMode(mode: ToolStrictnessMode): boolean {
  return mode === "strict";
}
