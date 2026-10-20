import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { readDarwinProcessCensus } from "../darwin-process-inspection.js";

export type ProcessCommand =
  | {
      argv: string[];
      executable?: string;
      serviceMarker?: string;
      uid?: number;
      owner?: "same" | "different" | "unknown";
    }
  | { argvUnavailable: true; uid: number; owner?: "same" | "different" | "unknown" }
  | { argvUnavailable: true; uid?: never; owner: "different" };

type GroupMember = {
  pid: number;
  ppid?: number;
  pgid: number;
  state: string;
  command?: { ppid: number } & ProcessCommand;
};

/** Reject a known unsupported legacy contract before launching application work. */
export function assertProcessGroupControl(): void {
  if (process.platform !== "linux") {
    return;
  }
  try {
    process.kill(0, 0);
  } catch (cause) {
    throw new Error(
      "Process-group ownership is unavailable; use a matching Node host and worker with native process ownership. Cleanup cannot fall back to transport-only execution.",
      { cause },
    );
  }
}

function readLinuxProcessUid(pid: number): number | undefined {
  try {
    const lines = readFileSync(`/proc/${pid}/status`, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("Uid:"));
    const fields =
      lines.length === 1
        ? /^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*$/.exec(lines[0]!)
        : null;
    const ids = fields?.slice(1).map(Number);
    const inspectorUid = process.getuid?.();
    // Any matching credential UID denotes our account; otherwise retain the real UID.
    return ids?.every((uid) => Number.isSafeInteger(uid) && uid <= 0xffff_ffff)
      ? (ids.find((uid) => uid === inspectorUid) ?? ids[0])
      : undefined;
  } catch {
    return undefined;
  }
}

/** Only kernel absence, observed outside the owned group, confirms extinction. */
export function isOwnedProcessGroupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    const code = extractErrorCode(error);
    if (code === "ESRCH") {
      return true;
    }
    if (code === "EPERM") {
      return false;
    }
    throw error;
  }
}

/** Stop in-group descendants without killing the anchor that observes their lineage. */
export function killOwnedProcessGroupMembers(): void {
  for (const { pid, pgid } of readProcessGroupMembers(1_000)) {
    if (pid === process.pid || pgid !== process.pid) {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (extractErrorCode(error) !== "ESRCH") {
        throw error;
      }
    }
  }
}

/** The caller supplies command inspection; group cleanup only reads native topology. */
export function* readProcessGroupMembers(
  timeoutMs: number,
  commandInspection?: {
    readDarwinCommand: (
      pid: number,
      owner: "same" | "different" | "unknown",
    ) => ProcessCommand | undefined;
  },
): Generator<GroupMember> {
  const includeCommand = commandInspection !== undefined;
  if (process.platform === "linux") {
    const deadline = Date.now() + timeoutMs;
    for (const name of readdirSync("/proc")) {
      if (Date.now() >= deadline) {
        throw new Error("Process group census exceeded its deadline");
      }
      if (!/^\d+$/.test(name)) {
        continue;
      }
      const pid = Number(name);
      let stat: string;
      let argv: string[] | undefined;
      let uid: number | undefined;
      let opaqueForeignOwner = false;
      try {
        stat = readFileSync(`/proc/${name}/stat`, "utf8");
        if (includeCommand) {
          uid = readLinuxProcessUid(pid);
          try {
            argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
          } catch (error) {
            const inspectorUid = process.getuid?.();
            opaqueForeignOwner =
              uid !== undefined &&
              inspectorUid !== undefined &&
              uid !== inspectorUid &&
              ["EACCES", "EPERM"].includes(extractErrorCode(error) ?? "");
            if (!opaqueForeignOwner) {
              throw error;
            }
          }
        }
      } catch (error) {
        // Foreign processes may disappear between enumeration and their stat read.
        if (pid !== process.pid && ["ENOENT", "ESRCH"].includes(extractErrorCode(error) ?? "")) {
          continue;
        }
        throw new Error(
          `Could not classify PID ${pid}: process command inspection failed (${extractErrorCode(error) ?? "unavailable"}).`,
          { cause: error },
        );
      }
      // comm can contain spaces, newlines and parentheses; pgrp follows PPID
      // after its final closing parenthesis (Linux procfs stat fields 1..5).
      const match = /^(\d+) \([\s\S]*\) (\S) (\d+) (\d+)(?:\s|$)/.exec(stat);
      if (!match || Number(match[1]) !== pid || Date.now() >= deadline) {
        throw new Error("Process group census is unavailable");
      }
      if (argv?.length === 0) {
        // Empty cmdline is normal for kernel threads, but cannot identify a live
        // userspace process (including a zombie leader with surviving threads).
        const flags = Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[6]);
        const kernelThread = Number.isInteger(flags) && (flags & 0x0020_0000) !== 0;
        if (!kernelThread && !isPidDefinitelyDead(pid)) {
          const inspectorUid = process.getuid?.();
          if (uid !== undefined && inspectorUid !== undefined && uid !== inspectorUid) {
            opaqueForeignOwner = true;
            argv = undefined;
          } else {
            throw new Error(
              `Could not classify PID ${pid}: live userspace process has no readable arguments.`,
            );
          }
        }
      }
      yield {
        pid,
        pgid: Number(match[4]),
        state: match[2]!,
        ...(argv
          ? { command: { ppid: Number(match[3]), argv, ...(uid === undefined ? {} : { uid }) } }
          : opaqueForeignOwner && uid !== undefined
            ? { command: { ppid: Number(match[3]), argvUnavailable: true, uid } }
            : {}),
      };
    }
    if (Date.now() >= deadline) {
      throw new Error("Process group census exceeded its deadline");
    }
    return;
  }
  if (process.platform === "darwin") {
    for (const member of readDarwinProcessCensus(timeoutMs)) {
      const row = { pid: member.pid, pgid: member.pgid, state: member.state };
      let command: ProcessCommand | undefined;
      try {
        command = includeCommand
          ? member.state.startsWith("Z") || member.pid === 0
            ? { argv: [] }
            : commandInspection?.readDarwinCommand(member.pid, member.owner)
          : undefined;
      } catch (error) {
        if (!(error instanceof ProcSafeError) || error.code !== "incomplete") {
          throw error;
        }
        // Preserve unknown custody for this PID without dropping later observations.
        yield { ...row, ppid: member.ppid };
        continue;
      }
      if (includeCommand && !command) {
        continue;
      }
      yield {
        ...row,
        ...(command ? { command: { ppid: member.ppid, owner: member.owner, ...command } } : {}),
      };
    }
    return;
  }
  if (includeCommand) {
    throw new Error(`Exact process command census is unavailable on ${process.platform}.`);
  }
  const deadline = Date.now() + timeoutMs;
  const census = spawnSync("/bin/ps", ["-A", "-o", "pid=,pgid=,stat="], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (census.error || census.status !== 0) {
    throw new Error("Process group census is unavailable");
  }
  for (const line of census.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) {
      throw new Error("Process group census is unavailable");
    }
    const pid = Number(match[1]);
    if (pid !== census.pid) {
      yield { pid, pgid: Number(match[2]), state: match[3]! };
    }
  }
  if (includeCommand && Date.now() >= deadline) {
    throw new Error("Process group census exceeded its deadline");
  }
}

/** Advisory retirement timing only; the host owns kernel group-disappearance proof. */
export function hasLiveOwnedProcessGroupMembers(timeoutMs = 1_000): boolean | undefined {
  let observedOwner = false;
  try {
    for (const { pid, pgid, state } of readProcessGroupMembers(
      Math.max(1, Math.min(1_000, timeoutMs)),
    )) {
      if (pid === process.pid) {
        if (pgid !== process.pid) {
          return undefined;
        }
        observedOwner = true;
      } else if (
        pgid === process.pid &&
        // A zombie leader may retain live Linux threads; share the existing check.
        (!state.startsWith("Z") || (process.platform === "linux" && !isPidDefinitelyDead(pid)))
      ) {
        return true;
      }
    }
  } catch {
    return undefined;
  }
  return observedOwner ? false : undefined;
}
