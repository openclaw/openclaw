/**
 * Tokenize a Windows-style command line string into an argv array, respecting
 * double-quoted segments.  Quotes are stripped (the content is preserved), so
 * the resulting strings can be passed directly to spawn() without any further
 * shell interpretation.
 *
 * This is intentionally minimal: it handles the common pattern of
 *   powershell.exe -NoProfile -Command "..."
 * well enough to bypass cmd.exe wrapping (#35807).  It does not attempt to
 * replicate the full Windows CommandLineToArgvW semantics (e.g. escaped quotes
 * inside quoted strings are not handled).
 */
function tokenizeWindowsCommandLine(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of cmd) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === " " && !inQuotes) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

/** Returns true when the first token of `command` is a PowerShell executable. */
function startsWithPowerShell(command: string): boolean {
  const firstToken = command.trimStart().split(/[\s"]/)[0] ?? "";
  const normalized = firstToken.toLowerCase().replace(/\.exe$/, "");
  return normalized === "powershell" || normalized === "pwsh";
}

export function buildNodeShellCommand(command: string, platform?: string | null) {
  const normalized = String(platform ?? "")
    .trim()
    .toLowerCase();
  if (normalized.startsWith("win")) {
    // When the agent explicitly invokes PowerShell, bypass cmd.exe entirely.
    // cmd.exe's /d /s /c processing mangles PowerShell-specific syntax:
    //   - $pipeline_var ($_ etc.) is interpreted as a cmd variable
    //   - | is treated as a cmd pipe, splitting the command unexpectedly
    //   - backticks and the -f format operator fail with parse errors
    // By tokenizing the command and spawning PowerShell directly we avoid all
    // of these issues while keeping the standard cmd.exe path for everything
    // else.  Fixes #35807.
    if (startsWithPowerShell(command)) {
      const argv = tokenizeWindowsCommandLine(command.trim());
      if (argv.length > 0) {
        return argv;
      }
    }
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  return ["/bin/sh", "-lc", command];
}
