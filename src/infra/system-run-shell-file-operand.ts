import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseInlineOptionToken } from "./inline-option-token.js";
import {
  advancePosixInlineOptionScan,
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "./shell-inline-command.js";
import { POSIX_SHELL_WRAPPERS } from "./shell-wrapper-resolution.js";

const POSIX_SHELL_OPTIONS_WITH_VALUE = new Set([
  "--init-file",
  "--rcfile",
  "--startup-script",
  "-O",
  "-o",
  "+O",
  "+o",
]);
const POSIX_SHELL_CODE_LOADING_OPTIONS = new Set(["--init-file", "--rcfile", "--startup-script"]);
const POSIX_SHELLS_WITH_PLUS_OPTIONS = new Set([
  "ash",
  "bash",
  "dash",
  "ksh",
  "mksh",
  "osh",
  "sh",
  "yash",
  "zsh",
]);

function normalizeOptionFlag(token: string): string {
  return normalizeLowercaseStringOrEmpty(parseInlineOptionToken(token).name);
}

function isPosixShellOptionToken(token: string, supportsPlusOptions: boolean): boolean {
  return token.startsWith("-") || (supportsPlusOptions && token.startsWith("+"));
}

function isPosixShellStdinOption(token: string): boolean {
  if (token === "--stdin") {
    return true;
  }
  return (
    token.startsWith("-") && !token.startsWith("--") && !token.includes("=") && token.includes("s")
  );
}

export function resolvePosixShellScriptOperandIndex(
  argv: string[],
  executable: string,
): number | null {
  const supportsPlusOptions = POSIX_SHELLS_WITH_PLUS_OPTIONS.has(executable);
  if (
    resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, {
      allowCombinedC: true,
      isOptionToken: (token) => isPosixShellOptionToken(token, supportsPlusOptions),
      stopAtFirstNonOption: true,
    }).valueTokenIndex !== null
  ) {
    return null;
  }
  let afterDoubleDash = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (token === "-" || (!afterDoubleDash && isPosixShellStdinOption(token))) {
      return null;
    }
    if (!afterDoubleDash && token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && isPosixShellOptionToken(token, supportsPlusOptions)) {
      const flag = normalizeOptionFlag(token);
      if (POSIX_SHELL_OPTIONS_WITH_VALUE.has(flag)) {
        if (!token.includes("=")) {
          i += 1;
        }
        continue;
      }
      i += advancePosixInlineOptionScan(token) - 1;
      continue;
    }
    return i;
  }
  return null;
}

export function hasPosixShellCodeLoadingOption(argv: string[], executable: string): boolean {
  if (!POSIX_SHELL_WRAPPERS.has(executable)) {
    return false;
  }
  const supportsPlusOptions = POSIX_SHELLS_WITH_PLUS_OPTIONS.has(executable);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (token === "--" || !isPosixShellOptionToken(token, supportsPlusOptions)) {
      return false;
    }
    if (POSIX_SHELL_CODE_LOADING_OPTIONS.has(normalizeOptionFlag(token))) {
      return true;
    }
    if (isPosixShellStdinOption(token)) {
      return true;
    }
    if (
      token === "--interactive" ||
      token === "-i" ||
      (/^-[^-]*i/u.test(token) && !token.includes("="))
    ) {
      return true;
    }
    i += advancePosixInlineOptionScan(token) - 1;
  }
  return false;
}

export function hasPosixShellStartupEnvironment(params: {
  argv: string[];
  executable: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (!POSIX_SHELL_WRAPPERS.has(params.executable)) {
    return false;
  }
  if (params.env?.BASH_ENV?.trim() || params.env?.ENV?.trim()) {
    return true;
  }
  return params.argv.some((token) => /^(?:BASH_ENV|ENV)=/u.test(token.trim()));
}
