import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";

type LinuxCredentialIds = readonly [number, number, number, number];

export type LinuxProcessGeneration = {
  startTicks: string;
  ppid: number;
  uids: LinuxCredentialIds;
  gids: LinuxCredentialIds;
};

export type ProcessCommand = (
  | { argv: string[]; serviceMarker?: string; uid?: number }
  | { argvUnavailable: true; uid: number }
) & { generation?: LinuxProcessGeneration };

function readBoundedProcFile(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(16_385);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) {
        return buffer.subarray(0, length).toString("utf8");
      }
      length += count;
    }
    throw new Error("Process identity exceeds its observation limit");
  } finally {
    closeSync(fd);
  }
}

/** Birth and every credential UID/GID bind optional cross-privilege cwd observations. */
export function readLinuxProcessGeneration(pid: number): LinuxProcessGeneration | undefined {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fff_ffff) {
    return undefined;
  }
  try {
    const stat = readBoundedProcFile(`/proc/${pid}/stat`);
    const status = readBoundedProcFile(`/proc/${pid}/status`);
    const closing = stat.lastIndexOf(")");
    if (!stat.startsWith(`${pid} (`) || closing < 0 || stat[closing + 1] !== " ") {
      return undefined;
    }
    const fields = stat
      .slice(closing + 2)
      .trim()
      .split(/\s+/u);
    const ppid = fields[1];
    const startTicks = fields[19];
    const ids = (field: "Uid" | "Gid"): LinuxCredentialIds | undefined => {
      const lines = status.split("\n").filter((line) => line.startsWith(`${field}:`));
      const match =
        lines.length === 1
          ? new RegExp(
              `^${field}:[ \\t]+(\\d+)[ \\t]+(\\d+)[ \\t]+(\\d+)[ \\t]+(\\d+)[ \\t]*$`,
            ).exec(lines[0]!)
          : null;
      if (!match) {
        return undefined;
      }
      const values = match.slice(1).map(Number);
      if (values.some((value) => !Number.isSafeInteger(value) || value > 0xffff_ffff)) {
        return undefined;
      }
      return [values[0]!, values[1]!, values[2]!, values[3]!];
    };
    const uids = ids("Uid");
    const gids = ids("Gid");
    if (
      !ppid ||
      !/^(0|[1-9]\d{0,9})$/u.test(ppid) ||
      Number(ppid) > 0x7fff_ffff ||
      !startTicks ||
      !/^[1-9]\d{0,19}$/u.test(startTicks) ||
      BigInt(startTicks) > 0xffff_ffff_ffff_ffffn ||
      !uids ||
      !gids
    ) {
      return undefined;
    }
    return { startTicks, ppid: Number(ppid), uids, gids };
  } catch {
    return undefined;
  }
}

export function linuxProcessGenerationMatches(
  left: LinuxProcessGeneration | undefined,
  right: LinuxProcessGeneration | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.startTicks === right.startTicks &&
    left.ppid === right.ppid &&
    left.uids.every((value, index) => value === right.uids[index]) &&
    left.gids.every((value, index) => value === right.gids[index]),
  );
}

/** A provider response must not join a pre-exec command to a post-exec cwd. */
export function readLinuxProcessCommandMetadata(
  pid: number,
  expected: LinuxProcessGeneration,
  inspectServiceMarker: boolean,
  deadline: number,
): ProcessCommand | undefined {
  if (Date.now() >= deadline) {
    return undefined;
  }
  try {
    const before = readLinuxProcessGeneration(pid);
    if (!linuxProcessGenerationMatches(expected, before)) {
      return undefined;
    }
    const argv = readBoundedProcFile(`/proc/${pid}/cmdline`).split("\0").filter(Boolean);
    const markerFields = inspectServiceMarker
      ? readBoundedProcFile(`/proc/${pid}/environ`)
          .split("\0")
          .filter((entry) => entry.startsWith("OPENCLAW_SERVICE_MARKER="))
      : [];
    if (
      markerFields.length > 1 ||
      Date.now() >= deadline ||
      !linuxProcessGenerationMatches(expected, readLinuxProcessGeneration(pid))
    ) {
      return undefined;
    }
    return {
      argv,
      uid: expected.uids.find((uid) => uid === process.getuid?.()) ?? expected.uids[0],
      generation: expected,
      ...(markerFields.length
        ? { serviceMarker: markerFields[0]!.slice("OPENCLAW_SERVICE_MARKER=".length) }
        : {}),
    };
  } catch {
    return undefined;
  }
}

type GroupMember = {
  pid: number;
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

/** The caller supplies native command inspection; the standalone group worker stays dependency-free. */
export function* readProcessGroupMembers(
  timeoutMs: number,
  commandInspection?: {
    readDarwinCommand: (pid: number, uid: number) => ProcessCommand | undefined;
    includeLinuxGeneration?: boolean;
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
      let generation: LinuxProcessGeneration | undefined;
      let opaqueForeignOwner = false;
      try {
        stat = readFileSync(`/proc/${name}/stat`, "utf8");
        if (includeCommand) {
          if (commandInspection?.includeLinuxGeneration) {
            generation = readLinuxProcessGeneration(pid);
          }
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
      if (commandInspection?.includeLinuxGeneration && uid === process.getuid?.() && !generation) {
        throw new Error(`Could not classify PID ${pid}: process generation is unavailable.`);
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
      if (
        generation &&
        (generation.startTicks !==
          stat
            .slice(stat.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/u)[19] ||
          generation.ppid !== Number(match[3]) ||
          uid !==
            (generation.uids.find((value) => value === process.getuid?.()) ?? generation.uids[0]) ||
          !linuxProcessGenerationMatches(generation, readLinuxProcessGeneration(pid)))
      ) {
        throw new Error(
          `Could not classify PID ${pid}: process generation changed during command inspection.`,
        );
      }
      yield {
        pid,
        pgid: Number(match[4]),
        state: match[2]!,
        ...(argv
          ? {
              command: {
                ppid: Number(match[3]),
                argv,
                ...(uid === undefined ? {} : { uid }),
                ...(generation ? { generation } : {}),
              },
            }
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
        ...(command
          ? { command: { ppid: Number(match[4]), ...command, uid: Number(match[5]) >>> 0 } }
          : {}),
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
