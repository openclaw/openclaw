import { parse } from "yaml";
import { extractFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";

type ParsedFrontmatter<T extends Record<string, unknown>> = {
  frontmatter: T;
  body: string;
};

const normalizeNewlines = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

export const parsePromptFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): ParsedFrontmatter<T> => {
  const normalized = normalizeNewlines(content);
  const extracted = extractFrontmatterBlock(normalized);
  if (!extracted) {
    return { frontmatter: {} as T, body: normalized };
  }
  const parsed = parse(extracted.block);
  return { frontmatter: (parsed ?? {}) as T, body: extracted.body.trim() };
};

export const stripFrontmatter = (content: string): string => parsePromptFrontmatter(content).body;
