import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

type TrackedChild = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">;
type WaitPid = (pid: number, status: null, options: number) => number;
type GroupMember = { pid: number; ppid: number; state: string };

const require = createRequire(import.meta.url);
const scheduledChildren = new WeakSet<TrackedChild>();
const POLL_INTERVAL_MS = 25;
const CLEANUP_DEADLINE_MS = 30_000;
const WNOHANG = 1;
let waitPid: WaitPid | null | undefined;

function loadWaitPid(): WaitPid | null {
  if (waitPid !== undefined) {
    return waitPid;
  }
  try {
    // SAFETY: Koffi's require export matches its typed default export.
    const koffi = require("koffi") as typeof import("koffi").default;
    // Linux waitpid accepts a null status pointer when only reaping is required.
    waitPid = koffi.load(null).func("int waitpid(int pid, int *status, int options)");
  } catch {
    // Native cleanup is best effort; loading it must not interrupt tree termination.
    waitPid = null;
  }
  return waitPid;
}

function readGroupMembers(groupId: number): GroupMember[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const members: GroupMember[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      // A process can disappear between the directory listing and this read.
      continue;
    }
    // A comm value may contain spaces or parentheses; fields follow its last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === groupId) {
      members.push({ pid: Number(entry), ppid: Number(fields[1]), state: fields[0]! });
    }
  }
  return members;
}

function retainAdoptedCleanup(rootPid: number): void {
  const wait = loadWaitPid();
  if (!wait) {
    return;
  }
  const deadline = performance.now() + CLEANUP_DEADLINE_MS;
  let quietScans = 0;
  const tick = () => {
    if (performance.now() >= deadline) {
      return;
    }
    let remaining = false;
    for (const member of readGroupMembers(rootPid)) {
      // libuv owns the tracked root's status. Only adopted direct-child zombies
      // in this terminated process group belong to this native wait owner.
      if (member.pid === rootPid) {
        continue;
      }
      if (
        member.ppid === process.pid &&
        member.state === "Z" &&
        wait(member.pid, null, WNOHANG) === member.pid
      ) {
        continue;
      }
      remaining = true;
    }
    quietScans = remaining ? 0 : quietScans + 1;
    if (quietScans < 2) {
      schedule();
    }
  };
  const schedule = () => {
    // Live intermediates can adopt children after root exit. Pace that drain
    // without making cleanup keep an otherwise idle host alive.
    setTimeout(tick, POLL_INTERVAL_MS).unref();
  };
  schedule();
}

/** Retain only the terminated group's adopted children after libuv consumes root exit. */
export function scheduleAdoptedChildZombieReapAfterExit(
  child: TrackedChild,
  usedProcessGroup: boolean,
): void {
  if (
    process.platform !== "linux" ||
    !usedProcessGroup ||
    child.pid === undefined ||
    scheduledChildren.has(child)
  ) {
    return;
  }
  const rootPid = child.pid;
  scheduledChildren.add(child);
  const start = () => retainAdoptedCleanup(rootPid);
  if (child.exitCode !== null || child.signalCode !== null) {
    start();
  } else {
    child.once("exit", start);
  }
}
