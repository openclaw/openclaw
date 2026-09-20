// Skill tools directory helpers resolve local tool paths exposed to skill runtimes.
import path from "node:path";
import { safePathSegmentHashed } from "../../infra/install-safe-path.js";
import { resolveConfigDir } from "../../utils.js";

/** Resolves a skill's tools directory relative to the OpenClaw config dir. */
export function resolveSkillToolsRootDir(skillKey: string): string {
  const safeKey = safePathSegmentHashed(skillKey);
  return path.join(resolveConfigDir(), "tools", safeKey);
}
