import type { ParsedSkillFrontmatter } from "../types.js";

export type RawMetaFrontmatter = {
  name?: unknown;
  description?: unknown;
  kind?: unknown;
  triggers?: unknown;
  composition?: unknown;
  final_text_mode?: unknown;
};

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"')) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function decodeMetaFrontmatter(frontmatter: ParsedSkillFrontmatter): RawMetaFrontmatter {
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    kind: frontmatter.kind,
    triggers: parseMaybeJson(frontmatter.triggers),
    composition: parseMaybeJson(frontmatter.composition),
    final_text_mode: parseMaybeJson(frontmatter.final_text_mode),
  };
}
