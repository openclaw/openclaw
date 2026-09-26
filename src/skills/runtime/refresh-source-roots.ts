import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isDefaultStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import {
  resolvePluginSkillRoots,
  resolvePluginSkillRootsFromMetadata,
} from "../loading/plugin-skills.js";
import { resolveAllowedSkillSymlinkTargetRealPaths } from "../loading/symlink-targets.js";
import { resolveWorkspaceSkillDirectories } from "../loading/workspace-skill-roots.js";
import type { WorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { resolveWorkshopWatchRoots } from "../workshop/skills-root.js";

export function resolveSkillsWatchSourceRoots(
  workspaceDir: string,
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
  executionWorkspaceDir: string | undefined,
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined,
  sourcePlan?: WorkspaceSkillSourcePlan,
) {
  const executionRoots = executionWorkspaceDir
    ? resolveWorkspaceSkillDirectories(executionWorkspaceDir)
    : [];
  let baseRoots: Array<{ path: string; source: string }>;
  let extraDirs: string[];
  let pluginSkillDirs: string[];
  let allowedSymlinkTargetRealPaths: string[];
  if (sourcePlan) {
    // The remote adapter supplies the same admitted discovery roots in host paths.
    // Resolve symlinks here, on the filesystem that actually owns those roots.
    baseRoots = sourcePlan.roots
      .filter((root) => !["extra", "bundled"].includes(root.tier))
      .map((root) => ({ path: root.dir, source: root.source }));
    extraDirs = sourcePlan.roots.filter((root) => root.tier === "extra").map((root) => root.dir);
    pluginSkillDirs = sourcePlan.pluginSkillRoots.map((root) => root.dir);
    allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths({
      skills: { load: { allowSymlinkTargets: sourcePlan.allowSymlinkTargets } },
    });
  } else {
    baseRoots = resolveWorkspaceSkillDirectories(workspaceDir).map(({ dir, source }) => ({
      path: dir,
      source,
    }));
    baseRoots.push(...resolveWorkshopWatchRoots(config, agentId));
    baseRoots.push({ path: path.join(CONFIG_DIR, "skills"), source: "openclaw-managed" });
    if (isDefaultStateDir()) {
      baseRoots.push({
        path: path.join(os.homedir(), ".agents", "skills"),
        source: "agents-skills-personal",
      });
    }
    const extraDirsRaw = config?.skills?.load?.extraDirs ?? [];
    extraDirs = extraDirsRaw
      .map((d) => normalizeOptionalString(d) ?? "")
      .filter(Boolean)
      .map((dir) => resolveUserPath(dir));
    const pluginSkillRoots = pluginMetadataSnapshot
      ? resolvePluginSkillRootsFromMetadata({
          workspaceDir,
          config,
          metadataSnapshot: pluginMetadataSnapshot,
        })
      : resolvePluginSkillRoots({ workspaceDir, config });
    pluginSkillDirs = pluginSkillRoots.map((root) => root.dir);
    allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths(config);
  }
  return { executionRoots, baseRoots, extraDirs, pluginSkillDirs, allowedSymlinkTargetRealPaths };
}
