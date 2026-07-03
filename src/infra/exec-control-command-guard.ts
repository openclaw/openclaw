import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { splitShellArgs } from "../utils/shell-argv.js";
import { buildCommandPayloadCandidates } from "./command-analysis/risks.js";
import { resolveCarrierCommandArgv } from "./command-carriers.js";
import { explainShellCommand } from "./command-explainer/extract.js";
import { unwrapDispatchWrappersForResolution } from "./dispatch-wrapper-resolution.js";
import { resolveRequiredHomeDir } from "./home-dir.js";

type ParsedExecApprovalCommand = {
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
};

type CommandPayload = {
  argv: string[];
  text: string;
  workdir?: string;
  env?: Record<string, string | undefined>;
  stdinFromPipe?: boolean;
};

type SearchGuardContext = {
  env?: Record<string, string | undefined>;
  additionalProtectedRoots?: readonly string[];
};

export type UnsafeExecControlShellCommandKind = "approve" | "channel-login";
export type UnsafeExecBroadSearchShellCommand = {
  executable: "find" | "grep" | "rg";
  path: string;
  protectedRoot: string;
};

export function parseExecApprovalShellCommand(raw: string): ParsedExecApprovalCommand | null {
  const normalized = raw.trimStart();
  const match = normalized.match(
    /^\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i,
  );
  if (!match) {
    return null;
  }
  return {
    approvalId: match[1],
    decision:
      normalizeLowercaseStringOrEmpty(match[2]) === "always"
        ? "allow-always"
        : (normalizeLowercaseStringOrEmpty(match[2]) as ParsedExecApprovalCommand["decision"]),
  };
}

function normalizeCommandBaseName(token: string | undefined): string {
  if (!token) {
    return "";
  }
  const base = normalizeLowercaseStringOrEmpty(token.split(/[\\/]/u).at(-1));
  return base.replace(/\.(?:cmd|exe)$/u, "");
}

function stripOpenClawPackageRunner(argv: string[]): string[] {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName === "openclaw") {
    return argv;
  }
  if (
    (commandName === "pnpm" || commandName === "npm" || commandName === "yarn") &&
    normalizeCommandBaseName(argv[1]) === "openclaw"
  ) {
    return argv.slice(1);
  }
  if (
    (commandName === "pnpm" || commandName === "npm" || commandName === "yarn") &&
    (argv[1] === "exec" || argv[1] === "dlx" || argv[1] === "run") &&
    normalizeCommandBaseName(argv[2]) === "openclaw"
  ) {
    return argv.slice(2);
  }
  if (commandName === "npx" || commandName === "bunx") {
    let idx = 1;
    while (idx < argv.length) {
      const token = argv[idx];
      if (token === "--") {
        idx += 1;
        break;
      }
      if (!token.startsWith("-") || token === "-") {
        break;
      }
      idx += 1;
      if ((token === "-p" || token === "--package") && idx < argv.length) {
        idx += 1;
      }
    }
    if (normalizeCommandBaseName(argv[idx]) === "openclaw") {
      return argv.slice(idx);
    }
  }
  return argv;
}

export function parseOpenClawChannelsLoginShellCommand(raw: string): boolean {
  const argv = splitShellArgs(raw);
  if (!argv) {
    return false;
  }
  const openclawArgv = stripOpenClawPackageRunner(argv);
  return (
    normalizeCommandBaseName(openclawArgv[0]) === "openclaw" &&
    (openclawArgv[1] === "channels" || openclawArgv[1] === "channel") &&
    openclawArgv[2] === "login"
  );
}

export async function detectUnsafeExecControlShellCommand(
  command: string,
): Promise<UnsafeExecControlShellCommandKind | null> {
  const candidates = await createCommandPayloads(command);
  for (const candidate of candidates) {
    if (parseExecApprovalShellCommand(candidate.text)) {
      return "approve";
    }
    if (parseOpenClawChannelsLoginShellCommand(candidate.text)) {
      return "channel-login";
    }
  }
  return null;
}

export async function rejectUnsafeExecControlShellCommand(command: string): Promise<void> {
  const unsafeKind = await detectUnsafeExecControlShellCommand(command);
  if (unsafeKind === "approve") {
    throw new Error(
      [
        "exec cannot run /approve commands.",
        "Show the /approve command to the user as chat text, or route it through the approval command handler instead of shell execution.",
      ].join(" "),
    );
  }
  if (unsafeKind === "channel-login") {
    throw new Error(
      [
        "exec cannot run interactive OpenClaw channel login commands.",
        "Run `openclaw channels login` in a terminal on the gateway host, or use the channel-specific login agent tool when available (for WhatsApp: `whatsapp_login`).",
      ].join(" "),
    );
  }
}

const RG_OPTION_ARGS_WITH_VALUES = new Set([
  "-A",
  "-B",
  "-C",
  "-E",
  "-e",
  "-f",
  "-g",
  "-j",
  "-M",
  "-m",
  "-t",
  "-T",
  "--after-context",
  "--before-context",
  "--color",
  "--colors",
  "--context",
  "--context-separator",
  "--dfa-size-limit",
  "--encoding",
  "--engine",
  "--field-context-separator",
  "--field-match-separator",
  "--glob",
  "--iglob",
  "--ignore-file",
  "--json-seq",
  "--max-columns",
  "--max-count",
  "--max-depth",
  "--max-filesize",
  "--path-separator",
  "--pre",
  "--pre-glob",
  "--regexp",
  "--replace",
  "--sort",
  "--sortr",
  "--threads",
  "--type",
  "--type-add",
  "--type-clear",
  "--type-not",
]);

const GREP_OPTION_ARGS_WITH_VALUES = new Set([
  "-A",
  "-B",
  "-C",
  "-D",
  "-d",
  "-e",
  "-f",
  "-m",
  "--after-context",
  "--before-context",
  "--binary-files",
  "--context",
  "--devices",
  "--directories",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--group-separator",
  "--include",
  "--label",
  "--max-count",
  "--regexp",
]);

const XARGS_OPTIONS_WITH_VALUES = new Set([
  "-a",
  "-d",
  "-E",
  "-I",
  "-L",
  "-l",
  "-n",
  "-P",
  "-s",
  "--arg-file",
  "--delimiter",
  "--eof",
  "--max-args",
  "--max-chars",
  "--max-lines",
  "--max-procs",
  "--process-slot-var",
  "--replace",
]);

const XARGS_STANDALONE_OPTIONS = new Set([
  "-0",
  "-o",
  "-p",
  "-r",
  "-t",
  "-x",
  "--interactive",
  "--no-run-if-empty",
  "--null",
  "--open-tty",
  "--verbose",
  "--exit",
]);

const FIND_DYNAMIC_STARTING_POINTS_ROOT = "<dynamic find -files0-from roots>";
const DYNAMIC_SHELL_EXPANSION_ROOT = "<dynamic shell-expanded search path>";

function commandPayloadKey(payload: CommandPayload): string {
  return `${payload.workdir ?? ""}\0${
    payload.stdinFromPipe === true ? "pipe" : ""
  }\0${payload.argv.join("\0")}`;
}

function payloadFromArgv(
  argv: string[],
  workdir?: string,
  opts?: { env?: Record<string, string | undefined>; stdinFromPipe?: boolean },
): CommandPayload | null {
  if (argv.length === 0) {
    return null;
  }
  return {
    argv,
    text: argv.join(" "),
    ...(workdir ? { workdir } : {}),
    ...(opts?.env ? { env: opts.env } : {}),
    ...(opts?.stdinFromPipe === true ? { stdinFromPipe: true } : {}),
  };
}

function pushUniquePayload(
  payloads: CommandPayload[],
  seen: Set<string>,
  payload: CommandPayload | null,
): void {
  if (!payload) {
    return;
  }
  const key = commandPayloadKey(payload);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  payloads.push(payload);
}

function payloadsFromCandidateStrings(
  candidates: string[],
  workdir?: string,
  opts?: { env?: Record<string, string | undefined>; stdinFromPipe?: boolean },
): CommandPayload[] {
  return normalizeStringEntries(candidates).flatMap((candidate) => {
    const argv = splitShellArgs(candidate);
    return argv
      ? [payloadFromArgv(argv, workdir, opts)].filter((payload): payload is CommandPayload =>
          Boolean(payload),
        )
      : [];
  });
}

function isCwdChangingCommandContext(context: string): boolean {
  return context === "top-level" || context === "wrapper-payload";
}

function controlFlowUnknownWorkdir(): string {
  return resolveRequiredHomeDir();
}

function resolveCdWorkdir(
  argv: readonly string[],
  currentWorkdir: string,
  context?: SearchGuardContext,
): string | null {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName !== "cd" && commandName !== "pushd") {
    return null;
  }
  const operands: string[] = [];
  let optionMode = true;
  for (const token of argv.slice(1)) {
    if (optionMode && token === "--") {
      optionMode = false;
      continue;
    }
    if (optionMode && token.startsWith("-") && token !== "-") {
      continue;
    }
    operands.push(token);
  }
  if (operands.length > 1) {
    return null;
  }
  const target = operands[0];
  if (target === "-") {
    const oldPwd = context?.env?.OLDPWD ?? process.env.OLDPWD;
    const resolvedOldPwd = oldPwd ? resolveSearchTargetPath(oldPwd, currentWorkdir, context) : null;
    return resolvedOldPwd ? maybeRealpath(resolvedOldPwd) : null;
  }
  if (target && target !== "-" && !path.isAbsolute(target) && !target.includes("/")) {
    const cdpath = context?.env?.CDPATH ?? process.env.CDPATH;
    if (cdpath) {
      for (const entry of cdpath.split(path.delimiter)) {
        if (!entry) {
          continue;
        }
        const resolvedCdpathTarget = resolveSearchTargetPath(
          path.join(entry, target),
          currentWorkdir,
          context,
        );
        if (!resolvedCdpathTarget) {
          continue;
        }
        return maybeRealpath(resolvedCdpathTarget) ?? resolvedCdpathTarget;
      }
    }
  }
  const resolved = resolveSearchTargetPath(target ?? "~", currentWorkdir, context);
  return resolved ? maybeRealpath(resolved) : null;
}

function resolveEnvChdirWorkdir(
  argv: readonly string[],
  currentWorkdir: string,
  context?: SearchGuardContext,
): string | null {
  if (normalizeCommandBaseName(argv[0]) !== "env") {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return null;
    }
    if (token === "-C" || token === "--chdir") {
      const target = argv[index + 1];
      return target ? resolveSearchTargetPath(target, currentWorkdir, context) : null;
    }
    if (token.startsWith("--chdir=")) {
      return resolveSearchTargetPath(token.slice("--chdir=".length), currentWorkdir, context);
    }
    if (!token.startsWith("-")) {
      return null;
    }
  }
  return null;
}

function resolveSudoChdirWorkdir(
  argv: readonly string[],
  currentWorkdir: string,
  context?: SearchGuardContext,
): string | null {
  if (normalizeCommandBaseName(argv[0]) !== "sudo") {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return null;
    }
    if (token === "-D" || token === "--chdir") {
      const target = argv[index + 1];
      return target ? resolveSearchTargetPath(target, currentWorkdir, context) : null;
    }
    if (token.startsWith("--chdir=")) {
      return resolveSearchTargetPath(token.slice("--chdir=".length), currentWorkdir, context);
    }
    if (!token.startsWith("-")) {
      return null;
    }
  }
  return null;
}

function resolvePayloadWorkdir(
  argv: readonly string[],
  currentWorkdir?: string,
  context?: SearchGuardContext,
): string | undefined {
  if (!currentWorkdir) {
    return currentWorkdir;
  }
  return (
    resolveEnvChdirWorkdir(argv, currentWorkdir, context) ??
    resolveSudoChdirWorkdir(argv, currentWorkdir, context) ??
    currentWorkdir
  );
}

function shellTokensBefore(source: string, endIndex: number): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < Math.min(endIndex, source.length); index += 1) {
    const char = source[index] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/[A-Za-z0-9_]/u.test(char)) {
      current += char;
      continue;
    }
    if (current) {
      tokens.push(current);
      current = "";
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function isInsideShellControlFlowBody(source: string, commandStartIndex: number): boolean {
  const stack: Array<"pending-if" | "if-body" | "pending-loop" | "loop-body" | "case-body"> = [];
  for (const token of shellTokensBefore(source, commandStartIndex)) {
    if (token === "if") {
      stack.push("pending-if");
      continue;
    }
    if (token === "while" || token === "until" || token === "for" || token === "select") {
      stack.push("pending-loop");
      continue;
    }
    if (token === "then" && stack.at(-1) === "pending-if") {
      stack[stack.length - 1] = "if-body";
      continue;
    }
    if (token === "do" && stack.at(-1) === "pending-loop") {
      stack[stack.length - 1] = "loop-body";
      continue;
    }
    if (token === "case") {
      stack.push("case-body");
      continue;
    }
    if (token === "fi") {
      stack.pop();
      continue;
    }
    if (token === "done" && stack.at(-1) === "loop-body") {
      stack.pop();
      continue;
    }
    if (token === "esac" && stack.at(-1) === "case-body") {
      stack.pop();
    }
  }
  return ["if-body", "loop-body", "case-body"].includes(stack.at(-1) ?? "");
}

function previousNonWhitespaceShellChar(source: string, startIndex: number): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let previous = "";
  for (let index = 0; index < Math.min(startIndex, source.length); index += 1) {
    const char = source[index] ?? "";
    if (escaped) {
      escaped = false;
      previous = char;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      previous = char;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      previous = char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      previous = char;
      continue;
    }
    if (!/\s/u.test(char)) {
      previous = char;
    }
  }
  return previous;
}

function hasPipedStdinBeforeCommand(source: string, commandStartIndex: number): boolean {
  if (previousNonWhitespaceShellChar(source, commandStartIndex) !== "|") {
    return false;
  }
  const before = source.slice(0, commandStartIndex).trimEnd();
  return !before.endsWith("||");
}

function commandSegmentBounds(source: string, commandStartIndex: number, commandEndIndex: number) {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let start = 0;
  let end = source.length;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const isSeparator =
      char === ";" ||
      char === "\n" ||
      (char === "&" && source[index + 1] !== "&") ||
      (char === "|" && source[index + 1] !== "|");
    if (!isSeparator) {
      continue;
    }
    if (index < commandStartIndex) {
      start = index + 1;
    } else if (index >= commandEndIndex) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function hasStdinRedirectionForCommand(
  source: string,
  commandStartIndex: number,
  commandEndIndex: number,
): boolean {
  const bounds = commandSegmentBounds(source, commandStartIndex, commandEndIndex);
  const segment = source.slice(bounds.start, bounds.end);
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of segment) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "<") {
      return true;
    }
  }
  return false;
}

function hasPipedStdoutAfterCommand(source: string, commandEndIndex: number): boolean {
  for (let index = commandEndIndex; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (/\s/u.test(char)) {
      continue;
    }
    return char === "|" && source[index + 1] !== "|";
  }
  return false;
}

function hasBackgroundAfterCommand(source: string, commandEndIndex: number): boolean {
  for (let index = commandEndIndex; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (/\s/u.test(char)) {
      continue;
    }
    return char === "&" && source[index + 1] !== "&";
  }
  return false;
}

function isConditionallyExecutedShellCommand(source: string, commandStartIndex: number): boolean {
  const before = source.slice(0, commandStartIndex).trimEnd();
  return before.endsWith("&&") || before.endsWith("||");
}

function shellPositionalPayload(argv: readonly string[]): string[] | null {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (!["bash", "dash", "sh", "zsh"].includes(commandName)) {
    return null;
  }
  let commandIndex = -1;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "-c" || token.endsWith("c")) {
      commandIndex = index + 1;
      break;
    }
    if (!token.startsWith("-")) {
      return null;
    }
  }
  const commandText = commandIndex >= 0 ? (argv[commandIndex] ?? "") : "";
  if (!commandText.includes("$@") && !commandText.includes("$*")) {
    return null;
  }
  const payload = argv.slice(commandIndex + 2);
  return payload.length > 0 ? payload : null;
}

function parseEnvAssignment(token: string): { name: string; value: string } | null {
  const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
  return match ? { name: match[1], value: match[2] } : null;
}

function envWithAssignments(
  baseEnv: Record<string, string | undefined> | undefined,
  assignments: readonly { name: string; value: string }[],
  opts?: { uncertain?: boolean },
): Record<string, string | undefined> | undefined {
  if (assignments.length === 0) {
    return baseEnv;
  }
  const nextEnv = { ...(baseEnv ?? process.env) };
  for (const assignment of assignments) {
    nextEnv[assignment.name] =
      opts?.uncertain === true
        ? controlFlowUnknownWorkdir()
        : expandShellHomePrefix(assignment.value, nextEnv);
  }
  return nextEnv;
}

function isEnvAssignment(
  assignment: { name: string; value: string } | null,
): assignment is { name: string; value: string } {
  return assignment !== null;
}

function extractLeadingEnvAssignments(
  argv: readonly string[],
  baseEnv?: Record<string, string | undefined>,
): { argv: string[]; env?: Record<string, string | undefined>; assignmentOnly: boolean } {
  const assignments: Array<{ name: string; value: string }> = [];
  let index = 0;
  while (index < argv.length) {
    const assignment = parseEnvAssignment(argv[index] ?? "");
    if (!assignment) {
      break;
    }
    assignments.push(assignment);
    index += 1;
  }
  return {
    argv: argv.slice(index),
    env: envWithAssignments(baseEnv, assignments),
    assignmentOnly: assignments.length > 0 && index >= argv.length,
  };
}

function envWithShellAssignmentsBeforeCommand(
  source: string,
  commandStartIndex: number,
  baseEnv?: Record<string, string | undefined>,
): Record<string, string | undefined> | undefined {
  const before = source.slice(0, commandStartIndex);
  const assignments: Array<{ name: string; value: string }> = [];
  const assignmentPattern = /(?:^|[;\n&])\s*([A-Za-z_][A-Za-z0-9_]*)=([^\s;&|]+)\s*(?=;|\n|$)/gu;
  for (const match of before.matchAll(assignmentPattern)) {
    if (!isInsideShellControlFlowBody(source, match.index + match[0].length - 1)) {
      assignments.push({ name: match[1], value: match[2] });
    }
  }
  return envWithAssignments(baseEnv, assignments);
}

function quoteRegionScopeKey(source: string, targetIndex: number): string | null {
  let quote: "'" | '"' | null = null;
  let quoteStart = -1;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (quoteStart <= targetIndex && targetIndex <= index) {
          return `${quoteStart}:${index}`;
        }
        quote = null;
        quoteStart = -1;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoteStart = index;
    }
  }
  return quoteStart <= targetIndex && quoteStart >= 0 ? `${quoteStart}:${source.length}` : null;
}

function shellExecutionScopeKey(
  source: string,
  step: { context: string; span: { startIndex: number } },
): string {
  const subshellScope = subshellScopeKey(source, step.span.startIndex);
  if (step.context === "wrapper-payload") {
    return `wrapper:${quoteRegionScopeKey(source, step.span.startIndex) ?? step.span.startIndex}:${subshellScope}`;
  }
  return subshellScope;
}

function shellPayloadTextsFromArgv(argv: readonly string[]): string[] {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName === "eval") {
    return argv.length > 1 ? [argv.slice(1).join(" ")] : [];
  }
  if (!["bash", "dash", "sh", "zsh"].includes(commandName)) {
    return [];
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "-c" || token.endsWith("c")) {
      const commandText = argv[index + 1];
      return commandText ? [commandText] : [];
    }
    if (!token.startsWith("-")) {
      break;
    }
  }
  return [];
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function resolveShellFunctionInvocationWorkdir(
  source: string,
  commandStartIndex: number,
  argv: readonly string[],
  currentWorkdir: string,
  context?: SearchGuardContext,
): string | null {
  const functionName = argv.length === 1 ? normalizeCommandBaseName(argv[0]) : "";
  if (!functionName) {
    return null;
  }
  const before = source.slice(0, commandStartIndex);
  const definitionPattern = /(?:^|[;\n]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\)\s*)?\{([\s\S]*?)\}/gu;
  let functionBody: string | null = null;
  for (const match of before.matchAll(definitionPattern)) {
    if (match[1] === functionName) {
      functionBody = match[2] ?? "";
    }
  }
  if (!functionBody) {
    return null;
  }
  const invocationPattern = new RegExp(
    `(?:^|[;\\n&|]\\s*)${escapeRegExpLiteral(functionName)}(?:\\s*(?:;|\\n|&|\\||$))`,
    "u",
  );
  if (!invocationPattern.test(source.slice(commandStartIndex))) {
    return null;
  }
  const cdMatch = functionBody.match(/\b(?:cd|pushd)\s+([^;\n}]+)/u);
  if (!cdMatch) {
    return null;
  }
  const cdArgv = splitShellArgs(`cd ${cdMatch[1]}`);
  if (!cdArgv) {
    return controlFlowUnknownWorkdir();
  }
  return resolveCdWorkdir(cdArgv, currentWorkdir, context) ?? controlFlowUnknownWorkdir();
}

function staticNestedPayloadArgvs(argv: readonly string[]): string[][] {
  return [
    resolveStaticXargsCommandArgv(argv),
    resolveStaticDispatchWrapperCommandArgv(argv),
    ...resolveStaticFindExecCommandArgvs(argv),
  ].filter((candidate): candidate is string[] => Array.isArray(candidate) && candidate.length > 0);
}

function collectPayloadsForArgv(
  argv: readonly string[],
  workdir: string | undefined,
  opts: { env?: Record<string, string | undefined>; stdinFromPipe?: boolean },
  context: SearchGuardContext,
  seen: Set<string> = new Set(),
  depth = 0,
): CommandPayload[] {
  if (depth > 8) {
    return [];
  }
  const payloads: CommandPayload[] = [];
  pushUniquePayload(payloads, seen, payloadFromArgv([...argv], workdir, opts));
  for (const payload of payloadsFromArgv(argv, workdir, opts, context)) {
    pushUniquePayload(payloads, seen, payload);
  }
  for (const payloadText of shellPayloadTextsFromArgv(argv)) {
    for (const payload of payloadsFromCandidateStrings([payloadText], workdir, opts)) {
      pushUniquePayload(payloads, seen, payload);
    }
    const shellArgv = splitShellArgs(payloadText);
    if (shellArgv) {
      payloads.push(...collectPayloadsForArgv(shellArgv, workdir, opts, context, seen, depth + 1));
    }
  }
  for (const nestedArgv of staticNestedPayloadArgvs(argv)) {
    payloads.push(...collectPayloadsForArgv(nestedArgv, workdir, opts, context, seen, depth + 1));
  }
  return payloads;
}

function collectShellHeredocPayloads(
  rawCommand: string,
  workdir: string | undefined,
  opts: { env?: Record<string, string | undefined> },
  context: SearchGuardContext,
  seen: Set<string>,
): CommandPayload[] {
  const payloads: CommandPayload[] = [];
  const heredocPattern =
    /(?:^|[;\n])\s*(?:env\s+(?:(?!<<)[^\n;<>&|]+\s+)*)?(?:bash|dash|sh|zsh)(?:\s+(?!<<)[^\n;<>&|]+)*\s+<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n([\s\S]*?)\n\1(?=\n|$)/gu;
  for (const match of rawCommand.matchAll(heredocPattern)) {
    const body = match[2] ?? "";
    const argv = splitShellArgs(body);
    if (!argv) {
      continue;
    }
    for (const payload of collectPayloadsForArgv(argv, workdir, opts, context)) {
      pushUniquePayload(payloads, seen, payload);
    }
  }
  return payloads;
}

function payloadsFromArgv(
  argv: readonly string[],
  workdir?: string,
  opts?: { env?: Record<string, string | undefined>; stdinFromPipe?: boolean },
  context?: SearchGuardContext,
): CommandPayload[] {
  const payloadWorkdir = resolvePayloadWorkdir(argv, workdir, context);
  const payloads = payloadsFromCandidateStrings(
    buildCommandPayloadCandidates([...argv]),
    payloadWorkdir,
    opts,
  );
  const positionalPayload = shellPositionalPayload(argv);
  if (positionalPayload) {
    payloads.push(
      ...[payloadFromArgv([...positionalPayload], workdir, opts)].filter(
        (payload): payload is CommandPayload => Boolean(payload),
      ),
    );
  }
  return payloads;
}

function resolveStaticXargsCommandArgv(argv: readonly string[]): string[] | null {
  if (normalizeCommandBaseName(argv[0]) !== "xargs") {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return argv.slice(index + 1);
    }
    if (!token.startsWith("-") || token === "-") {
      return argv.slice(index);
    }
    const option = token.split("=", 1)[0] ?? token;
    if (XARGS_STANDALONE_OPTIONS.has(option)) {
      continue;
    }
    if (XARGS_OPTIONS_WITH_VALUES.has(option)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (/^-I.+/u.test(token) || /^-E.+/u.test(token) || /^-L\d+$/u.test(token)) {
      continue;
    }
    if (/^-[lnPs]\d+$/u.test(token)) {
      continue;
    }
    return null;
  }
  return null;
}

function resolveStaticDispatchWrapperCommandArgv(argv: readonly string[]): string[] | null {
  const executable = normalizeCommandBaseName(argv[0]);
  if (executable === "setsid") {
    for (let index = 1; index < argv.length; index += 1) {
      const token = argv[index] ?? "";
      if (token === "--") {
        return argv.slice(index + 1);
      }
      if (!token.startsWith("-") || token === "-") {
        return argv.slice(index);
      }
      if (token === "--help" || token === "--version") {
        return null;
      }
    }
    return null;
  }
  if (executable === "ionice") {
    for (let index = 1; index < argv.length; index += 1) {
      const token = argv[index] ?? "";
      if (token === "--") {
        return argv.slice(index + 1);
      }
      if (!token.startsWith("-") || token === "-") {
        return argv.slice(index);
      }
      if (["-c", "-n", "-p", "-P", "--class", "--classdata", "--pid", "--pgid"].includes(token)) {
        index += 1;
        continue;
      }
      if (
        token.startsWith("--class=") ||
        token.startsWith("--classdata=") ||
        token.startsWith("--pid=") ||
        token.startsWith("--pgid=")
      ) {
        continue;
      }
      if (token === "--help" || token === "--version") {
        return null;
      }
    }
    return null;
  }
  if (executable === "taskset") {
    let maskSeen = false;
    for (let index = 1; index < argv.length; index += 1) {
      const token = argv[index] ?? "";
      if (token === "--") {
        const rest = argv.slice(index + 1);
        return rest.length > 1 ? rest.slice(1) : null;
      }
      if (token.startsWith("-") && token !== "-") {
        if (token === "--help" || token === "--version") {
          return null;
        }
        continue;
      }
      if (!maskSeen) {
        maskSeen = true;
        continue;
      }
      return argv.slice(index);
    }
  }
  return null;
}

function resolveStaticFindExecCommandArgvs(argv: readonly string[]): string[][] {
  if (normalizeCommandBaseName(argv[0]) !== "find") {
    return [];
  }
  const payloads: string[][] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token !== "-exec" && token !== "-execdir") {
      continue;
    }
    const commandStart = index + 1;
    let commandEnd = commandStart;
    while (commandEnd < argv.length) {
      const current = argv[commandEnd] ?? "";
      if (current === ";" || current === "+") {
        break;
      }
      commandEnd += 1;
    }
    const payload = argv
      .slice(commandStart, commandEnd)
      .filter((part) => part !== "{}" && part !== "{};");
    if (payload.length > 0) {
      payloads.push(payload);
    }
    index = commandEnd;
  }
  return payloads;
}

function resolveSearchExecutionContext(params: {
  argv: string[];
  workdir: string;
  context?: SearchGuardContext;
}): { argv: string[]; workdir: string } {
  let argv = stripLeadingEnvAssignments(params.argv);
  let workdir = params.workdir;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth += 1) {
    const key = `${workdir}\0${argv.join("\0")}`;
    if (seen.has(key)) {
      break;
    }
    seen.add(key);
    const dispatchUnwrapped = unwrapDispatchWrappersForResolution(argv);
    if (dispatchUnwrapped.join("\0") !== argv.join("\0")) {
      argv = stripLeadingEnvAssignments(dispatchUnwrapped);
      continue;
    }
    workdir = resolvePayloadWorkdir(argv, workdir, params.context) ?? workdir;
    const carriedArgv =
      resolveCarrierCommandArgv(argv, 0, { includeExec: true }) ??
      resolveStaticXargsCommandArgv(argv) ??
      resolveStaticDispatchWrapperCommandArgv(argv);
    if (!carriedArgv || carriedArgv.length === 0) {
      break;
    }
    argv = stripLeadingEnvAssignments(carriedArgv);
  }
  return { argv, workdir };
}

function subshellScopeKey(source: string, endIndex: number): string {
  const stack: number[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < Math.min(endIndex, source.length); index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      stack.push(index);
    } else if (char === ")") {
      stack.pop();
    }
  }
  return stack.join("/");
}

function parentSubshellScopeKey(scope: string): string {
  const index = scope.lastIndexOf("/");
  return index === -1 ? "" : scope.slice(0, index);
}

function currentWorkdirForSubshellScope(
  currentWorkdirBySubshellScope: Map<string, string | undefined>,
  scope: string,
  defaultWorkdir?: string,
): string | undefined {
  if (currentWorkdirBySubshellScope.has(scope)) {
    return currentWorkdirBySubshellScope.get(scope);
  }
  const inherited =
    scope === ""
      ? defaultWorkdir
      : currentWorkdirForSubshellScope(
          currentWorkdirBySubshellScope,
          parentSubshellScopeKey(scope),
          defaultWorkdir,
        );
  currentWorkdirBySubshellScope.set(scope, inherited);
  return inherited;
}

function currentEnvForSubshellScope(
  currentEnvBySubshellScope: Map<string, Record<string, string | undefined> | undefined>,
  scope: string,
  defaultEnv?: Record<string, string | undefined>,
): Record<string, string | undefined> | undefined {
  if (currentEnvBySubshellScope.has(scope)) {
    return currentEnvBySubshellScope.get(scope);
  }
  const inherited =
    scope === ""
      ? defaultEnv
      : currentEnvForSubshellScope(
          currentEnvBySubshellScope,
          parentSubshellScopeKey(scope),
          defaultEnv,
        );
  currentEnvBySubshellScope.set(scope, inherited);
  return inherited;
}

function createCommandPayloads(
  rawCommand: string,
  workdir?: string,
  context?: SearchGuardContext,
): Promise<CommandPayload[]> {
  return (async () => {
    const fallbackCandidates = rawCommand.split(/\r?\n/u).flatMap((line) => {
      const argv = splitShellArgs(line);
      return argv ? payloadsFromCandidateStrings(buildCommandPayloadCandidates(argv), workdir) : [];
    });
    const heredocFallbackCandidates = collectShellHeredocPayloads(
      rawCommand,
      workdir,
      { env: context?.env },
      context ?? {},
      new Set<string>(),
    );
    try {
      const explanation = await explainShellCommand(rawCommand.trim());
      if (explanation.ok) {
        const commands = [...explanation.topLevelCommands, ...explanation.nestedCommands].toSorted(
          (a, b) => a.span.startIndex - b.span.startIndex,
        );
        const parsedCandidates: CommandPayload[] = [];
        const seen = new Set<string>();
        const currentWorkdirBySubshellScope = new Map<string, string | undefined>([["", workdir]]);
        const currentEnvBySubshellScope = new Map<
          string,
          Record<string, string | undefined> | undefined
        >([["", context?.env]]);
        for (const step of commands) {
          const subshellScope = shellExecutionScopeKey(rawCommand, step);
          const stepWorkdir = currentWorkdirForSubshellScope(
            currentWorkdirBySubshellScope,
            subshellScope,
            workdir,
          );
          const stepEnv = currentEnvForSubshellScope(
            currentEnvBySubshellScope,
            subshellScope,
            context?.env,
          );
          const envBeforeCommand = envWithShellAssignmentsBeforeCommand(
            rawCommand,
            step.span.startIndex,
            stepEnv,
          );
          const assignmentAdjusted = extractLeadingEnvAssignments(step.argv, envBeforeCommand);
          if (assignmentAdjusted.assignmentOnly) {
            const uncertain = isInsideShellControlFlowBody(rawCommand, step.span.startIndex);
            currentEnvBySubshellScope.set(
              subshellScope,
              uncertain
                ? envWithAssignments(
                    stepEnv,
                    step.argv.map(parseEnvAssignment).filter(isEnvAssignment),
                    {
                      uncertain: true,
                    },
                  )
                : assignmentAdjusted.env,
            );
            continue;
          }
          const stepArgv = assignmentAdjusted.argv.length > 0 ? assignmentAdjusted.argv : step.argv;
          const stepContext: SearchGuardContext = {
            ...context,
            env: assignmentAdjusted.env ?? stepEnv,
          };
          const stdinFromPipe =
            hasPipedStdinBeforeCommand(rawCommand, step.span.startIndex) ||
            hasStdinRedirectionForCommand(rawCommand, step.span.startIndex, step.span.endIndex);
          for (const payload of collectPayloadsForArgv(
            stepArgv,
            stepWorkdir,
            {
              env: stepContext.env,
              stdinFromPipe,
            },
            stepContext,
          )) {
            pushUniquePayload(parsedCandidates, seen, payload);
          }
          if (stepWorkdir && isCwdChangingCommandContext(step.context)) {
            const nextWorkdir = resolveCdWorkdir(stepArgv, stepWorkdir, stepContext);
            if (nextWorkdir && isInsideShellControlFlowBody(rawCommand, step.span.startIndex)) {
              currentWorkdirBySubshellScope.set(subshellScope, controlFlowUnknownWorkdir());
            } else if (
              nextWorkdir &&
              !isConditionallyExecutedShellCommand(rawCommand, step.span.startIndex) &&
              !hasPipedStdoutAfterCommand(rawCommand, step.span.endIndex) &&
              !hasBackgroundAfterCommand(rawCommand, step.span.endIndex)
            ) {
              currentWorkdirBySubshellScope.set(subshellScope, nextWorkdir);
            } else if (!nextWorkdir) {
              currentWorkdirBySubshellScope.set(subshellScope, stepWorkdir);
            }
          }
          if (stepWorkdir && step.context === "top-level") {
            const functionWorkdir = resolveShellFunctionInvocationWorkdir(
              rawCommand,
              step.span.startIndex,
              stepArgv,
              stepWorkdir,
              stepContext,
            );
            if (functionWorkdir) {
              currentWorkdirBySubshellScope.set(subshellScope, functionWorkdir);
            }
          }
        }
        for (const payload of heredocFallbackCandidates) {
          pushUniquePayload(parsedCandidates, seen, payload);
        }
        return parsedCandidates.length > 0 ? parsedCandidates : fallbackCandidates;
      }
    } catch {
      // Fall back to line-local shell splitting below.
    }
    return [...fallbackCandidates, ...heredocFallbackCandidates];
  })();
}

function stripLeadingEnvAssignments(argv: string[]): string[] {
  let index = 0;
  while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[index] ?? "")) {
    index += 1;
  }
  return index > 0 ? argv.slice(index) : argv;
}

function collectNonOptionArgs(
  args: readonly string[],
  optionsWithValues: ReadonlySet<string>,
): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (token === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const option = token.split("=", 1)[0] ?? token;
      if (!token.includes("=") && optionsWithValues.has(option)) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const option = token.slice(0, 2);
      if (optionsWithValues.has(option) && token.length === 2) {
        index += 1;
      }
      continue;
    }
    positional.push(token);
  }
  return positional;
}

function hasGrepRecursiveFlag(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (
      arg === "--recursive" ||
      arg === "--dereference-recursive" ||
      arg === "-r" ||
      arg === "-R"
    ) {
      return true;
    }
    if (arg === "-d" || arg === "--directories") {
      const value = args[index + 1];
      if (value === "recurse") {
        return true;
      }
      index += 1;
      continue;
    }
    if (arg === "--directories=recurse") {
      return true;
    }
    if (/^-[^-].*[rR]/u.test(arg)) {
      return true;
    }
  }
  return false;
}

function hasStandaloneHelpOrVersionOption(
  args: readonly string[],
  optionsWithValues: ReadonlySet<string>,
): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (token === "--") {
      return false;
    }
    if (token === "--help" || token === "--version") {
      return true;
    }
    if (token.startsWith("--")) {
      const option = token.split("=", 1)[0] ?? token;
      if (!token.includes("=") && optionsWithValues.has(option)) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const option = token.slice(0, 2);
      if (optionsWithValues.has(option) && token.length === 2) {
        index += 1;
      }
    }
  }
  return false;
}

function hasSearchPatternOption(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (arg === "-e" || arg === "--regexp" || arg === "-f" || arg === "--file") {
      return true;
    }
    return (
      arg.startsWith("-e") ||
      arg.startsWith("-f") ||
      arg.startsWith("--regexp=") ||
      arg.startsWith("--file=")
    );
  });
}

function resolveRgSearchPaths(args: readonly string[], stdinFromPipe = false): string[] {
  if (hasStandaloneHelpOrVersionOption(args, RG_OPTION_ARGS_WITH_VALUES)) {
    return [];
  }
  const nonOptionArgs = collectNonOptionArgs(args, RG_OPTION_ARGS_WITH_VALUES);
  if (stdinFromPipe && !args.includes("--files")) {
    if (hasSearchPatternOption(args)) {
      return nonOptionArgs;
    }
    return nonOptionArgs.length > 1 ? nonOptionArgs.slice(1) : [];
  }
  return args.includes("--files") || hasSearchPatternOption(args)
    ? nonOptionArgs.length > 0
      ? nonOptionArgs
      : ["."]
    : nonOptionArgs.length > 1
      ? nonOptionArgs.slice(1)
      : ["."];
}

function resolveGrepSearchPaths(args: readonly string[]): string[] {
  if (hasStandaloneHelpOrVersionOption(args, GREP_OPTION_ARGS_WITH_VALUES)) {
    return [];
  }
  const nonOptionArgs = collectNonOptionArgs(args, GREP_OPTION_ARGS_WITH_VALUES);
  return hasSearchPatternOption(args)
    ? nonOptionArgs.length > 0
      ? nonOptionArgs
      : ["."]
    : nonOptionArgs.length > 1
      ? nonOptionArgs.slice(1)
      : ["."];
}

function resolveFindSearchPaths(args: readonly string[]): string[] {
  if (hasStandaloneHelpOrVersionOption(args, new Set())) {
    return [];
  }
  const paths: string[] = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      index += 1;
      continue;
    }
    if (arg === "-H" || arg === "-L" || arg === "-P" || /^-O(?:\d+)?$/u.test(arg)) {
      index += 1;
      continue;
    }
    if (arg === "-D") {
      index += 2;
      continue;
    }
    if (arg === "-files0-from" || arg.startsWith("-files0-from=")) {
      return [FIND_DYNAMIC_STARTING_POINTS_ROOT];
    }
    break;
  }
  for (; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-files0-from" || arg.startsWith("-files0-from=")) {
      return [FIND_DYNAMIC_STARTING_POINTS_ROOT];
    }
    if (arg === "!" || arg === "(" || arg === ")" || arg.startsWith("-")) {
      break;
    }
    paths.push(arg);
  }
  return paths.length > 0 ? paths : ["."];
}

function resolveSearchTargetPath(
  searchPath: string,
  workdir: string,
  context?: SearchGuardContext,
): string | null {
  if (!searchPath || searchPath === "-") {
    return null;
  }
  const expanded = expandShellHomePrefix(searchPath, context?.env);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(workdir, expanded));
}

function expandShellHomePrefix(input: string, env?: SearchGuardContext["env"]): string {
  const shellHome = env?.HOME || process.env.HOME || os.homedir();
  const openClawStateDir = env?.OPENCLAW_STATE_DIR ?? process.env.OPENCLAW_STATE_DIR;
  if (/^~[^/\\]+(?=$|[\\/])/u.test(input)) {
    const currentUser = os.userInfo().username;
    return input.replace(/^~([^/\\]+)(?=$|[\\/])/u, (match, user) => {
      if (user === currentUser && shellHome) {
        return shellHome;
      }
      return match;
    });
  }
  const expandedHome = shellHome
    ? input
        .replace(/^~(?=$|[\\/])/u, shellHome)
        .replace(/\$HOME(?=$|[\\/])/gu, shellHome)
        .replace(/\$\{HOME\}(?=$|[\\/])/gu, shellHome)
    : input;
  const expandedStateDir = openClawStateDir
    ? expandedHome
        .replace(/\$OPENCLAW_STATE_DIR(?=$|[\\/])/gu, openClawStateDir)
        .replace(/\$\{OPENCLAW_STATE_DIR\}(?=$|[\\/])/gu, openClawStateDir)
    : expandedHome;
  return expandShellVariables(expandedStateDir, env);
}

function hasUnresolvedTildeUserPrefix(searchPath: string): boolean {
  const match = searchPath.match(/^~([^/\\]+)(?=$|[\\/])/u);
  if (!match) {
    return false;
  }
  return match[1] !== os.userInfo().username;
}

function expandShellVariables(input: string, env?: SearchGuardContext["env"]): string {
  const sourceEnv = env ?? process.env;
  return input.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(?=$|[\\/])/gu,
    (match, braced, bare) => {
      const name = String(braced ?? bare ?? "");
      const value = sourceEnv[name];
      return value ? value : match;
    },
  );
}

function maybeRealpath(targetPath: string): string | null {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function protectedRootForResolvedPath(
  resolved: string,
  context?: SearchGuardContext,
): string | null {
  const normalizedResolved = path.resolve(resolved);
  if (normalizedResolved === path.parse(normalizedResolved).root) {
    return normalizedResolved;
  }
  const homeDirs = Array.from(
    new Set(
      normalizeStringEntries([resolveRequiredHomeDir(), os.homedir(), context?.env?.HOME]).map(
        (home) => path.resolve(home),
      ),
    ),
  );
  const matchedHomeAncestor = homeDirs.find((homeRoot) => {
    const relative = path.relative(normalizedResolved, homeRoot);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (matchedHomeAncestor) {
    return normalizedResolved;
  }
  const matchedHomeRoot = homeDirs.find((root) => {
    const normalizedRoot = path.resolve(root);
    return (
      normalizedResolved === normalizedRoot || normalizedResolved === maybeRealpath(normalizedRoot)
    );
  });
  if (matchedHomeRoot) {
    return matchedHomeRoot;
  }
  const configuredOpenClawStateRoots = normalizeStringEntries([
    context?.env?.OPENCLAW_STATE_DIR,
    process.env.OPENCLAW_STATE_DIR,
  ]);
  const stateProtectedRoots = [
    ...homeDirs.flatMap((homeDir) => [
      path.join(homeDir, ".codex"),
      path.join(homeDir, ".codex", "sessions"),
      path.join(homeDir, ".codex", "archived_sessions"),
      path.join(homeDir, ".openclaw"),
    ]),
    ...configuredOpenClawStateRoots,
  ];
  stateProtectedRoots.sort((left, right) => right.length - left.length);
  const matchedStateAncestor = stateProtectedRoots.find((root) => {
    const candidates = [path.resolve(root), maybeRealpath(root)].filter(
      (candidate): candidate is string => candidate !== null,
    );
    return candidates.some((candidate) => {
      const relative = path.relative(normalizedResolved, candidate);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    });
  });
  if (matchedStateAncestor) {
    return normalizedResolved;
  }
  const matchedStateRoot = stateProtectedRoots.find((root) => {
    const candidates = [path.resolve(root), maybeRealpath(root)].filter(
      (candidate): candidate is string => candidate !== null,
    );
    return candidates.some((candidate) => {
      const relative = path.relative(candidate, normalizedResolved);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
  });
  if (matchedStateRoot) {
    return matchedStateRoot;
  }
  const additionalProtectedRoots = normalizeStringEntries(context?.additionalProtectedRoots ?? []);
  const matchedAdditionalRoot = additionalProtectedRoots.find((root) => {
    const candidates = [path.resolve(root), maybeRealpath(root)].filter(
      (candidate): candidate is string => candidate !== null,
    );
    return candidates.some((candidate) => {
      if (normalizedResolved === candidate) {
        return true;
      }
      const relative = path.relative(normalizedResolved, candidate);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    });
  });
  if (matchedAdditionalRoot) {
    return matchedAdditionalRoot;
  }
  const matchedRunnerWorkRoot = homeDirs
    .map((homeDir) => {
      const relative = path.relative(homeDir, normalizedResolved).split(path.sep).filter(Boolean);
      return relative[0] === "work" && relative.length <= 2 ? normalizedResolved : null;
    })
    .find((root) => root !== null);
  if (matchedRunnerWorkRoot) {
    return matchedRunnerWorkRoot;
  }
  const segments = normalizedResolved.split(path.sep).filter(Boolean);
  if (segments[0] === "Volumes" && segments.length <= 3) {
    return path.sep + path.join(...segments);
  }
  if (segments.length === 1 && ["workspace", "workspaces"].includes(segments[0] ?? "")) {
    return normalizedResolved;
  }
  if (segments.at(-1) === "repos" && segments.length <= 3) {
    return normalizedResolved;
  }
  return null;
}

function protectedRootForPath(targetPath: string, context?: SearchGuardContext): string | null {
  const resolved = path.resolve(targetPath);
  return (
    protectedRootForResolvedPath(resolved, context) ??
    protectedRootForResolvedPath(maybeRealpath(resolved) ?? resolved, context)
  );
}

function nearestGitRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function globBaseSearchPath(searchPath: string): string | null {
  const globIndex = searchPath.search(/[*?[{]/u);
  if (globIndex === -1) {
    return null;
  }
  const prefix = searchPath.slice(0, globIndex);
  if (!prefix || prefix.endsWith("/") || prefix.endsWith("\\")) {
    return prefix ? prefix.replace(/[\\/]+$/u, "") || "." : ".";
  }
  return path.dirname(prefix);
}

function protectedRootForSearchPath(
  searchPath: string,
  workdir: string,
  context?: SearchGuardContext,
): string | null {
  if (searchPath === FIND_DYNAMIC_STARTING_POINTS_ROOT) {
    return FIND_DYNAMIC_STARTING_POINTS_ROOT;
  }
  if (
    searchPath.includes("$(") ||
    searchPath.includes("`") ||
    hasUnresolvedTildeUserPrefix(searchPath)
  ) {
    return DYNAMIC_SHELL_EXPANSION_ROOT;
  }
  const targetPath = resolveSearchTargetPath(searchPath, workdir, context);
  if (!targetPath) {
    return null;
  }
  const gitRoot = nearestGitRoot(workdir);
  if (gitRoot) {
    const relativeFromTargetToGitRoot = path.relative(targetPath, gitRoot);
    if (
      relativeFromTargetToGitRoot !== "" &&
      !relativeFromTargetToGitRoot.startsWith("..") &&
      !path.isAbsolute(relativeFromTargetToGitRoot)
    ) {
      return targetPath;
    }
  }
  const directRoot = protectedRootForPath(targetPath, context);
  if (directRoot) {
    return directRoot;
  }
  const globBase = globBaseSearchPath(searchPath);
  if (!globBase) {
    return null;
  }
  const globBasePath = resolveSearchTargetPath(globBase, workdir, context);
  return globBasePath ? protectedRootForPath(globBasePath, context) : null;
}

function detectBroadSearchArgv(params: {
  argv: string[];
  workdir: string;
  stdinFromPipe?: boolean;
  context?: SearchGuardContext;
}): UnsafeExecBroadSearchShellCommand | null {
  const resolvedContext = resolveSearchExecutionContext({
    argv: params.argv,
    workdir: params.workdir,
    context: params.context,
  });
  const argv = resolvedContext.argv;
  const executable = normalizeCommandBaseName(argv[0]);
  const args = argv.slice(1);
  const paths =
    executable === "rg" || executable === "ripgrep"
      ? resolveRgSearchPaths(args, params.stdinFromPipe === true)
      : executable === "grep" && hasGrepRecursiveFlag(args)
        ? resolveGrepSearchPaths(args)
        : executable === "find"
          ? resolveFindSearchPaths(args)
          : [];
  const normalizedExecutable =
    executable === "rg" || executable === "ripgrep"
      ? "rg"
      : executable === "grep" || executable === "find"
        ? executable
        : null;
  if (!normalizedExecutable || paths.length === 0) {
    return null;
  }
  for (const searchPath of paths) {
    const protectedRoot = protectedRootForSearchPath(
      searchPath,
      resolvedContext.workdir,
      params.context,
    );
    if (protectedRoot) {
      return {
        executable: normalizedExecutable,
        path: searchPath,
        protectedRoot,
      };
    }
  }
  return null;
}

export async function detectUnsafeExecBroadSearchShellCommand(params: {
  command: string;
  workdir: string;
  env?: Record<string, string | undefined>;
  additionalProtectedRoots?: readonly string[];
}): Promise<UnsafeExecBroadSearchShellCommand | null> {
  const context: SearchGuardContext = {
    env: params.env,
    additionalProtectedRoots: params.additionalProtectedRoots,
  };
  const payloads = await createCommandPayloads(params.command, params.workdir, context);
  for (const payload of payloads) {
    const payloadContext = payload.env
      ? { ...context, env: { ...(context.env ?? process.env), ...payload.env } }
      : context;
    const hit = detectBroadSearchArgv({
      argv: payload.argv,
      workdir: payload.workdir ?? params.workdir,
      stdinFromPipe: payload.stdinFromPipe,
      context: payloadContext,
    });
    if (hit) {
      return hit;
    }
  }
  return null;
}

export async function rejectUnsafeExecBroadSearchShellCommand(params: {
  command: string;
  workdir: string;
  env?: Record<string, string | undefined>;
  additionalProtectedRoots?: readonly string[];
}): Promise<void> {
  const hit = await detectUnsafeExecBroadSearchShellCommand(params);
  if (!hit) {
    return;
  }
  throw new Error(
    [
      `exec blocked broad recursive ${hit.executable} search over protected root ${hit.protectedRoot}.`,
      `Requested search path: ${hit.path}.`,
      "Narrow the command to a repo, task, exact file, or evidence directory; prefer indexed/search tools when available; and cap output with flags such as --max-count or a downstream head/sed range.",
    ].join(" "),
  );
}
