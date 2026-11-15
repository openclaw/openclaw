import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import {
  getFileLockProcessStartTime,
  getProcessInstanceStartTime,
  parseLinuxProcessStat,
} from "../shared/pid-alive.js";

/** Linux birth ticks are shared by lease and custody identities; Darwin's units differ. */
export function readCommandProcessStartTime(
  pid: number,
  options: {
    child?: Pick<ChildProcess, "exitCode" | "signalCode">;
    instance?: boolean;
  } = {},
): number | null | Promise<number | null> {
  if (process.platform !== "linux" && process.platform !== "android") {
    return options.instance ? getProcessInstanceStartTime(pid) : getFileLockProcessStartTime(pid);
  }
  return fs.readFile(`/proc/${pid}/stat`, "utf8").then(
    (stat) => {
      // A completed read may name a successor after libuv observed the original exit.
      if (options.child && (options.child.exitCode != null || options.child.signalCode != null)) {
        return null;
      }
      return parseLinuxProcessStat(pid, stat)?.startedAt ?? null;
    },
    () => null,
  );
}
