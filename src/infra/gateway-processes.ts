import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { isGatewayArgv, parseProcCmdline } from "./gateway-process-argv.js";
import { findGatewayPidsOnPortSync as findUnixGatewayPidsOnPortSync } from "./restart-stale-pids.js";
import {
  readWindowsListeningPidsOnPortSync,
  readWindowsProcessArgsSync,
} from "./windows-port-pids.js";

/** Read process argv for Gateway identity checks across supported host OSes. */
export function readGatewayProcessArgsSync(pid: number): string[] | null {
  if (process.platform === "linux") {
    try {
      return parseProcCmdline(fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
    });
    if (ps.error || ps.status !== 0) {
      return null;
    }
    const command = ps.stdout.trim();
    // macOS `ps -o command=` is shell-like text, not argv-safe. It is only used
    // for Gateway identity heuristics before signaling, never for re-execution.
    return command ? command.split(/\s+/) : null;
  }
  if (process.platform === "win32") {
    return readWindowsProcessArgsSync(pid);
  }
  return null;
}

/**
 * Signal a process only after its argv matches a Gateway command. This keeps
 * stale-port cleanup from terminating unrelated listeners that reused the port.
 */
export function signalVerifiedGatewayPidSync(pid: number, signal: "SIGTERM" | "SIGUSR1"): void {
  const args = readGatewayProcessArgsSync(pid);
  if (!args || !isGatewayArgv(args, { allowGatewayBinary: true })) {
    throw new Error(`refusing to signal non-gateway process pid ${pid}`);
  }
  process.kill(pid, signal);
}

/**
 * Find listening PIDs on a Gateway port and keep only verified Gateway processes,
 * excluding the current process and duplicate listener rows.
 */
export function findVerifiedGatewayListenerPidsOnPortSync(port: number): number[] {
  const rawPids =
    process.platform === "win32"
      ? readWindowsListeningPidsOnPortSync(port)
      : findUnixGatewayPidsOnPortSync(port);

  return uniqueValues(rawPids)
    .filter((pid): pid is number => Number.isFinite(pid) && pid > 0 && pid !== process.pid)
    .filter((pid) => {
      const args = readGatewayProcessArgsSync(pid);
      return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
    });
}

/** Format verified Gateway PIDs for CLI/status messages. */
export function formatGatewayPidList(pids: number[]): string {
  return pids.join(", ");
}
