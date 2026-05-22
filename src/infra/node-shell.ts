// Builds platform shell argv for Node-driven command execution.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Node shell command construction keeps platform shell flags centralized for
// system.run and related command execution paths.
/** Build argv for running a command through the platform default shell. */
export function buildNodeShellCommand(command: string, platform?: string | null) {
  const normalized = normalizeLowercaseStringOrEmpty((platform ?? "").trim());
  if (normalized.startsWith("win")) {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  return ["/bin/sh", "-lc", command];
}

export function buildNodeShellFallbackCommands(argv: string[]): string[][] {
  const executable = argv[0];
  if (executable !== "/bin/sh") {
    return [];
  }
  return [["/usr/bin/sh", ...argv.slice(1)]];
}
