import path from "node:path";

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

function basenameLower(token: string): string {
  const win = path.win32.basename(token);
  const posix = path.posix.basename(token);
  const base = win.length < posix.length ? win : posix;
  return base.trim().toLowerCase();
}

const POSIX_SHELL_WRAPPERS = new Set(["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"]);
const WINDOWS_CMD_WRAPPERS = new Set(["cmd.exe", "cmd"]);
const POWERSHELL_WRAPPERS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const ENV_OPTIONS_WITH_VALUE = new Set([
  "-u",
  "--unset",
  "-c",
  "--chdir",
  "-s",
  "--split-string",
  "--default-signal",
  "--ignore-signal",
  "--block-signal",
]);
const ENV_FLAG_OPTIONS = new Set(["-i", "--ignore-environment", "-0", "--null"]);

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function unwrapEnvInvocation(argv: string[]): string[] | null {
  let idx = 1;
  let expectsOptionValue = false;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (expectsOptionValue) {
      expectsOptionValue = false;
      idx += 1;
      continue;
    }
    if (token === "--" || token === "-") {
      idx += 1;
      break;
    }
    if (isEnvAssignment(token)) {
      idx += 1;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const lower = token.toLowerCase();
      const [flag] = lower.split("=", 2);
      if (ENV_FLAG_OPTIONS.has(flag)) {
        idx += 1;
        continue;
      }
      if (ENV_OPTIONS_WITH_VALUE.has(flag)) {
        if (!lower.includes("=")) {
          expectsOptionValue = true;
        }
        idx += 1;
        continue;
      }
      if (
        lower.startsWith("-u") ||
        lower.startsWith("-c") ||
        lower.startsWith("-s") ||
        lower.startsWith("--unset=") ||
        lower.startsWith("--chdir=") ||
        lower.startsWith("--split-string=") ||
        lower.startsWith("--default-signal=") ||
        lower.startsWith("--ignore-signal=") ||
        lower.startsWith("--block-signal=")
      ) {
        idx += 1;
        continue;
      }
      return null;
    }
    break;
  }
  return idx < argv.length ? argv.slice(idx) : null;
}

function extractPosixShellInlineCommand(argv: string[]): string | null {
  const flag = argv[1]?.trim();
  if (!flag) {
    return null;
  }
  const lower = flag.toLowerCase();
  if (lower !== "-lc" && lower !== "-c" && lower !== "--command") {
    return null;
  }
  const cmd = argv[2]?.trim();
  return cmd ? cmd : null;
}

function extractCmdInlineCommand(argv: string[]): string | null {
  const idx = argv.findIndex((item) => String(item).trim().toLowerCase() === "/c");
  if (idx === -1) {
    return null;
  }
  const tail = argv.slice(idx + 1).map((item) => String(item));
  if (tail.length === 0) {
    return null;
  }
  const cmd = tail.join(" ").trim();
  return cmd.length > 0 ? cmd : null;
}

function extractPowerShellInlineCommand(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim();
    if (!token) {
      continue;
    }
    const lower = token.toLowerCase();
    if (lower === "--") {
      break;
    }
    if (lower === "-c" || lower === "-command" || lower === "--command") {
      const cmd = argv[i + 1]?.trim();
      return cmd ? cmd : null;
    }
  }
  return null;
}

function extractShellCommandFromArgvInternal(argv: string[], depth: number): string | null {
  if (depth >= 4) {
    return null;
  }
  const token0 = argv[0]?.trim();
  if (!token0) {
    return null;
  }

  const base0 = basenameLower(token0);
  if (base0 === "env") {
    const unwrapped = unwrapEnvInvocation(argv);
    if (!unwrapped) {
      return null;
    }
    return extractShellCommandFromArgvInternal(unwrapped, depth + 1);
  }
  if (POSIX_SHELL_WRAPPERS.has(base0)) {
    return extractPosixShellInlineCommand(argv);
  }
  if (WINDOWS_CMD_WRAPPERS.has(base0)) {
    return extractCmdInlineCommand(argv);
  }
  if (POWERSHELL_WRAPPERS.has(base0)) {
    return extractPowerShellInlineCommand(argv);
  }
  return null;
}

export function formatExecCommand(argv: string[]): string {
  return argv
    .map((arg) => {
      const trimmed = arg.trim();
      if (!trimmed) {
        return '""';
      }
      const needsQuotes = /\s|"/.test(trimmed);
      if (!needsQuotes) {
        return trimmed;
      }
      return `"${trimmed.replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

export function extractShellCommandFromArgv(argv: string[]): string | null {
  return extractShellCommandFromArgvInternal(argv, 0);
}

export function validateSystemRunCommandConsistency(params: {
  argv: string[];
  rawCommand?: string | null;
}): SystemRunCommandValidation {
  const raw =
    typeof params.rawCommand === "string" && params.rawCommand.trim().length > 0
      ? params.rawCommand.trim()
      : null;
  const shellCommand = extractShellCommandFromArgv(params.argv);
  const inferred = shellCommand !== null ? shellCommand.trim() : formatExecCommand(params.argv);

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
    // For direct argv execution, rawCommand is purely display/approval text and
    // must match the formatted argv.
    shellCommand: shellCommand !== null ? (raw ?? shellCommand) : null,
    cmdText: raw ?? shellCommand ?? inferred,
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
