import { splitShellArgs } from "../utils/shell-argv.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";
import { parseInlineOptionToken } from "./inline-option-token.js";

// Command carriers are executables that can hide the real command behind
// wrapper-specific options, environment assignments, or shell-style splitting.
export const COMMAND_CARRIER_EXECUTABLES = new Set(["sudo", "doas", "env", "command", "builtin"]);

export const SOURCE_EXECUTABLES = new Set([".", "source"]);

const MAX_ENV_SPLIT_PAYLOAD_DEPTH = 32;

const COMMAND_EXECUTING_OPTIONS = new Set(["-p"]);
const ENV_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-P",
  "-S",
  "-s",
  "-u",
  "--argv0",
  "--block-signal",
  "--chdir",
  "--default-signal",
  "--ignore-signal",
  "--split-string",
  "--unset",
]);
const ENV_SPLIT_STRING_OPTIONS = new Set(["-S", "-s", "--split-string"]);
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
  "--chroot",
  "--close-from",
  "--command-timeout",
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
  "-B",
  "-b",
  "-E",
  "-H",
  "-i",
  "-k",
  "-N",
  "-n",
  "-P",
  "-S",
  "-s",
  "--askpass",
  "--background",
  "--bell",
  "--login",
  "--no-update",
  "--non-interactive",
  "--preserve-env",
  "--preserve-groups",
  "--reset-home",
  "--reset-timestamp",
  "--set-home",
  "--shell",
  "--stdin",
]);
const SUDO_NON_EXEC_OPTIONS = new Set([
  "-K",
  "-l",
  "-V",
  "-v",
  "-e",
  "--edit",
  "--help",
  "--list",
  "--remove-timestamp",
  "--validate",
  "--version",
]);
const DOAS_OPTIONS_WITH_VALUE = new Set(["-a", "-C", "-u"]);
const DOAS_STANDALONE_OPTIONS = new Set(["-L", "-n", "-s"]);
const EXEC_OPTIONS_WITH_VALUE = new Set(["-a"]);
const EXEC_STANDALONE_OPTIONS = new Set(["-c", "-l"]);

export function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
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
    const option = parseInlineOptionToken(token);
    const name = option.name;
    if (nonExecutingOptions.has(name)) {
      return null;
    }
    if (standaloneOptions.has(name) || optionsWithValue.has(name)) {
      return [option];
    }
    return null;
  }

  if (!/^-[A-Za-z0-9]/u.test(token)) {
    return null;
  }

  const options: ParsedCarrierOption[] = [];
  for (let index = 1; index < token.length; index += 1) {
    const name = `-${token[index] ?? ""}`;
    if (nonExecutingOptions.has(name)) {
      return null;
    }
    if (optionsWithValue.has(name)) {
      options.push({
        name,
        hasInlineValue: index < token.length - 1,
        inlineValue: index < token.length - 1 ? token.slice(index + 1) : undefined,
      });
      return options;
    }
    if (standaloneOptions.has(name)) {
      options.push({ name, hasInlineValue: false });
      continue;
    }
    return null;
  }
  return options.length > 0 ? options : null;
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
  // env -S can recursively introduce another env wrapper; keep a bounded depth
  // so malicious argv cannot create unbounded parser work.
  return resolveEnvCarriedArgv(["env", ...carriedArgv], depth + 1) ?? carriedArgv;
}

type ParsedEnvInvocationPrelude = {
  assignmentKeys: string[];
  commandIndex: number;
  splitArgv?: string[];
  usesModifiers: boolean;
};

/** Parse the option and assignment prelude of an `env` invocation. */
export function parseEnvInvocationPrelude(
  argv: string[],
  depth = 0,
): ParsedEnvInvocationPrelude | null {
  if (depth > MAX_ENV_SPLIT_PAYLOAD_DEPTH || normalizeExecutableToken(argv[0] ?? "") !== "env") {
    return null;
  }
  let usesModifiers = false;
  const assignmentKeys: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token) {
      return null;
    }
    if (isEnvAssignmentToken(token)) {
      usesModifiers = true;
      assignmentKeys.push(token.slice(0, token.indexOf("=")));
      continue;
    }
    if (token === "--" || token === "-") {
      return index + 1 < argv.length
        ? { assignmentKeys, commandIndex: index + 1, usesModifiers }
        : null;
    }
    if (token.startsWith("-")) {
      const option = parseCarrierOptionToken(token, ENV_STANDALONE_OPTIONS, ENV_OPTIONS_WITH_VALUE);
      if (!option) {
        return null;
      }
      usesModifiers = true;
      const splitStringOption = option.find((entry) => ENV_SPLIT_STRING_OPTIONS.has(entry.name));
      if (splitStringOption) {
        const payloadIndex = splitStringOption.inlineValue === undefined ? index + 1 : index;
        const payload = splitStringOption.inlineValue ?? argv[payloadIndex];
        const trailingIndex = payloadIndex + 1;
        const splitArgv =
          typeof payload === "string"
            ? resolveEnvSplitPayload(payload, argv.slice(trailingIndex), depth)
            : null;
        return splitArgv
          ? {
              assignmentKeys,
              commandIndex: trailingIndex,
              splitArgv,
              usesModifiers,
            }
          : null;
      }
      if (option.some((entry) => ENV_OPTIONS_WITH_VALUE.has(entry.name) && !entry.hasInlineValue)) {
        index += 1;
      }
      continue;
    }
    return { assignmentKeys, commandIndex: index, usesModifiers };
  }
  return null;
}

export function envInvocationUsesModifiers(argv: string[]): boolean {
  const parsed = parseEnvInvocationPrelude(argv);
  return parsed?.usesModifiers ?? normalizeExecutableToken(argv[0] ?? "") === "env";
}

/** Return the argv carried by `env`, including argv reconstructed from `env -S`. */
export function unwrapEnvInvocation(argv: string[]): string[] | null {
  return resolveEnvCarriedArgv(argv);
}

/** Resolve the command argv behind an `env` carrier, honoring bounded `env -S` recursion. */
function resolveEnvCarriedArgv(argv: string[], depth = 0): string[] | null {
  const parsed = parseEnvInvocationPrelude(argv, depth);
  return parsed ? (parsed.splitArgv ?? argv.slice(parsed.commandIndex)) : null;
}

function resolveCommandBuiltinCarriedArgv(argv: string[]): string[] | null {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return argv.slice(index + 1);
    }
    if (!token.startsWith("-")) {
      return argv.slice(index);
    }
    const normalized = parseInlineOptionToken(token).name;
    if (!COMMAND_EXECUTING_OPTIONS.has(normalized)) {
      return null;
    }
  }
  return null;
}

function resolveOptionCarrierArgv(argv: string[]): string[] | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  const profile: readonly [ReadonlySet<string>, ReadonlySet<string>, ReadonlySet<string>?] | null =
    executable === "sudo"
      ? [SUDO_STANDALONE_OPTIONS, SUDO_OPTIONS_WITH_VALUE, SUDO_NON_EXEC_OPTIONS]
      : executable === "doas"
        ? [DOAS_STANDALONE_OPTIONS, DOAS_OPTIONS_WITH_VALUE]
        : executable === "exec"
          ? [EXEC_STANDALONE_OPTIONS, EXEC_OPTIONS_WITH_VALUE]
          : null;
  if (!profile) {
    return null;
  }
  const [standaloneOptions, optionsWithValue, nonExecutingOptions] = profile;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--" || !token.startsWith("-")) {
      const commandArgv = argv.slice(token === "--" ? index + 1 : index);
      if (executable !== "sudo") {
        return executable === "exec" || commandArgv.length > 0 ? commandArgv : null;
      }
      let assignmentIndex = 0;
      while (
        assignmentIndex < commandArgv.length &&
        isEnvAssignmentToken(commandArgv[assignmentIndex] ?? "")
      ) {
        assignmentIndex += 1;
      }
      return assignmentIndex < commandArgv.length ? commandArgv.slice(assignmentIndex) : null;
    }
    const option = parseCarrierOptionToken(
      token,
      standaloneOptions,
      optionsWithValue,
      nonExecutingOptions,
    );
    if (!option) {
      return null;
    }
    if (option.some((entry) => optionsWithValue.has(entry.name) && !entry.hasInlineValue)) {
      index += 1;
    }
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
      return resolveOptionCarrierArgv(argv);
    case "exec":
      return options?.includeExec ? resolveOptionCarrierArgv(argv) : null;
    default:
      return null;
  }
}
