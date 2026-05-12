import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export const POSIX_INLINE_COMMAND_FLAGS = new Set(["-lc", "-c", "--command"]);

function expandPowerShellSwitchPrefixForms(name: string, minPrefixLength: number): string[] {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  const forms: string[] = [];
  for (let length = minPrefixLength; length <= normalized.length; length += 1) {
    const prefix = normalized.slice(0, length);
    forms.push(`-${prefix}`, `/${prefix}`);
  }
  forms.push(`--${normalized}`);
  return forms;
}

function expandPowerShellSwitchForms(names: string[]): string[] {
  return names.flatMap((name) => {
    const normalized = normalizeLowercaseStringOrEmpty(name);
    return [`-${normalized}`, `/${normalized}`];
  });
}

const POWERSHELL_COMMAND_FLAGS = [
  ...expandPowerShellSwitchPrefixForms("command", 1),
  "-cwa",
  "/cwa",
  "--commandwithargs",
];
const POWERSHELL_FILE_FLAGS = expandPowerShellSwitchPrefixForms("file", 1);
const POWERSHELL_ENCODED_COMMAND_FLAGS = [
  ...expandPowerShellSwitchPrefixForms("encodedcommand", 1),
  "-ec",
  "/ec",
];
const POWERSHELL_OPTIONS_WITH_SEPARATE_VALUES = new Set([
  ...expandPowerShellSwitchPrefixForms("configurationname", 1),
  ...expandPowerShellSwitchPrefixForms("custompipename", 3),
  ...expandPowerShellSwitchPrefixForms("encodedarguments", 8),
  ...expandPowerShellSwitchPrefixForms("executionpolicy", 1),
  ...expandPowerShellSwitchPrefixForms("inputformat", 1),
  ...expandPowerShellSwitchPrefixForms("outputformat", 1),
  ...expandPowerShellSwitchPrefixForms("psconsolefile", 1),
  ...expandPowerShellSwitchPrefixForms("settingsfile", 1),
  ...expandPowerShellSwitchPrefixForms("token", 2),
  ...expandPowerShellSwitchPrefixForms("utctimestamp", 3),
  ...expandPowerShellSwitchPrefixForms("version", 1),
  ...expandPowerShellSwitchPrefixForms("windowstyle", 1),
  ...expandPowerShellSwitchPrefixForms("workingdirectory", 1),
  ...expandPowerShellSwitchForms(["ea", "ep"]),
  "-if",
  "/if",
  "-of",
  "/of",
  "-wd",
  "/wd",
]);

export const POWERSHELL_INLINE_COMMAND_TAIL_FLAGS = new Set(POWERSHELL_COMMAND_FLAGS);
export const POWERSHELL_INLINE_COMMAND_FLAGS = new Set([
  ...POWERSHELL_COMMAND_FLAGS,
  ...POWERSHELL_FILE_FLAGS,
  ...POWERSHELL_ENCODED_COMMAND_FLAGS,
]);

const POSIX_SHELL_OPTIONS_WITH_SEPARATE_VALUES = new Set([
  "--init-file",
  "--rcfile",
  "-O",
  "-o",
  "+O",
  "+o",
]);

function isCombinedCommandFlag(token: string): boolean {
  return parseCombinedCommandFlag(token) !== null;
}

function countSeparateValueOptionChars(token: string): number {
  let count = 0;
  for (let index = 1; index < token.length; index += 1) {
    const char = token[index];
    if (char === "o" || char === "O") {
      count += 1;
    }
  }
  return count;
}

function parseCombinedCommandFlag(
  token: string,
): { attachedCommand: string | null; separateValueCount: number } | null {
  if (token.length < 2 || token[0] !== "-" || token[1] === "-") {
    return null;
  }
  const optionChars = token.slice(1);
  const commandFlagIndex = optionChars.indexOf("c");
  if (commandFlagIndex === -1 || optionChars.includes("-")) {
    return null;
  }
  const suffix = optionChars.slice(commandFlagIndex + 1);
  if (suffix && !/^[A-Za-z]+$/.test(suffix)) {
    return { attachedCommand: suffix, separateValueCount: 0 };
  }
  return {
    attachedCommand: null,
    separateValueCount: countSeparateValueOptionChars(token),
  };
}

function combinedSeparateValueOptionCount(token: string): number {
  if (
    token.length < 2 ||
    (token[0] !== "-" && token[0] !== "+") ||
    token[1] === "-" ||
    token.slice(1).includes("-")
  ) {
    return 0;
  }
  return countSeparateValueOptionChars(token);
}

function consumesSeparateValue(token: string): boolean {
  return POSIX_SHELL_OPTIONS_WITH_SEPARATE_VALUES.has(token);
}

function isPosixInteractiveModeOption(token: string): boolean {
  return token === "--interactive" || isPosixShortOption(token, "i");
}

function isPosixShortOption(token: string, option: string): boolean {
  if (token.length < 2 || token[0] !== "-" || token[1] === "-") {
    return false;
  }
  let hasOption = false;
  for (let index = 1; index < token.length; index += 1) {
    const char = token[index];
    if (char === "-") {
      return false;
    }
    if (char === option) {
      hasOption = true;
    }
  }
  return hasOption;
}

function advancePosixInlineOptionScan(token: string): number {
  const combinedValueCount = combinedSeparateValueOptionCount(token);
  if (combinedValueCount > 0) {
    return 1 + combinedValueCount;
  }
  if (consumesSeparateValue(token)) {
    return 2;
  }
  return 1;
}

export function resolveInlineCommandMatch(
  argv: string[],
  flags: ReadonlySet<string>,
  options: {
    allowCombinedC?: boolean;
    stopAtFirstNonOption?: boolean;
    valueOptions?: ReadonlySet<string>;
  } = {},
): { command: string | null; valueTokenIndex: number | null } {
  for (let i = 1; i < argv.length; ) {
    const token = argv[i]?.trim();
    if (!token) {
      i += 1;
      continue;
    }
    const lower = normalizeLowercaseStringOrEmpty(token);
    if (lower === "--") {
      break;
    }
    const comparableToken = options.allowCombinedC ? token : lower;
    if (flags.has(comparableToken)) {
      const valueTokenIndex = i + 1 < argv.length ? i + 1 : null;
      const command = argv[i + 1]?.trim();
      return { command: command ? command : null, valueTokenIndex };
    }
    if (options.allowCombinedC && isCombinedCommandFlag(token)) {
      const combined = parseCombinedCommandFlag(token);
      if (combined?.attachedCommand != null) {
        return { command: combined.attachedCommand.trim() || null, valueTokenIndex: i };
      }
      const valueTokenIndex = i + 1 + (combined?.separateValueCount ?? 0);
      const command = argv[valueTokenIndex]?.trim();
      return { command: command ? command : null, valueTokenIndex };
    }
    if (options.allowCombinedC && !token.startsWith("-") && !token.startsWith("+")) {
      break;
    }
    if (options.valueOptions?.has(lower)) {
      i += 2;
      continue;
    }
    if (options.stopAtFirstNonOption && !token.startsWith("-") && !token.startsWith("/")) {
      break;
    }
    i += options.allowCombinedC ? advancePosixInlineOptionScan(token) : 1;
  }
  return { command: null, valueTokenIndex: null };
}

export function resolvePowerShellInlineCommandMatch(argv: string[]): {
  command: string | null;
  valueTokenIndex: number | null;
} {
  return resolveInlineCommandMatch(argv, POWERSHELL_INLINE_COMMAND_FLAGS, {
    stopAtFirstNonOption: true,
    valueOptions: POWERSHELL_OPTIONS_WITH_SEPARATE_VALUES,
  });
}

export function hasPosixInteractiveStartupBeforeInlineCommand(
  argv: string[],
  flags: ReadonlySet<string>,
): boolean {
  let sawInteractiveMode = false;
  for (let i = 1; i < argv.length; ) {
    const token = argv[i]?.trim();
    if (!token) {
      i += 1;
      continue;
    }
    if (token === "--") {
      return false;
    }
    if (isPosixInteractiveModeOption(token)) {
      sawInteractiveMode = true;
    }
    if (flags.has(token) || isCombinedCommandFlag(token)) {
      return sawInteractiveMode;
    }
    if (!token.startsWith("-") && !token.startsWith("+")) {
      return false;
    }
    i += advancePosixInlineOptionScan(token);
  }
  return false;
}

export function hasPosixLoginStartupBeforeInlineCommand(
  argv: string[],
  flags: ReadonlySet<string>,
): boolean {
  let sawLoginMode = false;
  for (let i = 1; i < argv.length; ) {
    const token = argv[i]?.trim();
    if (!token) {
      i += 1;
      continue;
    }
    if (token === "--") {
      return false;
    }
    if (token === "--login" || isPosixShortOption(token, "l")) {
      sawLoginMode = true;
    }
    if (flags.has(token) || isCombinedCommandFlag(token)) {
      return sawLoginMode;
    }
    if (!token.startsWith("-") && !token.startsWith("+")) {
      return false;
    }
    i += advancePosixInlineOptionScan(token);
  }
  return false;
}

export function hasFishInitCommandOption(argv: string[]): boolean {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim();
    if (!token) {
      continue;
    }
    if (token === "--") {
      return false;
    }
    if (
      token === "-C" ||
      token === "--init-command" ||
      (token.startsWith("-C") && token !== "-C") ||
      token.startsWith("--init-command=")
    ) {
      return true;
    }
    if (!token.startsWith("-") && !token.startsWith("+")) {
      return false;
    }
  }
  return false;
}

export function hasFishAttachedCommandOption(argv: string[]): boolean {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim();
    if (!token) {
      continue;
    }
    if (token === "--") {
      return false;
    }
    if (token.startsWith("-c") && token !== "-c") {
      return true;
    }
    if (!token.startsWith("-") && !token.startsWith("+")) {
      return false;
    }
  }
  return false;
}
