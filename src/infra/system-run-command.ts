import {
  extractShellWrapperCommand,
  hasEnvManipulationBeforeShellWrapper,
  normalizeExecutableToken,
  unwrapDispatchWrappersForResolution,
  unwrapKnownShellMultiplexerInvocation,
} from "./exec-wrapper-resolution.js";

export type SystemRunCommandValidation =
  | {
      ok: true;
      shellCommand: string | null;
      cmdText: string;
    }
  | {
      ok: false;
      message: string;
      details?: Record<string, unknown>;
    };

export type ResolvedSystemRunCommand =
  | {
      ok: true;
      argv: string[];
      rawCommand: string | null;
      shellCommand: string | null;
      cmdText: string;
    }
  | {
      ok: false;
      message: string;
      details?: Record<string, unknown>;
    };

export function formatExecCommand(argv: string[]): string {
  return argv
    .map((arg) => {
      if (arg.length === 0) {
        return '""';
      }
      const needsQuotes = /\s|"/.test(arg);
      if (!needsQuotes) {
        return arg;
      }
      return `"${arg.replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

export function extractShellCommandFromArgv(argv: string[]): string | null {
  return extractShellWrapperCommand(argv).command;
}

const POSIX_OR_POWERSHELL_INLINE_WRAPPER_NAMES = new Set([
  "ash",
  "bash",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);

const POSIX_INLINE_COMMAND_FLAGS = new Set(["-lc", "-c", "--command"]);
const POWERSHELL_INLINE_COMMAND_FLAGS = new Set(["-c", "-command", "--command"]);

function unwrapShellWrapperArgv(argv: string[]): string[] {
  const dispatchUnwrapped = unwrapDispatchWrappersForResolution(argv);
  const shellMultiplexer = unwrapKnownShellMultiplexerInvocation(dispatchUnwrapped);
  return shellMultiplexer.kind === "unwrapped" ? shellMultiplexer.argv : dispatchUnwrapped;
}

function resolveInlineCommandTokenIndex(
  argv: string[],
  flags: ReadonlySet<string>,
  options: { allowCombinedC?: boolean } = {},
): number | null {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim();
    if (!token) {
      continue;
    }
    const lower = token.toLowerCase();
    if (lower === "--") {
      break;
    }
    if (flags.has(lower)) {
      return i + 1 < argv.length ? i + 1 : null;
    }
    if (options.allowCombinedC && /^-[^-]*c[^-]*$/i.test(token)) {
      const commandIndex = lower.indexOf("c");
      const inline = token.slice(commandIndex + 1).trim();
      return inline ? i : i + 1 < argv.length ? i + 1 : null;
    }
  }
  return null;
}

function hasTrailingPositionalArgvAfterInlineCommand(argv: string[]): boolean {
  const wrapperArgv = unwrapShellWrapperArgv(argv);
  const token0 = wrapperArgv[0]?.trim();
  if (!token0) {
    return false;
  }

  const wrapper = normalizeExecutableToken(token0);
  if (!POSIX_OR_POWERSHELL_INLINE_WRAPPER_NAMES.has(wrapper)) {
    return false;
  }

  const inlineCommandIndex =
    wrapper === "powershell" || wrapper === "pwsh"
      ? resolveInlineCommandTokenIndex(wrapperArgv, POWERSHELL_INLINE_COMMAND_FLAGS)
      : resolveInlineCommandTokenIndex(wrapperArgv, POSIX_INLINE_COMMAND_FLAGS, {
          allowCombinedC: true,
        });
  if (inlineCommandIndex === null) {
    return false;
  }
  return wrapperArgv.slice(inlineCommandIndex + 1).some((entry) => entry.trim().length > 0);
}

export function validateSystemRunCommandConsistency(params: {
  argv: string[];
  rawCommand?: string | null;
}): SystemRunCommandValidation {
  const raw =
    typeof params.rawCommand === "string" && params.rawCommand.trim().length > 0
      ? params.rawCommand.trim()
      : null;
  const shellWrapperResolution = extractShellWrapperCommand(params.argv);
  const shellCommand = shellWrapperResolution.command;
  const shellWrapperPositionalArgv = hasTrailingPositionalArgvAfterInlineCommand(params.argv);
  const envManipulationBeforeShellWrapper =
    shellWrapperResolution.isWrapper && hasEnvManipulationBeforeShellWrapper(params.argv);
  const mustBindDisplayToFullArgv = envManipulationBeforeShellWrapper || shellWrapperPositionalArgv;
  const inferred =
    shellCommand !== null && !mustBindDisplayToFullArgv
      ? shellCommand.trim()
      : formatExecCommand(params.argv);

  if (raw && raw !== inferred) {
    return {
      ok: false,
      message: "INVALID_REQUEST: rawCommand does not match command",
      details: {
        code: "RAW_COMMAND_MISMATCH",
        rawCommand: raw,
        inferred,
      },
    };
  }

  return {
    ok: true,
    // Only treat this as a shell command when argv is a recognized shell wrapper.
    // For direct argv execution and shell wrappers with env prelude modifiers,
    // rawCommand is purely display/approval text and must match the formatted argv.
    shellCommand:
      shellCommand !== null
        ? envManipulationBeforeShellWrapper
          ? shellCommand
          : (raw ?? shellCommand)
        : null,
    cmdText: raw ?? inferred,
  };
}

export function resolveSystemRunCommand(params: {
  command?: unknown;
  rawCommand?: unknown;
}): ResolvedSystemRunCommand {
  const raw =
    typeof params.rawCommand === "string" && params.rawCommand.trim().length > 0
      ? params.rawCommand.trim()
      : null;
  const command = Array.isArray(params.command) ? params.command : [];
  if (command.length === 0) {
    if (raw) {
      return {
        ok: false,
        message: "rawCommand requires params.command",
        details: { code: "MISSING_COMMAND" },
      };
    }
    return {
      ok: true,
      argv: [],
      rawCommand: null,
      shellCommand: null,
      cmdText: "",
    };
  }

  const argv = command.map((v) => String(v));
  const validation = validateSystemRunCommandConsistency({
    argv,
    rawCommand: raw,
  });
  if (!validation.ok) {
    return {
      ok: false,
      message: validation.message,
      details: validation.details ?? { code: "RAW_COMMAND_MISMATCH" },
    };
  }

  return {
    ok: true,
    argv,
    rawCommand: raw,
    shellCommand: validation.shellCommand,
    cmdText: validation.cmdText,
  };
}
