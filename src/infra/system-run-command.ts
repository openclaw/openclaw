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

function basenameLower(token: string): string {
  const win = path.win32.basename(token);
  const posix = path.posix.basename(token);
  const base = win.length < posix.length ? win : posix;
  return base.trim().toLowerCase();
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
  const token0 = argv[0]?.trim();
  if (!token0) {
    return null;
  }

  const base0 = basenameLower(token0);

  // POSIX-style shells: sh -lc "<cmd>"
  if (
    base0 === "sh" ||
    base0 === "bash" ||
    base0 === "zsh" ||
    base0 === "dash" ||
    base0 === "ksh"
  ) {
    const flag = argv[1]?.trim();
    if (flag !== "-lc" && flag !== "-c") {
      return null;
    }
    const cmd = argv[2];
    return typeof cmd === "string" ? cmd : null;
  }

  // Windows cmd.exe: cmd.exe /d /s /c "<cmd>"
  if (base0 === "cmd.exe" || base0 === "cmd") {
    const idx = argv.findIndex((item) => String(item).trim().toLowerCase() === "/c");
    if (idx === -1) {
      return null;
    }
    const cmd = argv[idx + 1];
    return typeof cmd === "string" ? cmd : null;
  }

  return null;
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
  const inferred = shellCommand ? shellCommand.trim() : formatExecCommand(params.argv);

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
    shellCommand: shellCommand ? (raw ?? shellCommand) : null,
    cmdText: raw ?? shellCommand ?? inferred,
  };
}
