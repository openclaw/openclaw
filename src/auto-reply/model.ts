// `/model` directive parser for auto-reply messages.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { ModelSelectionScope } from "../config/types.agent-defaults.js";
import { escapeRegExp } from "../shared/regexp.js";
import { removeDirectiveSpan } from "./reply/directive-parsing.js";

export type { ModelSelectionScope } from "../config/types.agent-defaults.js";

const QUOTED_ATOM_PATTERN = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const QUOTED_ATOM_RE = new RegExp(`^${QUOTED_ATOM_PATTERN}$`);
const QUOTED_MODEL_PREFIX_RE = new RegExp(`^${QUOTED_ATOM_PATTERN}`, "i");
const UNQUOTED_MODEL_REF_PATTERN = String.raw`[A-Za-z0-9_.:@-]+(?:\/[A-Za-z0-9_.:@-]+)*`;
const MODEL_REF_PATTERN = String.raw`(?:(?:${QUOTED_ATOM_PATTERN}|${UNQUOTED_MODEL_REF_PATTERN})@${QUOTED_ATOM_PATTERN}|${UNQUOTED_MODEL_REF_PATTERN})`;
const MODEL_RUNTIME_VALUE_PATTERN = String.raw`[A-Za-z0-9_.:-]+`;
const MODEL_SCOPE_OPTION_PATTERN = String.raw`(?:--session|-s|--agent|-a|--global|-g)(?=$|\s)`;
const MODEL_OPTION_PATTERN = String.raw`(?:(?:${MODEL_SCOPE_OPTION_PATTERN}|--runtime)(?=$|\s)|runtime=|harness=)`;
const MODEL_RUNTIME_OPTION_PATTERN = String.raw`(?:--runtime|runtime=|harness=)\s*((?!${MODEL_OPTION_PATTERN})${MODEL_RUNTIME_VALUE_PATTERN})`;
// Captures 2/3 are runtime-first; 4/5 are scope-first so duplicates stay unconsumed.
const MODEL_TRAILING_OPTIONS_PATTERN = String.raw`(?:(?:\s+(?:--runtime|runtime=|harness=)\s*((?!${MODEL_OPTION_PATTERN})${MODEL_RUNTIME_VALUE_PATTERN}))(\s+${MODEL_SCOPE_OPTION_PATTERN})?|(\s+${MODEL_SCOPE_OPTION_PATTERN})(?:\s+(?:--runtime|runtime=|harness=)\s*((?!${MODEL_OPTION_PATTERN})${MODEL_RUNTIME_VALUE_PATTERN}))?)?`;
const MODEL_OPTIONS_ONLY_DIRECTIVE_PATTERN = new RegExp(
  String.raw`(?<!\S)\/model(?=$|\s|:)\s*:?\s*(?:${MODEL_RUNTIME_OPTION_PATTERN}(\s+${MODEL_SCOPE_OPTION_PATTERN})?|(${MODEL_SCOPE_OPTION_PATTERN})(?:\s+${MODEL_RUNTIME_OPTION_PATTERN})?)`,
  "i",
);
const MODEL_DIRECTIVE_PATTERN = new RegExp(
  String.raw`(?<!\S)\/model(?=$|\s|:)(?:\s*:)?(?:\s*((?!${MODEL_OPTION_PATTERN})${MODEL_REF_PATTERN}))?${MODEL_TRAILING_OPTIONS_PATTERN}`,
  "i",
);

function parseModelScope(raw: string | undefined): ModelSelectionScope | undefined {
  switch (raw?.trim().toLowerCase()) {
    case "-s":
    case "--session":
      return "session";
    case "-a":
    case "--agent":
      return "agent";
    case "-g":
    case "--global":
      return "global";
    default:
      return undefined;
  }
}

function parseModelDirectiveMatch(match: RegExpMatchArray | null) {
  return {
    rawModel: match?.[1]?.trim(),
    rawRuntime: (match?.[2] ?? match?.[5])?.trim(),
    scope: parseModelScope(match?.[3] ?? match?.[4]),
  };
}

function hasAdditionalModelScope(body: string, match: RegExpMatchArray | null): boolean {
  if (!match || match.index === undefined) {
    return false;
  }
  const trailing = body.slice(match.index + match[0].length);
  return new RegExp(String.raw`^\s+${MODEL_SCOPE_OPTION_PATTERN}`, "i").test(trailing);
}

/** Extract and remove a `/model` directive, including optional auth profile/runtime hints. */
export function extractModelDirective(
  body?: string,
  options?: { aliases?: string[] },
): {
  cleaned: string;
  rawModel?: string;
  rawProfile?: string;
  rawRuntime?: string;
  scope?: ModelSelectionScope;
  scopeConflict: boolean;
  hasDirective: boolean;
  source?: "alias" | "model";
} {
  if (!body) {
    return { cleaned: "", scopeConflict: false, hasDirective: false };
  }

  const modelDirectiveMatch = MODEL_DIRECTIVE_PATTERN.exec(body);
  const modelReference = modelDirectiveMatch?.[1];
  const quotedModel = modelReference?.startsWith('"')
    ? QUOTED_MODEL_PREFIX_RE.exec(modelReference)?.[0]
    : undefined;
  const quotedProfileOffset = quotedModel?.length ?? modelReference?.indexOf('@"') ?? -1;
  const quotedProfile =
    quotedProfileOffset >= 0 ? modelReference?.slice(quotedProfileOffset + 1) : undefined;
  // Commands ignore case, but JSON string escapes are case-sensitive.
  if (
    (quotedModel !== undefined && !QUOTED_ATOM_RE.test(quotedModel)) ||
    (quotedProfile !== undefined && !QUOTED_ATOM_RE.test(quotedProfile)) ||
    (modelDirectiveMatch?.index !== undefined &&
      (!modelReference || modelReference.endsWith("@")) &&
      body
        .slice(modelDirectiveMatch.index + modelDirectiveMatch[0].length)
        .trimStart()
        .startsWith('"'))
  ) {
    return { cleaned: body, scopeConflict: false, hasDirective: false };
  }
  const modelOptionsOnlyMatch =
    quotedProfile === undefined ? MODEL_OPTIONS_ONLY_DIRECTIVE_PATTERN.exec(body) : null;
  const modelMatch = modelOptionsOnlyMatch ?? modelDirectiveMatch;

  const aliases = normalizeStringEntries(options?.aliases);
  const aliasMatch =
    modelMatch || aliases.length === 0
      ? null
      : new RegExp(
          String.raw`(?<!\S)\/(${aliases.map(escapeRegExp).join("|")})(?=$|\s|:)(?:\s*:)?${MODEL_TRAILING_OPTIONS_PATTERN}`,
          "i",
        ).exec(body);

  const match = modelMatch ?? aliasMatch;
  const parsed = modelOptionsOnlyMatch
    ? {
        rawModel: undefined,
        rawRuntime: (modelOptionsOnlyMatch[1] ?? modelOptionsOnlyMatch[4])?.trim(),
        scope: parseModelScope(modelOptionsOnlyMatch[2] ?? modelOptionsOnlyMatch[3]),
      }
    : parseModelDirectiveMatch(match);
  const { rawModel: raw, rawRuntime, scope } = parsed;

  let rawModel = raw;
  let rawProfile: string | undefined;
  if (raw && quotedProfile !== undefined) {
    rawModel =
      quotedModel === undefined
        ? raw.slice(0, quotedProfileOffset)
        : normalizeOptionalString(JSON.parse(quotedModel));
    rawProfile = normalizeOptionalString(JSON.parse(quotedProfile));
  } else if (raw) {
    const split = splitTrailingAuthProfile(raw);
    rawModel = split.model;
    rawProfile = split.profile;
  }

  const cleaned = match
    ? removeDirectiveSpan(body, match.index, match.index + match[0].length)
    : body;

  return {
    cleaned,
    rawModel,
    rawProfile,
    rawRuntime,
    scope,
    scopeConflict: hasAdditionalModelScope(body, match),
    hasDirective: Boolean(match),
    ...(match ? { source: modelMatch ? ("model" as const) : ("alias" as const) } : {}),
  };
}
