import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

type LoggerLike = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

type ProcEntry = {
  pid: number;
  comm: string;
  args: string[];
};

type CrashpadGcOps = {
  platform: NodeJS.Platform;
  readdir: (filePath: string) => Promise<string[]>;
  readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
};

type CrashpadGcResult = {
  skipped?: string;
  scanned: number;
  profileChromium: number;
  profileCrashpad: number;
  terminated: number;
  killed: number;
};

const DEFAULT_GRACE_MS = 200;

const defaultOps: CrashpadGcOps = {
  platform: process.platform,
  readdir: async (filePath) => await fs.readdir(filePath),
  readFile: async (filePath, encoding) => await fs.readFile(filePath, encoding),
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: async (ms) => {
    await sleep(ms);
  },
};

function parseCmdline(raw: string): string[] {
  return raw
    .split("\u0000")
    .map((part) => part.trim())
    .filter(Boolean);
}

function findArgValue(args: string[], prefix: string): string | null {
  for (const arg of args) {
    if (!arg.startsWith(prefix)) {
      continue;
    }
    const value = arg.slice(prefix.length).trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function normalizeLinuxPath(filePath: string): string {
  return path.posix.normalize(filePath);
}

function listExpectedCrashDatabases(userDataDir: string): Set<string> {
  const normalized = normalizeLinuxPath(userDataDir);
  return new Set<string>([
    normalizeLinuxPath(path.posix.join(normalized, "Crash Reports")),
    normalizeLinuxPath(path.posix.join(normalized, "xdg-config", "chromium", "Crash Reports")),
    normalizeLinuxPath(path.posix.join(normalized, "xdg-config", "google-chrome", "Crash Reports")),
  ]);
}

function isChromiumLikeProcess(comm: string): boolean {
  const normalized = comm.trim().toLowerCase();
  return normalized.includes("chrom");
}

function isCrashpadProcess(comm: string): boolean {
  const normalized = comm.trim().toLowerCase();
  return normalized.includes("crashpad");
}

async function collectProcEntries(ops: CrashpadGcOps): Promise<ProcEntry[]> {
  const entries: ProcEntry[] = [];
  const pids = (await ops.readdir("/proc"))
    .map((entry) => Number.parseInt(entry, 10))
    .filter((pid) => Number.isFinite(pid) && pid > 1)
    .toSorted((a, b) => a - b);

  for (const pid of pids) {
    const [commRaw, cmdlineRaw] = await Promise.all([
      ops.readFile(`/proc/${pid}/comm`, "utf8").catch(() => ""),
      ops.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
    ]);
    const comm = commRaw.trim();
    if (!comm) {
      continue;
    }
    const args = parseCmdline(cmdlineRaw);
    entries.push({ pid, comm, args });
  }
  return entries;
}

function isAlive(ops: CrashpadGcOps, pid: number): boolean {
  try {
    ops.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function trySignal(ops: CrashpadGcOps, pid: number, signal: NodeJS.Signals): boolean {
  try {
    ops.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function reapStaleCrashpadHandlersForProfile(params: {
  userDataDir: string;
  logger?: LoggerLike;
  graceMs?: number;
  ops?: Partial<CrashpadGcOps>;
}): Promise<CrashpadGcResult> {
  const userDataDir = params.userDataDir.trim();
  if (!userDataDir) {
    return {
      skipped: "missing-user-data-dir",
      scanned: 0,
      profileChromium: 0,
      profileCrashpad: 0,
      terminated: 0,
      killed: 0,
    };
  }

  const logger = params.logger;
  const ops: CrashpadGcOps = {
    ...defaultOps,
    ...params.ops,
  };

  if (ops.platform !== "linux") {
    return {
      skipped: "unsupported-platform",
      scanned: 0,
      profileChromium: 0,
      profileCrashpad: 0,
      terminated: 0,
      killed: 0,
    };
  }

  const normalizedUserDataDir = normalizeLinuxPath(userDataDir);
  const expectedCrashDatabases = listExpectedCrashDatabases(normalizedUserDataDir);
  const processes = await collectProcEntries(ops);

  const profileChromium = processes.filter((entry) => {
    if (!isChromiumLikeProcess(entry.comm)) {
      return false;
    }
    const profileArg = findArgValue(entry.args, "--user-data-dir=");
    if (!profileArg) {
      return false;
    }
    return normalizeLinuxPath(profileArg) === normalizedUserDataDir;
  });

  const profileCrashpad = processes.filter((entry) => {
    if (!isCrashpadProcess(entry.comm)) {
      return false;
    }
    const databaseArg = findArgValue(entry.args, "--database=");
    if (!databaseArg) {
      return false;
    }
    return expectedCrashDatabases.has(normalizeLinuxPath(databaseArg));
  });

  if (profileCrashpad.length === 0) {
    return {
      skipped: "no-crashpad",
      scanned: processes.length,
      profileChromium: profileChromium.length,
      profileCrashpad: 0,
      terminated: 0,
      killed: 0,
    };
  }

  if (profileChromium.length > 0) {
    return {
      skipped: "profile-active",
      scanned: processes.length,
      profileChromium: profileChromium.length,
      profileCrashpad: profileCrashpad.length,
      terminated: 0,
      killed: 0,
    };
  }

  let terminated = 0;
  for (const proc of profileCrashpad) {
    if (trySignal(ops, proc.pid, "SIGTERM")) {
      terminated += 1;
    }
  }

  await ops.sleep(params.graceMs ?? DEFAULT_GRACE_MS);

  let killed = 0;
  for (const proc of profileCrashpad) {
    if (!isAlive(ops, proc.pid)) {
      continue;
    }
    if (trySignal(ops, proc.pid, "SIGKILL")) {
      killed += 1;
    }
  }

  logger?.info(
    `browser crashpad gc: profile=${normalizedUserDataDir} crashpad=${profileCrashpad.length} terminated=${terminated} killed=${killed}`,
  );

  return {
    scanned: processes.length,
    profileChromium: profileChromium.length,
    profileCrashpad: profileCrashpad.length,
    terminated,
    killed,
  };
}
