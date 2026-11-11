import { basename, resolve } from "node:path";
import { validateRequestedSkillSlug } from "../skills/lifecycle/install-paths.js";
import { loadSingleSkillDirectory } from "../skills/loading/local-loader.js";
import type { TemplateDirectorySnapshot } from "./dependency-directory.js";
import { digestTemplateBytes } from "./digest.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";

export function inspectTemplateBundledSkill(
  rootDir: string,
  path: string,
  snapshot: TemplateDirectorySnapshot,
) {
  const file = snapshot.files.find((entry) => entry.path === "SKILL.md");
  if (!file) {
    throw new Error(`Bundled skill ${path} is missing SKILL.md.`);
  }
  const skillDir = resolve(rootDir, path);
  const loaded = loadSingleSkillDirectory({
    skillDir,
    rootRealPath: skillDir,
    source: "template-bundled",
    maxBytes: MAX_MANAGED_FILE_BYTES,
  });
  if (!loaded || digestTemplateBytes(Buffer.from(loaded.content)) !== file.digest) {
    throw new Error(`Bundled skill ${path} has invalid or changed SKILL.md.`);
  }
  let installId: string;
  try {
    installId = validateRequestedSkillSlug(loaded.skill.name);
  } catch {
    installId = validateRequestedSkillSlug(basename(path));
  }
  return { name: loaded.skill.name, installId };
}
