import crypto from "node:crypto";
import { compileSafeRegexDetailed } from "../security/safe-regex.js";
import { buildCommandPayloadCandidates } from "./command-analysis/risks.js";
import { isEnvAssignmentToken, resolveCarrierCommandArgv } from "./command-carriers.js";
import {
  analyzeShellCommand,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
} from "./exec-approvals-analysis.js";
import type { ExecDenylistEntry } from "./exec-approvals.types.js";

export const DEFAULT_EXEC_DENYLIST_ENTRIES: readonly ExecDenylistEntry[] = [
  {
    id: "default-shell-network-fetch",
    pattern: String.raw`(?:^|[\s;&|()<>])(?:curl|wget)(?:\.exe)?(?:$|[\s;&|()<>$])|[\\/](?:curl|wget)(?:\.exe)?(?:$|[\s;&|()<>$])`,
    flags: "i",
  },
];

const DEFAULT_SHELL_NETWORK_FETCH_ID = "default-shell-network-fetch";
const DEFAULT_SHELL_NETWORK_FETCH_INVOCATION_REGEX =
  /(?:^|[;&|()<>])\s*(?:[^\s;&|()<>]*[\\/])?(?:curl|wget)(?:\.exe)?(?:$|[\s;&|()<>$])/iu;
const SHELL_ENV_EXPANSION_TOKEN = String.raw`\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)|%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!`;
const DEFAULT_SHELL_NETWORK_FETCH_LEADING_EXPANSION_REGEX = new RegExp(
  String.raw`(?:^|[;&|()<>])\s*(?:(?:${SHELL_ENV_EXPANSION_TOKEN})\s*)+(?:[^\s;&|()<>]*[\\/])?(?:curl|wget)(?:\.exe)?(?:$|[\s;&|()<>$])`,
  "iu",
);
const MAX_DENYLIST_PATTERN_LENGTH = 8 * 1024;
export const MAX_EXEC_DENYLIST_RULES = 256;
const MAX_DENYLIST_INSPECTED_CHARS = 256 * 1024;
const ALLOWED_DENYLIST_REGEX_FLAGS = new Set(["i", "m", "u"]);
const SHELL_COMMAND_SEPARATORS = new Set([";", "&", "|", "(", ")", "<", ">"]);

export type ExecDenylistInvalidReason =
  | "empty"
  | "invalid-flags"
  | "pattern-too-long"
  | "too-many-rules"
  | "unsafe-regex"
  | "input-too-large";

export type ExecDenylistDecision =
  | {
      denied: false;
      invalid: false;
      commandHash: string;
      commandLength: number;
    }
  | {
      denied: true;
      invalid: false;
      ruleIndex: number;
      commandHash: string;
      commandLength: number;
    }
  | {
      denied: true;
      invalid: true;
      reason: ExecDenylistInvalidReason;
      ruleIndex?: number;
      commandHash: string;
      commandLength: number;
    };

type CompiledDenyRule = {
  ruleIndex: number;
  regex: RegExp;
  builtInKind?: "shell-network-fetch";
};

type DenylistCandidateKind = "shell" | "argument" | "executable" | "payload" | "env";

type DenylistCandidate = {
  value: string;
  kind: DenylistCandidateKind;
};

type EnvReference = {
  name: string;
  caseInsensitive: boolean;
};

type EnvExpansionMap = Record<string, string | undefined>;

function commandHash(command: string): string {
  return crypto.createHash("sha256").update(command).digest("hex").slice(0, 16);
}

function normalizeFlags(flags?: unknown): string | null {
  if (flags !== undefined && typeof flags !== "string") {
    return null;
  }
  const raw = flags?.trim() ?? "";
  const unique = [...new Set(raw.split(""))].join("");
  for (const flag of unique) {
    if (!ALLOWED_DENYLIST_REGEX_FLAGS.has(flag)) {
      return null;
    }
  }
  return unique;
}

function isDefaultShellNetworkFetchEntry(entry: ExecDenylistEntry): boolean {
  const current = DEFAULT_EXEC_DENYLIST_ENTRIES[0];
  return (
    entry.id === DEFAULT_SHELL_NETWORK_FETCH_ID &&
    entry.pattern === current?.pattern &&
    (entry.flags?.trim() ?? "") === (current.flags ?? "")
  );
}

function compileDenyRules(denylist: readonly ExecDenylistEntry[]):
  | { ok: true; rules: CompiledDenyRule[] }
  | {
      ok: false;
      reason: ExecDenylistInvalidReason;
      ruleIndex?: number;
    } {
  const rules: CompiledDenyRule[] = [];
  if (denylist.length > MAX_EXEC_DENYLIST_RULES) {
    return { ok: false, reason: "too-many-rules" };
  }
  for (let idx = 0; idx < denylist.length; idx += 1) {
    const entry = denylist[idx];
    if (typeof entry?.pattern !== "string") {
      return { ok: false, reason: "empty", ruleIndex: idx };
    }
    const pattern = entry.pattern.trim();
    if (!pattern) {
      return { ok: false, reason: "empty", ruleIndex: idx };
    }
    if (pattern.length > MAX_DENYLIST_PATTERN_LENGTH) {
      return { ok: false, reason: "pattern-too-long", ruleIndex: idx };
    }
    const flags = normalizeFlags(entry.flags);
    if (flags === null) {
      return { ok: false, reason: "invalid-flags", ruleIndex: idx };
    }
    const compiled = compileSafeRegexDetailed(pattern, flags);
    if (!compiled.regex) {
      return { ok: false, reason: "unsafe-regex", ruleIndex: idx };
    }
    rules.push({
      ruleIndex: idx,
      regex: compiled.regex,
      ...(isDefaultShellNetworkFetchEntry(entry)
        ? { builtInKind: "shell-network-fetch" as const }
        : {}),
    });
  }
  return { ok: true, rules };
}

function pushCandidate(
  candidates: DenylistCandidate[],
  value: string | undefined | null,
  kind: DenylistCandidateKind,
): void {
  const trimmed = value?.trim();
  if (trimmed) {
    candidates.push({ value: trimmed, kind });
  }
}

function pushLines(
  candidates: DenylistCandidate[],
  value: string,
  kind: DenylistCandidateKind,
): void {
  for (const line of value.split(/\r?\n/u)) {
    pushCandidate(candidates, line, kind);
  }
}

function pushInlineEnvAssignmentValue(candidates: DenylistCandidate[], value: string): void {
  if (!isEnvAssignmentToken(value)) {
    return;
  }
  const delimiter = value.indexOf("=");
  if (delimiter <= 0) {
    return;
  }
  const assignmentValue = value.slice(delimiter + 1);
  pushCandidate(candidates, assignmentValue, "argument");
}

function collectEnvReferences(command: string): EnvReference[] {
  const references: EnvReference[] = [];
  const seen = new Set<string>();
  const pushReference = (name: string | undefined, caseInsensitive: boolean) => {
    if (!name) {
      return;
    }
    const key = `${caseInsensitive ? "i" : "s"}\0${name}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    references.push({ name, caseInsensitive });
  };
  for (const match of command.matchAll(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
  )) {
    pushReference(match[1] ?? match[2], false);
  }
  for (const match of command.matchAll(
    /\$(?:env:([A-Za-z_][A-Za-z0-9_]*)|\{env:([A-Za-z_][A-Za-z0-9_]*)\})/giu,
  )) {
    pushReference(match[1] ?? match[2], true);
  }
  for (const match of command.matchAll(
    /%(?:([A-Za-z_][A-Za-z0-9_]*))%|!(?:([A-Za-z_][A-Za-z0-9_]*))!/gu,
  )) {
    pushReference(match[1] ?? match[2], true);
  }
  return references;
}

function resolveEnvReference(
  env: EnvExpansionMap | undefined,
  reference: EnvReference,
): string | undefined {
  const exact = env?.[reference.name];
  if (exact !== undefined || !reference.caseInsensitive || !env) {
    return exact;
  }
  const normalizedName = reference.name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === normalizedName) {
      return value;
    }
  }
  return undefined;
}

function resolveEnvExpansionValue(
  env: EnvExpansionMap | undefined,
  name: string,
  caseInsensitive: boolean,
): string | undefined {
  return resolveEnvReference(env, { name, caseInsensitive });
}

function expandEnvReferences(value: string, env: EnvExpansionMap | undefined): string | null {
  if (!env) {
    return null;
  }
  let changed = false;
  const replace = (input: string, regex: RegExp, caseInsensitive: boolean): string =>
    input.replace(regex, (match: string, first?: string, second?: string) => {
      const name = first ?? second;
      if (!name) {
        return match;
      }
      const replacement = resolveEnvExpansionValue(env, name, caseInsensitive);
      if (replacement === undefined) {
        return match;
      }
      changed = true;
      return replacement;
    });
  let expanded = replace(
    value,
    /\$(?:env:([A-Za-z_][A-Za-z0-9_]*)|\{env:([A-Za-z_][A-Za-z0-9_]*)\})/giu,
    true,
  );
  expanded = replace(
    expanded,
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
    false,
  );
  expanded = replace(
    expanded,
    /%(?:([A-Za-z_][A-Za-z0-9_]*))%|!(?:([A-Za-z_][A-Za-z0-9_]*))!/gu,
    true,
  );
  return changed ? expanded : null;
}

function collectInlineEnvAssignments(analysis: ExecCommandAnalysis): Record<string, string> {
  const assignments: Record<string, string> = {};
  const collectArgv = (argv: readonly string[]) => {
    for (const arg of argv) {
      if (!isEnvAssignmentToken(arg)) {
        continue;
      }
      const delimiter = arg.indexOf("=");
      if (delimiter > 0) {
        assignments[arg.slice(0, delimiter)] = arg.slice(delimiter + 1);
      }
    }
  };
  for (const segment of analysis.segments) {
    collectArgv(segment.argv);
    collectArgv(segment.resolution?.effectiveArgv ?? []);
  }
  return assignments;
}

function pushSegmentCandidates(candidates: DenylistCandidate[], segment: ExecCommandSegment): void {
  pushCandidate(candidates, segment.raw, "shell");
  for (const arg of segment.argv) {
    pushCandidate(candidates, arg, "argument");
    pushInlineEnvAssignmentValue(candidates, arg);
  }
  const effectiveArgv = segment.resolution?.effectiveArgv;
  if (effectiveArgv) {
    for (const arg of effectiveArgv) {
      pushCandidate(candidates, arg, "argument");
      pushInlineEnvAssignmentValue(candidates, arg);
    }
  }
  pushCandidate(candidates, segment.resolution?.execution.executableName, "executable");
  pushCandidate(candidates, segment.resolution?.execution.rawExecutable, "executable");
  pushCandidate(candidates, segment.resolution?.execution.resolvedPath, "executable");
  pushCandidate(candidates, segment.resolution?.execution.resolvedRealPath, "executable");
  pushCandidate(candidates, segment.resolution?.policy.executableName, "executable");
  pushCandidate(candidates, segment.resolution?.policy.rawExecutable, "executable");
  pushCandidate(candidates, segment.resolution?.policy.resolvedPath, "executable");
  pushCandidate(candidates, segment.resolution?.policy.resolvedRealPath, "executable");
  for (const payload of buildCommandPayloadCandidates(effectiveArgv ?? segment.argv)) {
    pushCandidate(candidates, payload, "payload");
    pushLines(candidates, payload, "payload");
  }
}

function collectDenylistCandidates(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  analysis?: ExecCommandAnalysis;
}): DenylistCandidate[] {
  const candidates: DenylistCandidate[] = [];
  pushCandidate(candidates, params.command, "shell");
  pushLines(candidates, params.command, "shell");

  const analysis =
    params.analysis ??
    analyzeShellCommand({
      command: params.command,
      cwd: params.cwd,
      env: params.env,
      platform: process.platform,
    });
  const expansionEnv = {
    ...params.env,
    ...collectInlineEnvAssignments(analysis),
  };
  for (const segment of analysis.segments) {
    pushSegmentCandidates(candidates, segment);
  }

  const referencedEnv = collectEnvReferences(params.command);
  for (const reference of referencedEnv) {
    const value = resolveEnvReference(params.env, reference);
    pushCandidate(candidates, value, "env");
  }

  const originalCandidates = candidates.slice();
  for (const candidate of originalCandidates) {
    const expanded = expandEnvReferences(candidate.value, expansionEnv);
    pushCandidate(candidates, expanded, candidate.kind);
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}\0${candidate.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function testDenyRule(regex: RegExp, candidate: string): boolean {
  regex.lastIndex = 0;
  return regex.test(candidate);
}

function normalizeExecutableName(value: string | undefined): string {
  return (
    (value ?? "")
      .split(/[\\/]/u)
      .pop()
      ?.replace(/\.exe$/iu, "")
      .toLowerCase() ?? ""
  );
}

function isShellNetworkFetchExecutable(value: string | undefined): boolean {
  const command = normalizeExecutableName(value);
  return command === "curl" || command === "wget";
}

function isShellNetworkFetchArgv(argv: readonly string[], depth = 0): boolean {
  if (depth > 8 || argv.length === 0) {
    return false;
  }
  if (isShellNetworkFetchExecutable(argv[0])) {
    return true;
  }
  const carried = resolveCarrierCommandArgv([...argv], depth, { includeExec: true });
  return carried ? isShellNetworkFetchArgv(carried, depth + 1) : false;
}

function readShellCommandWord(value: string, start: number): { word: string; end: number } {
  let word = "";
  let index = start;
  let inSingle = false;
  let inDouble = false;
  while (index < value.length) {
    const char = value[index] ?? "";
    if (!inSingle && !inDouble && (/\s/u.test(char) || SHELL_COMMAND_SEPARATORS.has(char))) {
      break;
    }
    if (char === "\\" && index + 1 < value.length) {
      word += char + (value[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      word += char;
      index += 1;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      word += char;
      index += 1;
      continue;
    }
    if (!inSingle && char === "$" && value[index + 1] === "(") {
      let depth = 1;
      word += "$(";
      index += 2;
      while (index < value.length && depth > 0) {
        const nested = value[index] ?? "";
        if (nested === "\\" && index + 1 < value.length) {
          word += nested + (value[index + 1] ?? "");
          index += 2;
          continue;
        }
        if (nested === "$" && value[index + 1] === "(") {
          depth += 1;
          word += "$(";
          index += 2;
          continue;
        }
        if (nested === ")") {
          depth -= 1;
        }
        word += nested;
        index += 1;
      }
      continue;
    }
    if (!inSingle && char === "`") {
      word += char;
      index += 1;
      while (index < value.length) {
        const nested = value[index] ?? "";
        word += nested;
        index += nested === "\\" && index + 1 < value.length ? 2 : 1;
        if (nested === "`") {
          break;
        }
      }
      continue;
    }
    word += char;
    index += 1;
  }
  return { word, end: index };
}

function extractShellCommandWords(value: string): string[] {
  const words: string[] = [];
  let index = 0;
  let expectCommand = true;
  while (index < value.length) {
    if (expectCommand) {
      while (index < value.length && /\s/u.test(value[index] ?? "")) {
        index += 1;
      }
      while (SHELL_COMMAND_SEPARATORS.has(value[index] ?? "")) {
        index += 1;
        while (index < value.length && /\s/u.test(value[index] ?? "")) {
          index += 1;
        }
      }
      if (index >= value.length) {
        break;
      }
      const { word, end } = readShellCommandWord(value, index);
      if (word) {
        words.push(word);
      }
      index = end;
      expectCommand = false;
      continue;
    }
    if (SHELL_COMMAND_SEPARATORS.has(value[index] ?? "")) {
      expectCommand = true;
    }
    index += 1;
  }
  return words;
}

function stripShellCommandSubstitutions(word: string): { substituted: boolean; literal: string } {
  let literal = "";
  let index = 0;
  let substituted = false;
  while (index < word.length) {
    const char = word[index] ?? "";
    if (char === "$" && word[index + 1] === "(") {
      substituted = true;
      let depth = 1;
      index += 2;
      while (index < word.length && depth > 0) {
        if (word[index] === "$" && word[index + 1] === "(") {
          depth += 1;
          index += 2;
          continue;
        }
        if (word[index] === ")") {
          depth -= 1;
        }
        index += 1;
      }
      continue;
    }
    if (char === "`") {
      substituted = true;
      index += 1;
      while (index < word.length) {
        const nested = word[index] ?? "";
        index += nested === "\\" && index + 1 < word.length ? 2 : 1;
        if (nested === "`") {
          break;
        }
      }
      continue;
    }
    literal += char === "\\" && index + 1 < word.length ? (word[index + 1] ?? "") : char;
    index += char === "\\" && index + 1 < word.length ? 2 : 1;
  }
  return { substituted, literal };
}

function isSubsequence(value: string, target: string): boolean {
  let targetIndex = 0;
  for (const char of value) {
    targetIndex = target.indexOf(char, targetIndex);
    if (targetIndex < 0) {
      return false;
    }
    targetIndex += 1;
  }
  return true;
}

function hasNetworkFetchCommandSubstitution(value: string): boolean {
  for (const word of extractShellCommandWords(value)) {
    const stripped = stripShellCommandSubstitutions(word);
    if (!stripped.substituted) {
      continue;
    }
    const command = normalizeExecutableName(stripped.literal);
    if (command.length >= 2 && (isSubsequence(command, "curl") || isSubsequence(command, "wget"))) {
      return true;
    }
  }
  return false;
}

function isShellNetworkFetchInvocation(
  candidate: DenylistCandidate,
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): boolean {
  if (candidate.kind === "argument" || candidate.kind === "env") {
    return false;
  }
  if (candidate.kind === "executable") {
    return isShellNetworkFetchExecutable(candidate.value);
  }
  DEFAULT_SHELL_NETWORK_FETCH_INVOCATION_REGEX.lastIndex = 0;
  if (DEFAULT_SHELL_NETWORK_FETCH_INVOCATION_REGEX.test(candidate.value)) {
    return true;
  }
  DEFAULT_SHELL_NETWORK_FETCH_LEADING_EXPANSION_REGEX.lastIndex = 0;
  if (DEFAULT_SHELL_NETWORK_FETCH_LEADING_EXPANSION_REGEX.test(candidate.value)) {
    return true;
  }
  if (hasNetworkFetchCommandSubstitution(candidate.value)) {
    return true;
  }
  const analysis = analyzeShellCommand({
    command: candidate.value,
    cwd: params.cwd,
    env: params.env,
    platform: process.platform,
  });
  return analysis.segments.some((segment) => {
    const argvExecutable = segment.argv[0];
    return (
      isShellNetworkFetchArgv(segment.argv) ||
      isShellNetworkFetchArgv(segment.resolution?.effectiveArgv ?? []) ||
      isShellNetworkFetchExecutable(argvExecutable) ||
      isShellNetworkFetchExecutable(segment.resolution?.execution.executableName) ||
      isShellNetworkFetchExecutable(segment.resolution?.execution.rawExecutable) ||
      isShellNetworkFetchExecutable(segment.resolution?.execution.resolvedPath) ||
      isShellNetworkFetchExecutable(segment.resolution?.execution.resolvedRealPath) ||
      isShellNetworkFetchExecutable(segment.resolution?.policy.executableName) ||
      isShellNetworkFetchExecutable(segment.resolution?.policy.rawExecutable) ||
      isShellNetworkFetchExecutable(segment.resolution?.policy.resolvedPath) ||
      isShellNetworkFetchExecutable(segment.resolution?.policy.resolvedRealPath)
    );
  });
}

export function evaluateExecDenylist(params: {
  command: string;
  denylist: readonly ExecDenylistEntry[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  analysis?: ExecCommandAnalysis;
}): ExecDenylistDecision {
  const base = {
    commandHash: commandHash(params.command),
    commandLength: params.command.length,
  };
  if (params.denylist.length === 0) {
    return { denied: false, invalid: false, ...base };
  }
  const compiled = compileDenyRules(params.denylist);
  if (!compiled.ok) {
    return {
      denied: true,
      invalid: true,
      reason: compiled.reason,
      ruleIndex: compiled.ruleIndex,
      ...base,
    };
  }
  const candidates = collectDenylistCandidates(params);
  const inspectedChars = candidates.reduce((total, candidate) => total + candidate.value.length, 0);
  if (inspectedChars > MAX_DENYLIST_INSPECTED_CHARS) {
    return { denied: true, invalid: true, reason: "input-too-large", ...base };
  }
  for (const candidate of candidates) {
    for (const rule of compiled.rules) {
      const matched =
        rule.builtInKind === "shell-network-fetch"
          ? isShellNetworkFetchInvocation(candidate, params)
          : testDenyRule(rule.regex, candidate.value);
      if (matched) {
        return { denied: true, invalid: false, ruleIndex: rule.ruleIndex, ...base };
      }
    }
  }
  return { denied: false, invalid: false, ...base };
}
