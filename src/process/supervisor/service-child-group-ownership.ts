import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";

export type ProcessCommand =
  | { argv: string[] }
  | { argvUnavailable: true; executable: string; uid: number };

type GroupMember = {
  pid: number;
  pgid: number;
  state: string;
  command?: { ppid: number } & ProcessCommand;
};

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

/** The caller supplies native command inspection; the standalone group worker stays dependency-free. */
export function* readProcessGroupMembers(
  timeoutMs: number,
  commandInspection?: {
    readDarwinCommand: (pid: number, uid: number) => ProcessCommand | undefined;
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
      try {
        stat = readFileSync(`/proc/${name}/stat`, "utf8");
        if (includeCommand) {
          argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
        }
      } catch (error) {
        // Foreign processes may disappear between enumeration and their stat read.
        if (pid !== process.pid && ["ENOENT", "ESRCH"].includes(extractErrorCode(error) ?? "")) {
          continue;
        }
        throw error;
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
          throw new Error(`Cannot identify live process ${pid}`);
        }
      }
      yield {
        pid,
        pgid: Number(match[4]),
        state: match[2]!,
        ...(argv ? { command: { ppid: Number(match[3]), argv } } : {}),
      };
    }
    if (Date.now() >= deadline) {
      throw new Error("Process group census exceeded its deadline");
    }
    return;
  }
  if (includeCommand && process.platform !== "darwin") {
    throw new Error(`Exact process command census is unavailable on ${process.platform}.`);
  }
  const deadline = Date.now() + timeoutMs;
  const census = spawnSync(
    "/bin/ps",
    ["-A", "-o", includeCommand ? "pid=,pgid=,stat=,ppid=,uid=" : "pid=,pgid=,stat="],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (census.error || census.status !== 0) {
    throw new Error("Process group census is unavailable");
  }
  for (const line of census.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const match = includeCommand
      ? /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(-?\d+)\s*$/.exec(line)
      : /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) {
      throw new Error("Process group census is unavailable");
    }
    const pid = Number(match[1]);
    if (pid !== census.pid) {
      if (includeCommand && Date.now() >= deadline) {
        throw new Error("Process group census exceeded its deadline");
      }
      const command = includeCommand
        ? match[3]!.startsWith("Z") || pid === 0
          ? { argv: [] }
          : commandInspection?.readDarwinCommand(pid, Number(match[5]) >>> 0)
        : undefined;
      if (includeCommand && !command) {
        continue;
      }
      yield {
        pid,
        pgid: Number(match[2]),
        state: match[3]!,
        ...(command ? { command: { ppid: Number(match[4]), ...command } } : {}),
      };
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
