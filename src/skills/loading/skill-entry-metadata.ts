import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readRootJsonObjectSync } from "../../infra/json-files.js";
import { resolveSkillInvocationPolicy, resolveSkillManifestMetadata } from "./frontmatter.js";
import { SKILL_SOURCE_ORIGIN_RELATIVE_PATH } from "./skill-entry-metadata-path.js";
import { tryRealpath } from "./symlink-targets.js";
import type { WorkspaceSkillSources } from "./workspace-skill-sources.types.js";

const MAX_SKILL_SOURCE_ORIGIN_BYTES = 16 * 1024;

function readSourceInstallSkillKey(skillDir: string): string | undefined {
  try {
    const sourceOriginPath = path.join(skillDir, SKILL_SOURCE_ORIGIN_RELATIVE_PATH);
    const parentRealPath = tryRealpath(path.dirname(sourceOriginPath));
    if (!parentRealPath) {
      return undefined;
    }
    const skillDirRealPath = tryRealpath(skillDir);
    if (!skillDirRealPath) {
      return undefined;
    }
    // Preserve contained parent aliases while refusing final symlinks.
    const result = readRootJsonObjectSync({
      rootDir: skillDirRealPath,
      rootRealPath: skillDirRealPath,
      relativePath: path.relative(
        skillDirRealPath,
        path.join(parentRealPath, path.basename(sourceOriginPath)),
      ),
      boundaryLabel: "skill directory",
      rejectHardlinks: false,
      maxBytes: MAX_SKILL_SOURCE_ORIGIN_BYTES,
    });
    return result.ok ? normalizeOptionalString(result.value.slug) : undefined;
  } catch {
    return undefined;
  }
}

export function createSkillEntry(
  record: Pick<
    WorkspaceSkillSources["entries"][number],
    "skill" | "frontmatter" | "sourceOrder" | "syncSourceDir" | "syncDirName"
  >,
): WorkspaceSkillSources["entries"][number] {
  const { skill, frontmatter } = record;
  const invocation = resolveSkillInvocationPolicy(frontmatter);
  let metadata = resolveSkillManifestMetadata(frontmatter);
  if (!metadata?.skillKey) {
    const skillKey = readSourceInstallSkillKey(skill.baseDir);
    if (skillKey) {
      metadata = { ...metadata, skillKey };
    }
  }
  return {
    ...(record.sourceOrder !== undefined ? { sourceOrder: record.sourceOrder } : {}),
    skill,
    frontmatter,
    metadata,
    invocation,
    exposure: {
      includeInRuntimeRegistry: true,
      includeInAvailableSkillsPrompt: !invocation.disableModelInvocation,
      userInvocable: invocation.userInvocable ?? true,
    },
    ...(record.syncSourceDir !== undefined ? { syncSourceDir: record.syncSourceDir } : {}),
    ...(record.syncDirName !== undefined ? { syncDirName: record.syncDirName } : {}),
  };
}
