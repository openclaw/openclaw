// Skill authoring for a skills root the calling plugin owns (its manifest `agentSkillsDir`).
// Core keeps path confinement, limits, frontmatter rules, the security scan, discovery refresh
// and `skill_changed` dispatch; plugins keep their own naming, versioning and messages.
import { captureCurrentPluginInstanceAuthority } from "../plugins/plugin-instance-scope.js";
import * as authoring from "../skills/lifecycle/skill-authoring.js";

export {
  listSkillFiles,
  MAX_SKILL_DESCRIPTION_BYTES,
  MAX_SKILL_SUPPORT_FILE_BYTES,
  normalizeSkillFilePath,
  parseSkillFrontmatter,
  readSkillFile,
  resolveAgentSkillsRoot,
  resolveSkillDir,
  SKILL_FILE,
  SkillAuthoringError,
  splitSkillFrontmatter,
  validateSkillFile,
  type SkillAuthoringErrorCode,
  type SkillAuthoringFinding,
} from "../skills/lifecycle/skill-authoring.js";

/**
 * Effects carry the calling plugin instance's live authority from the host runtime scope;
 * a replaced, disabled, or unloaded plugin commits nothing.
 */
function requirePluginAuthority(operation: string): () => void {
  const assertCurrent = captureCurrentPluginInstanceAuthority();
  if (!assertCurrent) {
    throw new Error(
      `${operation} must run inside a plugin call (tool, hook, command, or service).`,
    );
  }
  assertCurrent();
  return assertCurrent;
}

/** Validates, then writes one file of one skill inside the skills root. */
export async function writeSkillFile(
  params: Omit<Parameters<typeof authoring.writeSkillFile>[0], "assertCurrent">,
): Promise<{ description?: string }> {
  const assertCurrent = requirePluginAuthority("writeSkillFile");
  return await authoring.writeSkillFile({ ...params, assertCurrent });
}

/** Removes one support file; SKILL.md goes only with the whole skill. */
export async function removeSkillFile(
  params: Omit<Parameters<typeof authoring.removeSkillFile>[0], "assertCurrent">,
): Promise<void> {
  const assertCurrent = requirePluginAuthority("removeSkillFile");
  await authoring.removeSkillFile({ ...params, assertCurrent });
}

/** Runs one skill change, then refreshes discovery and dispatches `skill_changed` once. */
export async function commitSkillChange<T>(
  params: Omit<Parameters<typeof authoring.commitSkillChange<T>>[0], "assertCurrent">,
): Promise<T> {
  const assertCurrent = requirePluginAuthority("commitSkillChange");
  return await authoring.commitSkillChange({ ...params, assertCurrent });
}
