// Skill authoring for the calling plugin's own per-agent skills root (its manifest
// `agentSkillsDir`). The host resolves that root from the plugin invocation scope, keeps path
// confinement, limits, frontmatter rules and the security scan, refreshes discovery, and
// dispatches `skill_changed`; plugins keep their own naming, versioning and messages.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureCurrentPluginInstanceAuthority } from "../plugins/plugin-instance-scope.js";
import * as authoring from "../skills/lifecycle/skill-authoring.js";

export {
  MAX_SKILL_DESCRIPTION_BYTES,
  MAX_SKILL_SUPPORT_FILE_BYTES,
  normalizeSkillFilePath,
  parseSkillFrontmatter,
  SKILL_FILE,
  SkillAuthoringError,
  splitSkillFrontmatter,
  type SkillAuthoringErrorCode,
  type SkillAuthoringFinding,
} from "../skills/lifecycle/skill-authoring.js";

/**
 * Validates one file's next content against the same rules `writeSkillFile` enforces: the path
 * must be `SKILL.md` or an allowed support path, then frontmatter, limits, and the security scan.
 * Returns the SKILL.md description. Throws SkillAuthoringError.
 */
export function validateSkillFile(
  params: Parameters<typeof authoring.validateSkillFileContent>[0],
): { description?: string } {
  return authoring.validateSkillFileContent({
    ...params,
    filePath: authoring.normalizeSkillFilePath(params.filePath),
  });
}

/** The agent whose skills the calling plugin reads or changes. */
export type SkillAuthoringTarget = { config: OpenClawConfig; agentId: string };

/**
 * Resolves the calling plugin's skills root and live authority from the host runtime scope.
 * A replaced, disabled, or unloaded plugin, or one whose manifest declares no
 * `agentSkillsDir`, is refused.
 */
function captureSkillsRoot(operation: string, target: SkillAuthoringTarget) {
  const authority = captureCurrentPluginInstanceAuthority();
  if (!authority) {
    throw new Error(
      `${operation} must run inside a plugin call (tool, hook, command, or service).`,
    );
  }
  authority.assertCurrent();
  const { record, assertCurrent } = authority;
  if (!record.agentSkillsDir) {
    throw new authoring.SkillAuthoringError(
      "no_skills_root",
      `Plugin ${record.id} declares no agentSkillsDir in openclaw.plugin.json, so it has no skills root to author.`,
    );
  }
  const skillsRoot = authoring.resolveAgentSkillsRoot({
    config: target.config,
    agentId: target.agentId,
    dirName: record.agentSkillsDir,
  });
  return { skillsRoot, pluginId: record.id, assertCurrent };
}

/** The calling plugin's skills root for one agent, for listing its skills. */
export function resolveSkillsRoot(target: SkillAuthoringTarget): string {
  return captureSkillsRoot("resolveSkillsRoot", target).skillsRoot;
}

/** Bounded read of one skill file that refuses links; null when it does not exist. */
export async function readSkillFile(
  params: SkillAuthoringTarget & { skillName: string; filePath: string },
): Promise<string | null> {
  const { skillsRoot } = captureSkillsRoot("readSkillFile", params);
  const filePath = authoring.normalizeSkillFilePath(params.filePath);
  return await authoring.readSkillDirFile(
    authoring.resolveSkillDir(skillsRoot, params.skillName),
    filePath,
  );
}

/** Regular files of one skill, SKILL.md first; links and dot entries are skipped. */
export async function listSkillFiles(
  params: SkillAuthoringTarget & { skillName: string },
): Promise<{ files: string[]; sizeBytes: number; updatedAtMs: number }> {
  const { skillsRoot } = captureSkillsRoot("listSkillFiles", params);
  return await authoring.listSkillDirFiles(authoring.resolveSkillDir(skillsRoot, params.skillName));
}

/** Validates, then writes one file of one skill. */
export async function writeSkillFile(
  params: SkillAuthoringTarget & {
    skillName: string;
    filePath: string;
    content: string;
    maxSkillBytes?: number;
  },
): Promise<{ description?: string }> {
  const { skillsRoot, assertCurrent } = captureSkillsRoot("writeSkillFile", params);
  return await authoring.writeSkillRootFile({ ...params, skillsRoot, assertCurrent });
}

/** Removes one support file; SKILL.md goes only with the whole skill. */
export async function removeSkillFile(
  params: SkillAuthoringTarget & { skillName: string; filePath: string },
): Promise<void> {
  const { skillsRoot, assertCurrent } = captureSkillsRoot("removeSkillFile", params);
  await authoring.removeSkillRootFile({ ...params, skillsRoot, assertCurrent });
}

/**
 * Runs one skill change, then refreshes discovery and dispatches `skill_changed` once with
 * `source: "plugin"` and the calling plugin's id. Serialize overlapping changes in the plugin.
 */
export async function commitSkillChange<T>(
  params: SkillAuthoringTarget & { skillName: string; apply: () => Promise<T> },
): Promise<T> {
  const { skillsRoot, pluginId, assertCurrent } = captureSkillsRoot("commitSkillChange", params);
  return await authoring.commitSkillRootChange({
    ...params,
    skillsRoot,
    source: "plugin",
    pluginId,
    assertCurrent,
  });
}
