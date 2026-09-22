import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readRootJsonObjectSync } from "../../infra/json-files.js";
import type { OpenClawSkillMetadata, ParsedSkillFrontmatter } from "../types.js";
import { resolveSkillManifestMetadata } from "./frontmatter.js";
import { SKILL_SOURCE_ORIGIN_RELATIVE_PATH } from "./skill-entry-metadata-path.js";
import { tryRealpath } from "./symlink-targets.js";

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

export function resolveSkillEntryMetadata(params: {
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
