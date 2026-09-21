import type { OpenClawConfig } from "../config/types.openclaw.js";

/** One gate for the optional full-catalog search surface and its snapshot projection. */
export function isSkillSearchEnabled(config?: OpenClawConfig): boolean {
  return config?.skills?.experimental?.search === true;
}
