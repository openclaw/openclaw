import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Node shell command construction keeps platform shell flags centralized for
// system.run and related command execution paths.
/** Build node transport argv, retaining the platform shell for shell syntax. */
export function buildNodeShellCommand(command: string, platform?: string | null) {
  const normalized = normalizeLowercaseStringOrEmpty((platform ?? "").trim());
  if (normalized.startsWith("win")) {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  if (normalized === "darwin" || normalized.startsWith("macos")) {
    // Only unwrap the direct interpreter/file shape that protected shell preparation
    // cannot admit. Keep working native commands on their shipped approval identity.
    const literal = command.match(
      /^\/(?:[A-Za-z0-9_.-]+\/)*(?:node|nodejs|python(?:\d+(?:\.\d+)*)?|perl|php|ruby) \/[A-Za-z0-9_./-]+(?: [A-Za-z0-9_./:=,@%+-]+)*$/u,
    )?.[0];
    if (literal === command) {
      return command.split(" ");
    }
    // Mac commands requiring a shell use non-login sh.
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
