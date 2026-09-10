import { extractFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";
import type { ParsedSkillFrontmatter } from "../types.js";
import { resolveSkillInvocationPolicy } from "./frontmatter.js";
import { createSyntheticSourceInfo, type Skill } from "./skill-contract.js";

const SKILL_TITLE_HEADING = /^#\s+(.+?)\s*#*\s*$/mu;

function humanizeSkillIdentifier(value: string): string {
  return value
    .trim()
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function resolveSkillDisplayName(content: string, fallbackName: string): string {
  const body = extractFrontmatterBlock(content)?.body ?? content;
  const heading = body.match(SKILL_TITLE_HEADING)?.[1]?.trim();
  const displayName = heading || humanizeSkillIdentifier(fallbackName) || fallbackName;
  // A captured heading can retain the whole skill body in metadata caches.
  // Copy UTF-16 code units without changing lone surrogates.
  return Buffer.from(displayName, "utf16le").toString("utf16le");
}

export function materializeSkill(params: {
  content: string;
  frontmatter: ParsedSkillFrontmatter;
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  sourceOptions: Omit<Parameters<typeof createSyntheticSourceInfo>[1], "baseDir">;
}): Skill {
  return {
    name: params.name,
    displayName: resolveSkillDisplayName(params.content, params.frontmatter.name || params.name),
    description: params.description,
    filePath: params.filePath,
    baseDir: params.baseDir,
    source: params.source,
    sourceInfo: createSyntheticSourceInfo(params.filePath, {
      ...params.sourceOptions,
      baseDir: params.baseDir,
    }),
    disableModelInvocation: resolveSkillInvocationPolicy(params.frontmatter).disableModelInvocation,
  };
}
