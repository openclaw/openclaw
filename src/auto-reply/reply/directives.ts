import { escapeRegExp } from "../../shared/regexp.js";
import {
  type ReasoningLevel,
  type TraceLevel,
  type ElevatedLevel,
  normalizeFastMode,
  normalizeElevatedLevel,
  normalizeReasoningLevel,
  normalizeTraceLevel,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.shared.js";
import { removeDirectiveSpan, skipDirectiveArgPrefix } from "./directive-parsing.js";

type NamedLevelDirective<T, Field extends string> = {
  cleaned: string;
  rawLevel?: string;
  hasDirective: boolean;
} & {
  [Key in Field]?: T;
};

type LevelDirectiveParseOptions = {
  strict?: boolean;
};

const compileDirectivePattern = (names: readonly string[]): RegExp => {
  const namePattern = names.map(escapeRegExp).join("|");
  return new RegExp(`(?<!\\S)\\/(?:${namePattern})(?=$|\\s|:)`, "i");
};

const matchLevelDirective = (
  body: string,
  pattern: RegExp,
  normalize: (raw?: string) => unknown,
  options?: LevelDirectiveParseOptions,
): { start: number; end: number; rawLevel?: string } | null => {
  const match = body.match(pattern);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index;
  const directiveEnd = match.index + match[0].length;
  const prefixEnd = directiveEnd + skipDirectiveArgPrefix(body.slice(directiveEnd));
  const argument = (options?.strict ? /^\s*(\S+)/ : /^\s*([A-Za-z-]+)/).exec(body.slice(prefixEnd));
  const end = prefixEnd + (argument?.[0].length ?? 0);
  const candidate = argument?.[1];
  if (
    candidate !== undefined &&
    (options?.strict || normalize(candidate) !== undefined || body.slice(end).trim().length === 0)
  ) {
    return { start, end, rawLevel: candidate };
  }
  return { start, end: prefixEnd };
};

function createLevelDirectiveExtractor<T, Field extends string>(
  names: readonly string[],
  field: Field,
  normalize: (raw?: string) => T | undefined,
): (body?: string, options?: LevelDirectiveParseOptions) => NamedLevelDirective<T, Field> {
  const pattern = compileDirectivePattern(names);
  return (body, options) => {
    if (!body) {
      return { cleaned: "", hasDirective: false } as NamedLevelDirective<T, Field>;
    }
    const match = matchLevelDirective(body, pattern, normalize, options);
    return {
      cleaned: match ? removeDirectiveSpan(body, match.start, match.end) : body,
      [field]: match ? normalize(match.rawLevel) : undefined,
      rawLevel: match?.rawLevel,
      hasDirective: match !== null,
    } as NamedLevelDirective<T, Field>;
  };
}

export const extractThinkDirective = createLevelDirectiveExtractor(
  ["thinking", "think", "t"],
  "thinkLevel",
  normalizeThinkLevel,
);
export const extractVerboseDirective = createLevelDirectiveExtractor(
  ["verbose", "v"],
  "verboseLevel",
  normalizeVerboseLevel,
);
export const extractTraceDirective = createLevelDirectiveExtractor(
  ["trace"],
  "traceLevel",
  normalizeTraceLevel,
);
export const extractFastDirective = createLevelDirectiveExtractor(
  ["fast"],
  "fastMode",
  normalizeFastMode,
);
export const extractElevatedDirective = createLevelDirectiveExtractor(
  ["elevated", "elev"],
  "elevatedLevel",
  normalizeElevatedLevel,
);
export const extractReasoningDirective = createLevelDirectiveExtractor(
  ["reasoning", "reason"],
  "reasoningLevel",
  normalizeReasoningLevel,
);

export type { ElevatedLevel, ReasoningLevel, ThinkLevel, TraceLevel, VerboseLevel };
export { extractExecDirective } from "./exec/directive.js";
export { extractStatusDirective } from "./reply-inline.js";
