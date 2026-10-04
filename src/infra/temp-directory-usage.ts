import fs from "node:fs";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { hasErrnoCode } from "./errno.js";
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";

export type TemporaryDirectoryUsage =
  | { kind: "active" }
  | { kind: "inactive" }
  | { kind: "unknown"; reason: string };

/** Tokenless scratch needs both producer and open-file evidence before reclamation. */
export function inspectTemporaryDirectoryUsage(directory: string): TemporaryDirectoryUsage {
  if (process.platform === "linux") {
    try {
      const [mount, ...otherMounts] = fs
        .readFileSync("/proc/self/mountinfo", "utf8")
        .split("\n")
        .map((line) => line.split(" "))
        .filter((fields) => fields[4] === "/proc");
      const separator = mount?.indexOf("-") ?? -1;
      if (
        !mount ||
        otherMounts.length > 0 ||
        separator < 6 ||
        mount[separator + 1] !== "proc" ||
        !mount[5] ||
        !mount[separator + 3]
      ) {
        throw new Error("Procfs mount information is incomplete or ambiguous.");
      }
      // A visible current PID cannot establish completeness when procfs hides its peers.
      const options = `${mount[5]},${mount[separator + 3]}`.split(",");
      if (
        options.some(
          (option) =>
            option === "subset=pid" ||
            (option.startsWith("hidepid=") && option !== "hidepid=0" && option !== "hidepid=off"),
        )
      ) {
        return { kind: "unknown", reason: "restricted-procfs" };
      }
    } catch (error) {
      return { kind: "unknown", reason: `Could not inspect procfs visibility: ${String(error)}` };
    }
  }
  const census = inspectOtherOpenClawProcesses();
  if ("error" in census) {
    return { kind: "unknown", reason: census.error };
  }
  if (census.pids.length > 0) {
    return { kind: "active" };
  }
  if (process.platform !== "linux") {
    return { kind: "unknown", reason: `Open-file census is unavailable on ${process.platform}.` };
  }
  const contains = (target: string) => {
    const file = target.replace(/ \(deleted\)$/, "");
    return file === directory || file.startsWith(`${directory}/`);
  };
  const deadline = performance.now() + 1_000;
  const assertTime = () => {
    if (performance.now() >= deadline) {
      throw new Error("Open-file census exceeded its deadline.");
    }
  };
  try {
    const pids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
    if (!pids.includes(String(process.pid))) {
      throw new Error("Open-file census is incomplete.");
    }
    for (const pid of pids) {
      assertTime();
      try {
        // Include this process and foreign UIDs: argv identity does not prove file custody.
        for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
          assertTime();
          try {
            if (contains(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))) {
              return { kind: "active" };
            }
          } catch (error) {
            // An enumerated descriptor may close before readlink; other failures are unknown.
            if (!hasErrnoCode(error, "ENOENT")) {
              throw error;
            }
          }
        }
        const maps = fs.readFileSync(`/proc/${pid}/maps`, "utf8");
        for (const line of maps.split("\n")) {
          const file = /^\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+(\/.*)$/.exec(line)?.[1];
          if (
            file &&
            contains(
              file.replace(/\\([0-7]{3})/g, (_, octal: string) =>
                String.fromCharCode(Number.parseInt(octal, 8)),
              ),
            )
          ) {
            return { kind: "active" };
          }
        }
        try {
          if (contains(fs.readlinkSync(`/proc/${pid}/cwd`))) {
            return { kind: "active" };
          }
        } catch (error) {
          // Kernel threads have no cwd, descriptors, or mappings.
          const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
          const flags = Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[6]);
          if (!hasErrnoCode(error, "ENOENT") || (flags & 0x0020_0000) === 0) {
            throw error;
          }
        }
      } catch (error) {
        if (!isPidDefinitelyDead(Number(pid))) {
          throw error;
        }
      }
    }
    assertTime();
    return { kind: "inactive" };
  } catch (error) {
    return { kind: "unknown", reason: `Could not inspect open files: ${String(error)}` };
  }
}
