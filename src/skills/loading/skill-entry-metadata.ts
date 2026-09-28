import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readRootJsonObjectSync } from "../../infra/json-files.js";
import type { OpenClawSkillMetadata, ParsedSkillFrontmatter } from "../types.js";
import { resolveSkillInvocationPolicy, resolveSkillManifestMetadata } from "./frontmatter.js";
import { SKILL_SOURCE_ORIGIN_RELATIVE_PATH } from "./skill-entry-metadata-path.js";
import type { LoadedSkillRecord } from "./skill-root-loader.js";
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

function resolveSkillEntryMetadata(params: {
  frontmatter: ParsedSkillFrontmatter;
  skillDir: string;
}): OpenClawSkillMetadata | undefined {
  const metadata = resolveSkillManifestMetadata(params.frontmatter);
  if (metadata?.skillKey) {
    return metadata;
  }
  const sourceInstallSkillKey = readSourceInstallSkillKey(params.skillDir);
  if (!sourceInstallSkillKey) {
    return metadata;
  }
  return { ...metadata, skillKey: sourceInstallSkillKey };
}

export function createSkillEntry(
  record: LoadedSkillRecord & { sourceOrder?: number },
): WorkspaceSkillSources["entries"][number] {
  const { skill, frontmatter } = record;
  const invocation = resolveSkillInvocationPolicy(frontmatter);
  const entry: WorkspaceSkillSources["entries"][number] = {
    ...(record.sourceOrder !== undefined ? { sourceOrder: record.sourceOrder } : {}),
    skill,
    frontmatter,
    metadata: resolveSkillEntryMetadata({ frontmatter, skillDir: skill.baseDir }),
    invocation,
    exposure: {
      includeInRuntimeRegistry: true,
      includeInAvailableSkillsPrompt: !invocation.disableModelInvocation,
      userInvocable: invocation.userInvocable ?? true,
    },
  };
  if (record.syncSourceDir !== undefined) {
    entry.syncSourceDir = record.syncSourceDir;
  }
  if (record.syncDirName !== undefined) {
    entry.syncDirName = record.syncDirName;
  }
  return entry;
}
