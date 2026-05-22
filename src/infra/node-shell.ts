// Builds platform shell argv for Node-driven command execution.
import fs from "node:fs";
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

export type NodeShellFilesystem = Pick<typeof fs, "existsSync">;

export function resolveNodeShellCommand(
  argv: string[],
  filesystem: NodeShellFilesystem = fs,
): { argv: string[]; changed: boolean } {
  if (argv[0] !== "/bin/sh") {
    return { argv, changed: false };
  }
  if (filesystem.existsSync("/bin/sh") || !filesystem.existsSync("/usr/bin/sh")) {
    return { argv, changed: false };
  }
  return {
    argv: ["/usr/bin/sh", ...argv.slice(1)],
    changed: true,
  };
}

export type NodeExecCwdFilesystem = Pick<typeof fs, "statSync">;

// A working directory forwarded to a node host can be absent on that host — for
// example a gateway container path (the gateway defaults an unspecified node
// workdir to its own `process.cwd()`) forwarded to a headless Linux node. Node
// fails the pre-exec `chdir` into a missing cwd and surfaces it as a misleading
// `spawn <shell> ENOENT`, even though the shell itself exists. Dropping a cwd
// that does not resolve to a directory on the node lets execution fall back to
// the node's default working directory instead of failing with an error that
// blames the wrong thing.
/** Drop a node exec cwd that does not exist (or is not a directory) on the node host. */
export function resolveNodeExecCwd(
  cwd: string | undefined,
  filesystem: NodeExecCwdFilesystem = fs,
): { cwd: string | undefined; changed: boolean } {
  if (!cwd) {
    return { cwd, changed: false };
  }
  try {
    if (filesystem.statSync(cwd).isDirectory()) {
      return { cwd, changed: false };
    }
  } catch {
    // Missing or unstatable cwd: fall through and drop it.
  }
  return { cwd: undefined, changed: true };
}
