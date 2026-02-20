import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

type LoggerLike = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type CgroupCleanupOps = {
  platform: NodeJS.Platform;
  pid: number;
  readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
};

type CgroupCleanupResult = {
  skipped?: string;
  cgroupPath?: string;
  scanned: number;
  orphaned: number;
  terminated: number;
  killed: number;
};

const PROC_CGROUP_PATH = "/proc/self/cgroup";
const CGROUP_ROOT = "/sys/fs/cgroup";
const DEFAULT_GRACE_MS = 400;

const defaultOps: CgroupCleanupOps = {
  platform: process.platform,
  pid: process.pid,
  readFile: async (filePath, encoding) => await fs.readFile(filePath, encoding),
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: async (ms) => {
    await sleep(ms);
  },
};

function parseUnifiedCgroupPath(raw: string): string | null {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("0::")) {
      continue;
    }
    const cgroupPath = trimmed.slice(3).trim();
    if (!cgroupPath || cgroupPath === "/") {
      return null;
    }
    return cgroupPath;
  }
  return null;
}

async function readPidParent(ops: CgroupCleanupOps, pid: number): Promise<number | null> {
  try {
    const status = await ops.readFile(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^PPid:\s+(\d+)$/m);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function isDescendantOf(params: {
  ops: CgroupCleanupOps;
  pid: number;
  ancestorPid: number;
}): Promise<boolean> {
  const { ops, pid, ancestorPid } = params;
  let current = pid;
  for (let i = 0; i < 128; i += 1) {
    if (current === ancestorPid) {
      return true;
    }
    if (current <= 1) {
      return false;
    }
    const parent = await readPidParent(ops, current);
    if (parent === null || parent === current) {
      return false;
    }
    current = parent;
  }
  return false;
}

function isPidAlive(ops: CgroupCleanupOps, pid: number): boolean {
  try {
    ops.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function trySignal(ops: CgroupCleanupOps, pid: number, signal: NodeJS.Signals): boolean {
  try {
    ops.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupGatewayCgroupOrphans(params?: {
  logger?: LoggerLike;
  ops?: Partial<CgroupCleanupOps>;
  graceMs?: number;
}): Promise<CgroupCleanupResult> {
  const logger = params?.logger;
  const ops: CgroupCleanupOps = {
    ...defaultOps,
    ...params?.ops,
  };
  if (ops.platform !== "linux") {
    return { skipped: "unsupported-platform", scanned: 0, orphaned: 0, terminated: 0, killed: 0 };
  }

  const cgroupRaw = await ops.readFile(PROC_CGROUP_PATH, "utf8").catch(() => "");
  const cgroupPath = parseUnifiedCgroupPath(cgroupRaw);
  if (!cgroupPath) {
    return { skipped: "missing-cgroup-path", scanned: 0, orphaned: 0, terminated: 0, killed: 0 };
  }
  const cgroupProcsPath = path.posix.join(CGROUP_ROOT, cgroupPath, "cgroup.procs");
  const cgroupPidsRaw = await ops.readFile(cgroupProcsPath, "utf8").catch(() => "");
  if (!cgroupPidsRaw.trim()) {
    return {
      skipped: "empty-cgroup",
      cgroupPath,
      scanned: 0,
      orphaned: 0,
      terminated: 0,
      killed: 0,
    };
  }

  const cgroupPids = cgroupPidsRaw
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 1);

  const orphaned: number[] = [];
  for (const pid of cgroupPids) {
    if (pid === ops.pid) {
      continue;
    }
    if (await isDescendantOf({ ops, pid, ancestorPid: ops.pid })) {
      continue;
    }
    orphaned.push(pid);
  }

  let terminated = 0;
  for (const pid of orphaned) {
    if (trySignal(ops, pid, "SIGTERM")) {
      terminated += 1;
    }
  }

  if (orphaned.length > 0) {
    await ops.sleep(params?.graceMs ?? DEFAULT_GRACE_MS);
  }

  let killed = 0;
  for (const pid of orphaned) {
    if (!isPidAlive(ops, pid)) {
      continue;
    }
    if (trySignal(ops, pid, "SIGKILL")) {
      killed += 1;
    }
  }

  if (orphaned.length > 0) {
    logger?.info(
      `startup cgroup cleanup: orphaned=${orphaned.length} terminated=${terminated} killed=${killed} cgroup=${cgroupPath}`,
    );
  }

  return {
    cgroupPath,
    scanned: cgroupPids.length,
    orphaned: orphaned.length,
    terminated,
    killed,
  };
}
