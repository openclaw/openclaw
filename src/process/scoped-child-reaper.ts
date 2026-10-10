import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Real ChildProcess objects and looser transport-facing handles both fit this
// shape; optional exit fields use the same != null exited check as callers.
type TrackedChild = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  once: (event: "exit", listener: () => void) => unknown;
};
type WaitPid = (pid: number, status: null, options: number) => number;
type GroupMember = { pid: number; ppid: number; state: string };
/** Procfs identity (`<bootId>:<startTicks>`) guarding retained PIDs against reuse. */
export type AdoptedChildIdentity = { pid: number; startedAt: string };

const require = createRequire(import.meta.url);
const scheduledChildren = new WeakSet<TrackedChild>();
const identityScheduledChildren = new WeakSet<TrackedChild>();
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

function retainAdoptedCleanup(rootPid: number, cleanupTimeoutMs: number): void {
  const wait = loadWaitPid();
  if (!wait) {
    return;
  }
  const deadline = performance.now() + Math.max(CLEANUP_DEADLINE_MS, cleanupTimeoutMs);
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
  cleanupTimeoutMs = CLEANUP_DEADLINE_MS,
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
  const start = () => retainAdoptedCleanup(rootPid, cleanupTimeoutMs);
  if (child.exitCode != null || child.signalCode != null) {
    start();
  } else {
    child.once("exit", start);
  }
}

let linuxBootId: string | undefined;

function readLinuxBootId(): string | undefined {
  if (linuxBootId !== undefined) {
    return linuxBootId;
  }
  try {
    linuxBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    // Without a boot identity, retained PIDs cannot be revalidated safely.
    return undefined;
  }
  return linuxBootId;
}

function readStatIdentity(pid: number): (GroupMember & { startedAt: string }) | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    // A reaped or reused PID no longer matches the retained identity.
    return undefined;
  }
  const commEnd = stat.lastIndexOf(")");
  const fields = stat.slice(commEnd + 2).split(" ");
  const bootId = readLinuxBootId();
  const startTicks = fields[19];
  if (commEnd < 0 || bootId === undefined || !/^\d+$/u.test(startTicks ?? "")) {
    return undefined;
  }
  return {
    pid,
    ppid: Number(fields[1]),
    state: fields[0]!,
    startedAt: `${bootId}:${startTicks}`,
  };
}

function retainAdoptedIdentityCleanup(
  identities: Map<number, string>,
  cleanupTimeoutMs: number,
): void {
  const wait = loadWaitPid();
  if (!wait || readLinuxBootId() === undefined) {
    return;
  }
  const deadline = performance.now() + Math.max(CLEANUP_DEADLINE_MS, cleanupTimeoutMs);
  let quietScans = 0;
  const tick = () => {
    if (performance.now() >= deadline || identities.size === 0) {
      return;
    }
    let remaining = false;
    for (const [pid, startedAt] of identities) {
      const stat = readStatIdentity(pid);
      if (!stat || stat.startedAt !== startedAt) {
        identities.delete(pid);
        continue;
      }
      // Only a zombie parented to this process belongs to this native wait
      // owner. Live or foreign-parented descendants may still be adopted
      // later, so they stay retained within the cleanup deadline.
      if (
        stat.state.startsWith("Z") &&
        stat.ppid === process.pid &&
        wait(pid, null, WNOHANG) === pid
      ) {
        continue;
      }
      remaining = true;
    }
    quietScans = remaining ? 0 : quietScans + 1;
    if (quietScans < 2) {
      setTimeout(tick, POLL_INTERVAL_MS).unref();
    }
  };
  setTimeout(tick, POLL_INTERVAL_MS).unref();
}

/**
 * Reap exact adopted descendants after the tracked root exits, for owners whose
 * descendants may not share the root's process group.
 */
export function scheduleAdoptedDescendantReapAfterRootExit(
  child: TrackedChild,
  identities: readonly AdoptedChildIdentity[],
  cleanupTimeoutMs = CLEANUP_DEADLINE_MS,
): void {
  if (
    process.platform !== "linux" ||
    child.pid === undefined ||
    identityScheduledChildren.has(child)
  ) {
    return;
  }
  const retained = new Map<number, string>();
  for (const identity of identities) {
    if (
      Number.isSafeInteger(identity.pid) &&
      identity.pid > 0 &&
      identity.pid !== child.pid &&
      identity.startedAt
    ) {
      retained.set(identity.pid, identity.startedAt);
    }
  }
  if (retained.size === 0) {
    return;
  }
  identityScheduledChildren.add(child);
  const start = () => retainAdoptedIdentityCleanup(retained, cleanupTimeoutMs);
  if (child.exitCode != null || child.signalCode != null) {
    start();
  } else {
    child.once("exit", start);
  }
}
