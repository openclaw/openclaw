import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import type { SkillEntry } from "../types.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { loadSingleSkillDirectory } from "./local-loader.js";
import { createSkillEntry } from "./skill-entry-metadata.js";
import type { createSkillLoadDiagnostics } from "./skill-load-diagnostics.js";
import { resolveSkillDiscoveryLimits } from "./skill-root-discovery.js";
import { warnInvalidSkill } from "./skill-root-loader.js";
import { tryRealpath } from "./symlink-targets.js";

/** Read a single bundle with the same boundary and file limits as local discovery. */
export function readBundledSkillEntries(
  skillName: string,
  diagnostics: ReturnType<typeof createSkillLoadDiagnostics>,
  opts?: { config?: OpenClawConfig; bundledSkillsDir?: string },
): SkillEntry[] {
  const normalizedName = skillName.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalizedName)) {
    return [];
  }
  const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
  const rootRealPath = bundledSkillsDir ? tryRealpath(bundledSkillsDir) : undefined;
  if (!rootRealPath) {
    return [];
  }
  const limits = resolveSkillDiscoveryLimits(opts?.config);
  const loaded = loadSingleSkillDirectory({
    skillDir: path.join(rootRealPath, normalizedName),
    source: "openclaw-bundled",
    rootRealPath,
    maxBytes: limits.maxSkillFileBytes,
    rejectHardlinks: shouldRejectHardlinkedPluginFiles({
      origin: "bundled",
      rootDir: rootRealPath,
    }),
    onDiagnostic: (diagnostic) => {
      diagnostics.add(diagnostic);
      warnInvalidSkill("openclaw-bundled", diagnostic);
    },
  });
  if (!loaded || loaded.skill.name.trim().toLowerCase() !== normalizedName) {
    return [];
  }
  return [createSkillEntry(loaded)];
}
