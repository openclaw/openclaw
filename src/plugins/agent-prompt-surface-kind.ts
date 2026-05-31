import type { AgentPromptSurfaceKind } from "./types.js";

/** Normalizes legacy Pi surface names to the current OpenClaw main prompt surface. */
export function normalizeAgentPromptSurfaceKind(
  surface: AgentPromptSurfaceKind,
): AgentPromptSurfaceKind {
  return surface === "pi_main" ? "openclaw_main" : surface;
}

/** Returns true for the canonical main prompt surface and its legacy aliases. */
export function isOpenClawMainPromptSurface(surface: AgentPromptSurfaceKind): boolean {
  return normalizeAgentPromptSurfaceKind(surface) === "openclaw_main";
}
