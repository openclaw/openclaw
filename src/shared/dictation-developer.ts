import { indexDeveloperSymbols, parseDeveloperCommand } from "./dictation-developer-grammar.ts";
import {
  developerGraphemeBoundaries,
  exactDeveloperToken,
  lexDeveloperText,
} from "./dictation-developer-lex.ts";
import {
  DEVELOPER_LIMITS,
  type DeveloperDiagnostic,
  type DeveloperPlan,
  type DeveloperPlanRequest,
  type DeveloperRange,
} from "./dictation-developer-types.ts";

export { builtinDeveloperProfiles } from "./dictation-developer-builtins.ts";
export { DeveloperProfileRegistry, parseDeveloperProfile } from "./dictation-developer-profiles.ts";
export type { DeveloperProfileImport } from "./dictation-developer-profiles.ts";
export type {
  DeveloperMode,
  DeveloperProfile,
  DeveloperPlan,
  DeveloperPlanRequest,
  DeveloperDiagnostic,
  DeveloperAlternative,
} from "./dictation-developer-types.ts";

const encoder = new TextEncoder();

function syntaxDiagnostic(
  text: string,
  language: DeveloperPlanRequest["profile"]["language"],
  start: number,
  end: number,
): DeveloperDiagnostic | undefined {
  if (!text || language === "plain-code") {
    return undefined;
  }
  if (language === "json") {
    try {
      JSON.parse(text);
      return undefined;
    } catch {
      return {
        id: `syntax:${start}`,
        code: "syntax",
        severity: "warning",
        start,
        end,
        message:
          "This is not a complete JSON value. It may be an intentional fragment; no code was added or repaired.",
      };
    }
  }
  const stack: string[] = [];
  const paired: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let quote: string | undefined;
  let escaped = false;
  for (const char of text) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'" || (language === "typescript" && char === "`")) {
      quote = char;
    } else if ("([{".includes(char)) {
      stack.push(char);
    } else if (paired[char] && stack.pop() !== paired[char]) {
      return {
        id: `syntax:${start}`,
        code: "syntax",
        severity: "warning",
        start,
        end,
        message: "A closing delimiter has no matching opener. The fragment is unchanged.",
      };
    }
  }
  if (quote || stack.length) {
    return {
      id: `syntax:${start}`,
      code: "syntax",
      severity: "warning",
      start,
      end,
      message:
        "The fragment has an unfinished quote or delimiter. It remains usable as intentionally incomplete text.",
    };
  }
  return undefined;
}

/** Returns source edits; the shared refinement owner validates and applies them. */
export function createDeveloperPlan(request: DeveloperPlanRequest): DeveloperPlan {
  const { rawTranscript: source, profile } = request;
  const plan: DeveloperPlan = {
    schemaVersion: 1,
    offsetEncoding: "utf-16",
    captureId: request.captureId,
    generation: request.generation,
    transcriptRevision: request.transcriptRevision,
    profileId: profile.id,
    profileRevision: profile.revision,
    supported: true,
    edits: [],
    diagnostics: [],
    protectedSpans: [],
  };
  const reject = (code: DeveloperDiagnostic["code"], message: string) => {
    plan.diagnostics.push({
      id: `${code}:0`,
      code,
      severity: "blocking",
      start: 0,
      end: source.length,
      message,
    });
    return plan;
  };
  if (
    source.length > DEVELOPER_LIMITS.transcriptBytes ||
    encoder.encode(source).length > DEVELOPER_LIMITS.transcriptBytes
  ) {
    return reject("limit", "The transcript exceeds the 128 KiB limit.");
  }
  if (
    !request.captureId ||
    request.captureId.length > 128 ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 0 ||
    !Number.isSafeInteger(request.transcriptRevision) ||
    request.transcriptRevision < 0
  ) {
    return reject("invalid", "The capture identity is invalid.");
  }
  for (let index = 0; index < source.length; index++) {
    const unit = source.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = source.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return reject("invalid", "The transcript contains an incomplete Unicode character.");
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return reject("invalid", "The transcript contains an incomplete Unicode character.");
    }
  }
  const boundaries = developerGraphemeBoundaries(source);
  const protectedRanges = [...(request.protectedSpans ?? [])].toSorted((a, b) => a.start - b.start);
  if (
    protectedRanges.length > 256 ||
    protectedRanges.some(
      (range, index) =>
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < 0 ||
        range.end <= range.start ||
        range.end > source.length ||
        !boundaries.has(range.start) ||
        !boundaries.has(range.end) ||
        (index > 0 && range.start < protectedRanges[index - 1]!.end),
    )
  ) {
    return reject(
      "invalid",
      "Protected source ranges must be bounded, disjoint grapheme ranges in UTF-16.",
    );
  }
  plan.protectedSpans = protectedRanges;
  if (request.mode === "prose") {
    return plan;
  }
  if (
    request.locale !== profile.locale ||
    profile.locale !== "en-US" ||
    profile.languageVersion !== "fragments-v1"
  ) {
    plan.supported = false;
    return reject(
      "unsupported",
      "Select an English (en-US) profile or Prose explicitly; no English commands were applied.",
    );
  }
  const tokens = lexDeveloperText(source);
  if (tokens.length > DEVELOPER_LIMITS.tokens) {
    return reject("limit", "A developer candidate may contain at most 4,000 tokens.");
  }
  if (Object.keys(request.choices ?? {}).length > DEVELOPER_LIMITS.edits) {
    return reject("limit", "Too many ambiguity choices.");
  }
  const untouched: DeveloperRange[] = [...protectedRanges];
  const symbols = indexDeveloperSymbols(profile.symbols);
  for (let index = 0; index < tokens.length;) {
    if (plan.diagnostics.length >= 64) {
      plan.diagnostics = plan.diagnostics.slice(0, 63);
      return reject("limit", "The candidate contains too many diagnostics.");
    }
    const token = tokens[index]!;
    if (protectedRanges.some((range) => token.start < range.end && token.end > range.start)) {
      index++;
      continue;
    }
    const command = parseDeveloperCommand(tokens, index, tokens.length, request, symbols);
    if (!command) {
      if (request.mode === "developer" && exactDeveloperToken(token)) {
        untouched.push({ start: token.start, end: token.end });
      }
      index++;
      continue;
    }
    const end = tokens[command.next - 1]!.end;
    if (protectedRanges.some((range) => token.start < range.end && end > range.start)) {
      plan.diagnostics.push({
        id: `invalid:${token.start}`,
        code: "invalid",
        severity: "blocking",
        start: token.start,
        end,
        message:
          "A syntax command overlaps a protected snippet or literal; keep the scopes separate.",
      });
    } else {
      plan.diagnostics.push(...command.diagnostics);
      if (!command.diagnostics.some((item) => item.severity === "blocking")) {
        if (
          encoder.encode(command.text).length > DEVELOPER_LIMITS.replacementBytes ||
          plan.edits.length >= DEVELOPER_LIMITS.edits
        ) {
          return reject("limit", "The edit count or replacement size exceeds its bound.");
        }
        plan.edits.push({
          intentId: `syntax:${token.start}`,
          start: token.start,
          end,
          source: source.slice(token.start, end),
          text: command.text,
        });
        const warning = syntaxDiagnostic(command.text, profile.language, token.start, end);
        if (warning) {
          plan.diagnostics.push(warning);
        }
      }
    }
    index = command.next;
  }
  if (request.mode === "literal") {
    let start = 0;
    for (const edit of plan.edits) {
      if (edit.start > start) {
        untouched.push({ start, end: edit.start });
      }
      start = edit.end;
    }
    if (start < source.length) {
      untouched.push({ start, end: source.length });
    }
  }
  // Merge touching or nested opaque source tokens without ever crossing an edit.
  plan.protectedSpans = [];
  for (const range of untouched.toSorted((a, b) => a.start - b.start)) {
    const prior = plan.protectedSpans.at(-1);
    if (prior && (range.start <= prior.end || !source.slice(prior.end, range.start).trim())) {
      prior.end = Math.max(prior.end, range.end);
    } else {
      plan.protectedSpans.push({ ...range });
    }
  }
  if (plan.protectedSpans.length > 256) {
    return reject("limit", "The candidate contains too many separate protected literals.");
  }
  if (plan.diagnostics.length > 64) {
    plan.diagnostics = plan.diagnostics.slice(0, 63);
    return reject("limit", "The candidate contains too many diagnostics.");
  }
  return plan;
}
