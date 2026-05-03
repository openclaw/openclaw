import { splitShellArgs } from "../../utils/shell-argv.js";
import { unwrapKnownDispatchWrapperInvocation } from "../dispatch-wrapper-resolution.js";
import type { ExecCommandSegment } from "../exec-approvals-analysis.js";
import { normalizeExecutableToken } from "../exec-wrapper-resolution.js";
import {
  extractShellWrapperInlineCommand,
  isShellWrapperExecutable,
} from "../shell-wrapper-resolution.js";
import { detectInterpreterInlineEvalArgv, type InterpreterInlineEvalHit } from "./inline-eval.js";

export const COMMAND_CARRIER_EXECUTABLES = new Set(["sudo", "doas", "env", "command", "builtin"]);

export const SOURCE_EXECUTABLES = new Set([".", "source"]);

export type CommandCarrierHit = {
  command: string;
  flag?: string;
};

export type CarriedShellBuiltinHit = { kind: "eval" } | { kind: "source"; command: string };

const MAX_ENV_SPLIT_PAYLOAD_DEPTH = 32;

const COMMAND_EXECUTING_OPTIONS = new Set(["-p"]);
const COMMAND_QUERY_OPTIONS = new Set(["-v", "-V"]);
const ENV_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-S",
  "-u",
  "--argv0",
  "--block-signal",
  "--chdir",
  "--default-signal",
  "--ignore-signal",
  "--split-string",
  "--unset",
]);
const ENV_SPLIT_STRING_OPTIONS = new Set(["-S", "--split-string"]);
const ENV_STANDALONE_OPTIONS = new Set(["-0", "-i", "--ignore-environment", "--null"]);
const SUDO_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-D",
  "-g",
  "-h",
  "-p",
  "-R",
  "-T",
  "-U",
  "-u",
  "--chdir",
  "--close-from",
  "--group",
  "--host",
  "--other-user",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);
const SUDO_STANDALONE_OPTIONS = new Set([
  "-A",
  "-b",
  "-E",
  "-H",
  "-n",
  "-P",
  "-S",
  "--askpass",
  "--background",
  "--login",
  "--non-interactive",
  "--preserve-env",
  "--reset-home",
  "--stdin",
]);
const SUDO_NON_EXEC_OPTIONS = new Set([
  "-K",
  "-k",
  "-l",
  "-V",
  "-v",
  "-e",
  "--edit",
  "--help",
  "--list",
  "--remove-timestamp",
  "--reset-timestamp",
  "--validate",
  "--version",
]);
const DOAS_OPTIONS_WITH_VALUE = new Set(["-a", "-C", "-u"]);
const DOAS_STANDALONE_OPTIONS = new Set(["-L", "-n", "-s"]);
const EXEC_OPTIONS_WITH_VALUE = new Set(["-a"]);
const EXEC_STANDALONE_OPTIONS = new Set(["-c", "-l"]);

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
}

function optionName(token: string): string {
  return token.split("=", 1)[0] ?? token;
}

type ParsedCarrierOption = {
  name: string;
  hasInlineValue: boolean;
  inlineValue?: string;
};

function parseCarrierOptionToken(
  token: string,
  standaloneOptions: ReadonlySet<string>,
  optionsWithValue: ReadonlySet<string>,
  nonExecutingOptions: ReadonlySet<string> = new Set(),
): ParsedCarrierOption[] | null {
  if (token.startsWith("--")) {
    const name = optionName(token);
    if (
      standaloneOptions.has(name) ||
      optionsWithValue.has(name) ||
      nonExecutingOptions.has(name)
    ) {
      const valueDelimiter = token.indexOf("=");
      return [
        {
          name,
          hasInlineValue: valueDelimiter >= 0,
          inlineValue: valueDelimiter >= 0 ? token.slice(valueDelimiter + 1) : undefined,
        },
      ];
    }
    return null;
  }

  if (!/^-[A-Za-z0-9]/u.test(token)) {
    return null;
  }

  const options: ParsedCarrierOption[] = [];
  for (let index = 1; index < token.length; index += 1) {
    const name = `-${token[index] ?? ""}`;
    if (optionsWithValue.has(name)) {
      options.push({
        name,
        hasInlineValue: index < token.length - 1,
        inlineValue: index < token.length - 1 ? token.slice(index + 1) : undefined,
      });
      return options;
    }
    if (standaloneOptions.has(name) || nonExecutingOptions.has(name)) {
      options.push({ name, hasInlineValue: false });
      continue;
    }
    return null;
  }
  return options.length > 0 ? options : null;
}

function knownCarrierOptionConsumesNextValue(
  options: readonly ParsedCarrierOption[],
  optionsWithValue: ReadonlySet<string>,
  nonExecutingOptions: ReadonlySet<string> = new Set(),
): boolean | null {
  let consumesNextValue = false;
  for (const option of options) {
    if (nonExecutingOptions.has(option.name)) {
      return null;
    }
    if (optionsWithValue.has(option.name)) {
      consumesNextValue = !option.hasInlineValue;
    }
  }
  return consumesNextValue;
}

function findParsedCarrierOption(
  options: readonly ParsedCarrierOption[],
  names: ReadonlySet<string>,
): ParsedCarrierOption | undefined {
  return options.find((option) => names.has(option.name));
}

function resolveEnvSplitPayload(
  payload: string,
  trailingArgv: string[],
  depth: number,
): string[] | null {
  const innerArgv = splitShellArgs(payload);
  if (!innerArgv || innerArgv.length === 0) {
    return null;
  }
  const carriedArgv = [...innerArgv, ...trailingArgv];
  return resolveEnvCarriedArgv(["env", ...carriedArgv], depth + 1) ?? carriedArgv;
}

function resolveEnvCarriedArgv(argv: string[], depth = 0): string[] | null {
  if (depth > MAX_ENV_SPLIT_PAYLOAD_DEPTH || normalizeExecutableToken(argv[0] ?? "") !== "env") {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token) {
      return null;
    }
    if (isEnvAssignmentToken(token)) {
      continue;
    }
    if (token === "--") {
      return argv.slice(index + 1);
    }
    if (token.startsWith("-")) {
      const option = parseCarrierOptionToken(token, ENV_STANDALONE_OPTIONS, ENV_OPTIONS_WITH_VALUE);
      if (!option) {
        return null;
      }
      const splitStringOption = findParsedCarrierOption(option, ENV_SPLIT_STRING_OPTIONS);
      if (splitStringOption) {
        const payloadIndex = splitStringOption.inlineValue === undefined ? index + 1 : index;
        const payload = splitStringOption.inlineValue ?? argv[payloadIndex];
        return typeof payload === "string"
          ? resolveEnvSplitPayload(payload, argv.slice(payloadIndex + 1), depth)
          : null;
      }
      const consumeNextValue = knownCarrierOptionConsumesNextValue(option, ENV_OPTIONS_WITH_VALUE);
      if (consumeNextValue) {
        index += 1;
      }
      continue;
    }
    return argv.slice(index);
  }
  return null;
}

function resolveCommandBuiltinCarriedArgv(argv: string[]): string[] | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable !== "command" && executable !== "builtin") {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return argv.slice(index + 1);
    }
    if (!token.startsWith("-")) {
      return argv.slice(index);
    }
    const normalized = optionName(token);
    if (COMMAND_QUERY_OPTIONS.has(normalized)) {
      return null;
    }
    if (!COMMAND_EXECUTING_OPTIONS.has(normalized)) {
      return null;
    }
  }
  return null;
}

function resolveSudoLikeCarriedArgv(argv: string[]): string[] | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  const standaloneOptions =
    executable === "sudo"
      ? SUDO_STANDALONE_OPTIONS
      : executable === "doas"
        ? DOAS_STANDALONE_OPTIONS
        : null;
  const optionsWithValue =
    executable === "sudo"
      ? SUDO_OPTIONS_WITH_VALUE
      : executable === "doas"
        ? DOAS_OPTIONS_WITH_VALUE
        : null;
  if (!standaloneOptions || !optionsWithValue) {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return argv.slice(index + 1);
    }
    if (!token.startsWith("-")) {
      return argv.slice(index);
    }
    const option = parseCarrierOptionToken(
      token,
      standaloneOptions,
      optionsWithValue,
      executable === "sudo" ? SUDO_NON_EXEC_OPTIONS : undefined,
    );
    if (!option) {
      return null;
    }
    const consumeNextValue = knownCarrierOptionConsumesNextValue(
      option,
      optionsWithValue,
      executable === "sudo" ? SUDO_NON_EXEC_OPTIONS : undefined,
    );
    if (consumeNextValue === null) {
      return null;
    }
    if (consumeNextValue) {
      index += 1;
    }
    continue;
  }
  return null;
}

export function resolveCarrierCommandArgv(
  argv: string[],
  depth = 0,
  options?: { includeExec?: boolean },
): string[] | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  switch (executable) {
    case "env":
      return resolveEnvCarriedArgv(argv, depth);
    case "command":
    case "builtin":
      return resolveCommandBuiltinCarriedArgv(argv);
    case "sudo":
    case "doas":
      return resolveSudoLikeCarriedArgv(argv);
    case "exec":
      return options?.includeExec ? resolveExecCarriedArgv(argv) : null;
    default:
      return null;
  }
}

function resolveExecCarriedArgv(argv: string[]): string[] | null {
  if (normalizeExecutableToken(argv[0] ?? "") !== "exec") {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return argv.slice(index + 1);
    }
    if (!token.startsWith("-")) {
      return argv.slice(index);
    }
    const option = parseCarrierOptionToken(token, EXEC_STANDALONE_OPTIONS, EXEC_OPTIONS_WITH_VALUE);
    if (!option) {
      return null;
    }
    const consumeNextValue = knownCarrierOptionConsumesNextValue(option, EXEC_OPTIONS_WITH_VALUE);
    if (consumeNextValue) {
      index += 1;
    }
    continue;
  }
  return null;
}

function commandArgvKey(argv: readonly string[]): string {
  return argv.join("\0");
}

export function buildCommandPayloadCandidates(
  argv: string[],
  seenArgv = new Set<string>(),
): string[] {
  const key = commandArgvKey(argv);
  if (seenArgv.has(key)) {
    return argv.length > 0 ? [argv.join(" ")] : [];
  }
  seenArgv.add(key);
  const assignmentStrippedArgv = stripLeadingEnvAssignments(argv);
  const carriedArgv = resolveCarrierCommandArgv(assignmentStrippedArgv, 0, {
    includeExec: true,
  });
  const executableArgv = carriedArgv ?? assignmentStrippedArgv;
  const carriedCandidates = carriedArgv ? buildCommandPayloadCandidates(carriedArgv, seenArgv) : [];
  const shellWrapperPayload = extractShellWrapperInlineCommand(executableArgv);
  const shellWrapperCandidates = shellWrapperPayload
    ? (() => {
        const innerArgv = splitShellArgs(shellWrapperPayload);
        return innerArgv
          ? buildCommandPayloadCandidates(innerArgv, seenArgv)
          : [shellWrapperPayload];
      })()
    : [];
  return uniqueCommandPayloadCandidates([
    ...(executableArgv.length > 0 ? [executableArgv.join(" ")] : []),
    ...carriedCandidates,
    ...shellWrapperCandidates,
  ]);
}

function stripLeadingEnvAssignments(argv: string[]): string[] {
  let index = 0;
  while (index < argv.length && isEnvAssignmentToken(argv[index] ?? "")) {
    index += 1;
  }
  return index > 0 ? argv.slice(index) : argv;
}

function uniqueCommandPayloadCandidates(candidates: string[]): string[] {
  return [...new Set(candidates.filter((candidate) => candidate.trim().length > 0))];
}

function detectCarrierInlineEvalArgvInternal(
  argv: string[],
  seenArgv: Set<string>,
): InterpreterInlineEvalHit | null {
  const key = commandArgvKey(argv);
  if (seenArgv.has(key)) {
    return null;
  }
  seenArgv.add(key);

  const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(argv);
  if (dispatchUnwrap.kind === "unwrapped") {
    return detectInlineEvalArgvInternal(dispatchUnwrap.argv, seenArgv);
  }

  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (!COMMAND_CARRIER_EXECUTABLES.has(executable)) {
    return null;
  }
  const carriedArgv = resolveCarrierCommandArgv(argv);
  if (!carriedArgv) {
    return null;
  }
  return (
    detectInterpreterInlineEvalArgv(carriedArgv) ??
    detectCarrierInlineEvalArgvInternal(carriedArgv, seenArgv)
  );
}

export function detectCarrierInlineEvalArgv(argv: string[]): InterpreterInlineEvalHit | null {
  return detectCarrierInlineEvalArgvInternal(argv, new Set());
}

function detectInlineEvalArgvInternal(
  argv: string[] | undefined | null,
  seenArgv: Set<string>,
): InterpreterInlineEvalHit | null {
  if (!Array.isArray(argv)) {
    return null;
  }
  return (
    detectInterpreterInlineEvalArgv(argv) ?? detectCarrierInlineEvalArgvInternal(argv, seenArgv)
  );
}

export function detectInlineEvalArgv(
  argv: string[] | undefined | null,
): InterpreterInlineEvalHit | null {
  return detectInlineEvalArgvInternal(argv, new Set());
}

export function detectInlineEvalInSegments(
  segments: readonly ExecCommandSegment[],
): InterpreterInlineEvalHit | null {
  for (const segment of segments) {
    const effective = segment.resolution?.effectiveArgv ?? segment.argv;
    const hit = detectInlineEvalArgv(effective) ?? detectInlineEvalArgv(segment.argv);
    if (hit) {
      return hit;
    }
  }
  return null;
}

export function detectCommandCarrierArgv(argv: string[]): CommandCarrierHit[] {
  const executable = argv[0];
  if (!executable) {
    return [];
  }
  const normalizedExecutable = normalizeExecutableToken(executable);
  const hits: CommandCarrierHit[] = [];
  if (normalizedExecutable === "find") {
    const flag = argv.find((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg));
    if (flag) {
      hits.push({ command: executable, flag });
    }
  }
  if (normalizedExecutable === "xargs") {
    hits.push({ command: normalizedExecutable });
  }
  const splitStringFlag = detectEnvSplitStringFlag(argv);
  if (splitStringFlag) {
    hits.push({ command: normalizedExecutable, flag: splitStringFlag });
  }
  return hits;
}

export function detectEnvSplitStringFlag(argv: string[]): string | null {
  if (normalizeExecutableToken(argv[0] ?? "") !== "env") {
    return null;
  }
  for (const arg of argv.slice(1)) {
    const token = arg.trim();
    if (token === "-S" || token === "--split-string") {
      return token;
    }
    if (token.startsWith("--split-string=") || (token.startsWith("-S") && token.length > 2)) {
      return token.startsWith("--") ? "--split-string" : "-S";
    }
  }
  return null;
}

export function detectShellWrapperThroughCarrierArgv(
  argv: string[],
  shellCommandFlag: (argv: string[], startIndex: number) => unknown,
): string | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (!COMMAND_CARRIER_EXECUTABLES.has(executable)) {
    return null;
  }
  const carriedArgv = resolveCarrierCommandArgv(argv);
  if (!carriedArgv) {
    return null;
  }
  if (isShellWrapperExecutable(carriedArgv[0] ?? "") && shellCommandFlag(carriedArgv, 1)) {
    return executable;
  }
  return detectShellWrapperThroughCarrierArgv(carriedArgv, shellCommandFlag) ? executable : null;
}

export function detectCarriedShellBuiltinArgv(argv: string[]): CarriedShellBuiltinHit | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (!COMMAND_CARRIER_EXECUTABLES.has(executable)) {
    return null;
  }
  const carriedArgv = resolveCarrierCommandArgv(argv);
  if (!carriedArgv) {
    return null;
  }
  const nestedCarrierHit = detectCarriedShellBuiltinArgv(carriedArgv);
  if (nestedCarrierHit) {
    return nestedCarrierHit;
  }
  const carriedCommand = carriedArgv[0];
  const normalizedCarriedCommand = carriedCommand
    ? normalizeExecutableToken(carriedCommand)
    : undefined;
  if (normalizedCarriedCommand === "eval") {
    return { kind: "eval" };
  }
  if (normalizedCarriedCommand && SOURCE_EXECUTABLES.has(normalizedCarriedCommand)) {
    return { kind: "source", command: normalizedCarriedCommand };
  }
  return null;
}
