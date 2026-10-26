import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import { readWorkspaceSkillStatusFacts } from "../discovery/status-files.js";
import type { SkillEntry } from "../types.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { hasBinary, resolveSkillRequiredBins } from "./config.js";
import { loadSingleSkillDirectory } from "./local-loader.js";
import { createSkillEntry } from "./skill-entry-metadata.js";
import { mergeSkillRecords } from "./skill-precedence.js";
import { resolveSkillDiscoveryLimits } from "./skill-root-discovery.js";
import {
  loadWorkspaceSkillSourceEntries,
  loadExecutionSkillEntries,
  warnInvalidSkill,
  type SkillSourceReadBatch,
} from "./skill-root-loader.js";
import { tryRealpath } from "./symlink-targets.js";
import type {
  WorkspaceSkillSourceRequest,
  WorkspaceSkillSources,
} from "./workspace-skill-sources.types.js";

/** Run on the workspace host using an admitted source plan and native discovery limits. */
export function readWorkspaceSkillSources(
  request: WorkspaceSkillSourceRequest,
  batch?: SkillSourceReadBatch,
): WorkspaceSkillSources {
  const config: OpenClawConfig = {
    skills: {
      limits: request.limits,
      load: { allowSymlinkTargets: request.sourcePlan.allowSymlinkTargets },
    },
  };
  const entries =
    request.bundledSkillName !== undefined
      ? readBundledSkillEntries(request.bundledSkillName, {
          config,
          bundledSkillsDir: request.sourcePlan.bundledSkillsDir,
        })
      : loadWorkspaceSkillSourceEntries(request.sourcePlan, config, batch);
  const executionEntries = request.executionWorkspaceDir
    ? loadExecutionSkillEntries(request.executionWorkspaceDir, config, batch)
    : [];
  const bins = [
    ...new Set([
      "brew",
      "npm",
      "pnpm",
      "yarn",
      "bun",
      "uv",
      "go",
      ...request.additionalBins,
      ...entries.concat(executionEntries).flatMap(resolveSkillRequiredBins),
    ]),
  ]
    .filter(hasBinary)
    .toSorted();
  return {
    entries,
    executionEntries,
    runtime: { platform: process.platform, bins },
    ...(request.status
      ? {
          status: readWorkspaceSkillStatusFacts({
            entries: mergeSkillRecords(entries, request.sourcePlan.workspaceDir),
            workspaceDir: request.sourcePlan.workspaceDir,
            managedSkillsDir: request.sourcePlan.managedSkillsDir,
            skillCardKey: request.status.skillCardKey,
          }),
        }
      : {}),
  };
}

/** Read a single bundle with the same boundary and file limits as local discovery. */
function readBundledSkillEntries(
  skillName: string,
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
    onDiagnostic: (diagnostic) => warnInvalidSkill("openclaw-bundled", diagnostic),
  });
  if (!loaded || loaded.skill.name.trim().toLowerCase() !== normalizedName) {
    return [];
  }
  return [createSkillEntry(loaded)];
}
