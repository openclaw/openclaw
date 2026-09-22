import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { openRootFileSync, readFileDescriptorBoundedSync } from "../../infra/boundary-file-read.js";
import type { OpenClawSkillMetadata, ParsedSkillFrontmatter } from "../types.js";
import { resolveSkillManifestMetadata } from "./frontmatter.js";
import { tryRealpath } from "./symlink-targets.js";

const SKILL_SOURCE_ORIGIN_RELATIVE_PATH = path.join(".openclaw", "source-origin.json");
const MAX_SKILL_SOURCE_ORIGIN_BYTES = 16 * 1024;

function readSourceInstallSkillKey(skillDir: string): string | undefined {
  try {
    const sourceOriginPath = path.join(skillDir, SKILL_SOURCE_ORIGIN_RELATIVE_PATH);
    const skillDirRealPath = tryRealpath(skillDir);
    const parentRealPath = tryRealpath(path.dirname(sourceOriginPath));
    if (!skillDirRealPath || !parentRealPath) {
      return undefined;
    }
    // Preserve contained parent aliases while refusing final symlinks.
    const opened = openRootFileSync({
      absolutePath: path.join(parentRealPath, path.basename(sourceOriginPath)),
      rootPath: skillDirRealPath,
      rootRealPath: skillDirRealPath,
      boundaryLabel: "skill directory",
      rejectHardlinks: false,
      maxBytes: MAX_SKILL_SOURCE_ORIGIN_BYTES,
    });
    if (!opened.ok) {
      return undefined;
    }
    try {
      const raw = readFileDescriptorBoundedSync(opened.fd, MAX_SKILL_SOURCE_ORIGIN_BYTES).toString(
        "utf8",
      );
      const parsed = asOptionalRecord(JSON.parse(raw) as unknown);
      return normalizeOptionalString(parsed?.slug);
    } finally {
      fs.closeSync(opened.fd);
    }
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
