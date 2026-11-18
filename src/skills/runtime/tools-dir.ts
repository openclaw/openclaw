import path from "node:path";
import { safePathSegmentHashed } from "../../infra/install-safe-path.js";
import { resolveConfigDir } from "../../utils.js";

export function resolveSkillToolsRootDir(skillKey: string): string {
  const safeKey = safePathSegmentHashed(skillKey);
  return path.join(resolveConfigDir(), "tools", safeKey);
}
