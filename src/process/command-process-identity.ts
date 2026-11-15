import fs from "node:fs/promises";
import { getProcessInstanceStartTime, parseLinuxProcessStat } from "../shared/pid-alive.js";

/** Read recorded custody birth identity without synchronous Linux procfs I/O. */
export function readCommandProcessStartTime(pid: number): number | null | Promise<number | null> {
  if (process.platform !== "linux" && process.platform !== "android") {
    return getProcessInstanceStartTime(pid);
  }
  return fs.readFile(`/proc/${pid}/stat`, "utf8").then(
    (stat) => parseLinuxProcessStat(pid, stat)?.startedAt ?? null,
    () => null,
  );
}
