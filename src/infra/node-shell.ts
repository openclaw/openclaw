import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Node shell command construction keeps platform shell flags centralized for
// system.run and related command execution paths.
/** Build argv for running a command through the platform default shell. */
export function buildNodeShellCommand(command: string, platform?: string | null) {
  const normalized = normalizeLowercaseStringOrEmpty((platform ?? "").trim());
  if (normalized.startsWith("win")) {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  if (normalized === "darwin" || normalized.startsWith("macos")) {
    // The Mac node binds static allowlisted commands through non-login sh.
    // A login shell can execute unapproved startup files before the payload.
    return ["/bin/sh", "-c", command];
  }
  return ["/bin/sh", "-lc", command];
}

type ShellCommandLaunch = {
  argv: string[];
  windowsVerbatimArguments?: true;
};

/** Prepare a platform shell argv for spawning; Windows cmd.exe needs its command line verbatim. */
export function resolveShellCommandLaunch(argv: string[]): ShellCommandLaunch {
  if (process.platform !== "win32" || argv.length !== 5) {
    return { argv };
  }
  const [shell, noAutoRun, stripQuotes, runAndExit, command] = argv;
  if (
    shell === undefined ||
    command === undefined ||
    path.win32.basename(shell).toLowerCase() !== "cmd.exe" ||
    noAutoRun !== "/d" ||
    stripQuotes !== "/s" ||
    runAndExit !== "/c"
  ) {
    return { argv };
  }
  // cmd.exe /s strips the outer quotes; verbatim argv avoids Node's MSVCRT escaping.
  return {
    argv: [shell, noAutoRun, stripQuotes, runAndExit, `"${command}"`],
    windowsVerbatimArguments: true,
  };
}
