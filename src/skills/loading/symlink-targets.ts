import fs from "node:fs";
import {
  normalizeTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveUserPath } from "../../utils.js";

export function resolveAllowedSkillSymlinkTargetRealPaths(config?: OpenClawConfig): string[] {
  const targetPaths = normalizeTrimmedStringList(config?.skills?.load?.allowSymlinkTargets)
    .map((dir) => tryRealpath(resolveUserPath(dir)))
    .filter((dir): dir is string => Boolean(dir));
  return uniqueStrings(targetPaths);
}

export function tryRealpath(filePath: string): string | null {
  try {
    // Match fs-safe's final admission, including on-disk casing on macOS.
    return fs.realpathSync.native(filePath);
  } catch {
    return null;
  }
}
