import fs from "node:fs";
import { getProcessStartTime } from "../shared/pid-alive.js";
import type { CoordinatorFamily } from "./state-database-coordinator-paths.js";

export type StateDatabaseCoordinatorOwner = {
  pid: number;
  startTime: number;
  command: string;
  family: CoordinatorFamily;
};

/** Diagnostic snapshot only: never open/close the lock file or use this to grant authority. */
export function readStateDatabaseCoordinatorOwner(
  pathname: string,
  family: CoordinatorFamily,
): StateDatabaseCoordinatorOwner | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const { dev, ino } = fs.statSync(pathname, { bigint: true });
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
    const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
    for (const line of fs.readFileSync("/proc/locks", "utf8").split("\n")) {
      // Waiting entries contain "->"; only an installed POSIX lock names a holder.
      const match =
        /^\d+:\s+POSIX\s+ADVISORY\s+(?:READ|WRITE)\s+(\d+)\s+([\da-f]+):([\da-f]+):(\d+)\s/iu.exec(
          line,
        );
      if (
        !match ||
        BigInt(`0x${match[2]}`) !== major ||
        BigInt(`0x${match[3]}`) !== minor ||
        BigInt(match[4]!) !== ino
      ) {
        continue;
      }
      const pid = Number(match[1]);
      const startTime = getProcessStartTime(pid);
      const command = fs
        .readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0", 1)[0]
        ?.slice(0, 160);
      if (pid > 0 && startTime !== null && command && getProcessStartTime(pid) === startTime) {
        return { pid, startTime, command, family };
      }
    }
  } catch {
    // A holder may exit during observation; procfs may also be unavailable.
  }
  return undefined;
}
