import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

export type ResourceScope = "container" | "host";

export type CpuStats = {
  usagePct?: number;
  loadAvg?: [number, number, number];
  cores?: number;
};

export type MemoryStats = {
  totalBytes: number;
  usedBytes: number;
  availableBytes?: number;
};

export type DiskStats = {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  availableBytes: number;
};

export type ProcessStats = {
  pid: number;
  command: string;
  cpuPct: number;
  memPct: number;
};

export type ResourceSnapshot = {
  scope: ResourceScope;
  cpu?: CpuStats;
  memory?: MemoryStats;
  disk?: DiskStats;
  topProcesses?: ProcessStats[];
  warnings?: string[];
  error?: string;
};

const HOST_ROOT = "/host";

function fileExists(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readText(path: string): string | undefined {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function parseNumber(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const num = Number.parseFloat(trimmed);
  return Number.isFinite(num) ? num : undefined;
}

function parseIntSafe(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "max") {
    return undefined;
  }
  const num = Number.parseInt(trimmed, 10);
  return Number.isFinite(num) ? num : undefined;
}

function formatLoadAvg(raw: string): [number, number, number] | undefined {
  const parts = raw.trim().split(/\s+/).slice(0, 3);
  if (parts.length !== 3) {
    return undefined;
  }
  const parsed = parts.map((entry) => parseNumber(entry));
  if (parsed.some((entry) => entry == null)) {
    return undefined;
  }
  return parsed as [number, number, number];
}

function readLoadAvg(procPath: string): [number, number, number] | undefined {
  const raw = readText(procPath);
  if (!raw) {
    return undefined;
  }
  return formatLoadAvg(raw);
}

function sumCpuTimesFromOs(): { idle: number; total: number; cores: number } | undefined {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) {
    return undefined;
  }
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle ?? 0;
    total += (times.user ?? 0) + (times.nice ?? 0) + (times.sys ?? 0) + (times.idle ?? 0) + (times.irq ?? 0);
  }
  return { idle, total, cores: cpus.length };
}

function sumCpuTimesFromProc(procPath: string): { idle: number; total: number } | undefined {
  const raw = readText(procPath);
  if (!raw) {
    return undefined;
  }
  const line = raw.split("\n").find((entry) => entry.startsWith("cpu "));
  if (!line) {
    return undefined;
  }
  const parts = line.trim().split(/\s+/).slice(1);
  const values = parts.map((entry) => Number.parseInt(entry, 10)).filter(Number.isFinite);
  if (values.length < 4) {
    return undefined;
  }
  const idle = values[3] + (values[4] ?? 0);
  const total = values.reduce((sum, val) => sum + val, 0);
  return { idle, total };
}

async function sampleCpuUsage(params: {
  procStatPath?: string;
  coresFallback?: number;
}): Promise<CpuStats | undefined> {
  const readSample = () => {
    if (params.procStatPath) {
      return sumCpuTimesFromProc(params.procStatPath);
    }
    return undefined;
  };
  const sample1 = readSample();
  const sample2 = (() => {
    const osSample = sumCpuTimesFromOs();
    return osSample ? { idle: osSample.idle, total: osSample.total } : undefined;
  })();
  const baseline = sample1 ?? sample2;
  if (!baseline) {
    return undefined;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const nextSample = readSample() ?? sample2 ?? baseline;
  const idleDelta = nextSample.idle - baseline.idle;
  const totalDelta = nextSample.total - baseline.total;
  const usagePct =
    totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : undefined;
  return {
    usagePct,
    cores: params.coresFallback ?? sumCpuTimesFromOs()?.cores,
  };
}

function readMeminfo(procPath: string): { totalBytes?: number; availableBytes?: number } {
  const raw = readText(procPath);
  if (!raw) {
    return {};
  }
  const lines = raw.split("\n");
  let totalKb: number | undefined;
  let availableKb: number | undefined;
  for (const line of lines) {
    const [label, value] = line.split(":");
    if (!label || !value) {
      continue;
    }
    const kb = parseIntSafe(value.replace(/kB/i, "").trim());
    if (label.trim() === "MemTotal") {
      totalKb = kb;
    } else if (label.trim() === "MemAvailable") {
      availableKb = kb;
    }
  }
  return {
    totalBytes: totalKb ? totalKb * 1024 : undefined,
    availableBytes: availableKb ? availableKb * 1024 : undefined,
  };
}

function readCgroupMemory(cgroupRoot: string): { totalBytes?: number; usedBytes?: number } {
  const v2Max = readText(`${cgroupRoot}/memory.max`);
  const v2Cur = readText(`${cgroupRoot}/memory.current`);
  if (v2Max || v2Cur) {
    const totalBytes = parseIntSafe(v2Max);
    const usedBytes = parseIntSafe(v2Cur);
    return { totalBytes, usedBytes };
  }
  const v1Max = readText(`${cgroupRoot}/memory/memory.limit_in_bytes`);
  const v1Use = readText(`${cgroupRoot}/memory/memory.usage_in_bytes`);
  if (v1Max || v1Use) {
    const totalBytes = parseIntSafe(v1Max);
    const usedBytes = parseIntSafe(v1Use);
    return { totalBytes, usedBytes };
  }
  return {};
}

function readDiskStats(path: string): DiskStats | undefined {
  try {
    const stat = fs.statfsSync(path);
    const blockSize = stat.bsize ?? 0;
    if (!blockSize) {
      return undefined;
    }
    const totalBytes = blockSize * stat.blocks;
    const freeBytes = blockSize * stat.bfree;
    const availableBytes = blockSize * stat.bavail;
    const usedBytes = totalBytes - freeBytes;
    return { path, totalBytes, usedBytes, freeBytes, availableBytes };
  } catch {
    return undefined;
  }
}

function readTopProcesses(maxCount: number): { processes: ProcessStats[]; warning?: string } {
  const isDarwin = os.platform() === "darwin";
  const args = isDarwin
    ? ["-axo", "pid,comm,%cpu,%mem", "-r"]
    : ["-eo", "pid,comm,%cpu,%mem", "--sort=-%cpu"];
  const res = spawnSync("ps", args, { encoding: "utf-8" });
  if (res.status !== 0 || !res.stdout) {
    return { processes: [], warning: "Unable to read process list." };
  }
  const lines = res.stdout.trim().split("\n");
  const rows = lines.slice(1);
  const processes: ProcessStats[] = [];
  for (const row of rows) {
    const parts = row.trim().split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    const pid = Number.parseInt(parts[0], 10);
    const cpuPct = Number.parseFloat(parts[2]);
    const memPct = Number.parseFloat(parts[3]);
    if (!Number.isFinite(pid) || !Number.isFinite(cpuPct) || !Number.isFinite(memPct)) {
      continue;
    }
    const command = parts[1] ?? "";
    processes.push({ pid, command, cpuPct, memPct });
    if (processes.length >= maxCount) {
      break;
    }
  }
  return { processes };
}

function resolveHostPaths(): { proc: string; cgroup: string; disk: string } | undefined {
  const procPath = `${HOST_ROOT}/proc`;
  const cgroupPath = `${HOST_ROOT}/sys/fs/cgroup`;
  const diskPath = `${HOST_ROOT}`;
  if (!fileExists(procPath) || !fileExists(cgroupPath)) {
    return undefined;
  }
  return { proc: procPath, cgroup: cgroupPath, disk: diskPath };
}

export async function readResourceSnapshot(params: {
  scope: ResourceScope;
  includeTop?: boolean;
}): Promise<ResourceSnapshot> {
  const warnings: string[] = [];
  const snapshot: ResourceSnapshot = { scope: params.scope, warnings };
  const hostPaths = params.scope === "host" ? resolveHostPaths() : undefined;
  if (params.scope === "host" && !hostPaths) {
    return {
      scope: params.scope,
      error:
        "Host metrics unavailable (mount /host/proc and /host/sys/fs/cgroup read-only). On macOS without a helper, host stats are not available.",
    };
  }

  const procRoot = params.scope === "host" ? hostPaths?.proc : "/proc";
  const cgroupRoot = params.scope === "host" ? hostPaths?.cgroup : "/sys/fs/cgroup";
  const diskRoot = params.scope === "host" ? hostPaths?.disk : "/";

  const cpuStats = await sampleCpuUsage({
    procStatPath: procRoot ? `${procRoot}/stat` : undefined,
  });
  const loadAvg =
    procRoot && fileExists(`${procRoot}/loadavg`)
      ? readLoadAvg(`${procRoot}/loadavg`)
      : os.loadavg().length >= 3
        ? (os.loadavg().slice(0, 3) as [number, number, number])
        : undefined;

  snapshot.cpu = {
    usagePct: cpuStats?.usagePct,
    loadAvg: loadAvg ?? cpuStats?.loadAvg,
    cores: cpuStats?.cores,
  };

  const meminfo = procRoot ? readMeminfo(`${procRoot}/meminfo`) : {};
  const cgroupMem = cgroupRoot ? readCgroupMemory(cgroupRoot) : {};
  const totalBytes =
    params.scope === "host"
      ? meminfo.totalBytes
      : cgroupMem.totalBytes ?? meminfo.totalBytes ?? os.totalmem();
  const usedBytes = (() => {
    if (cgroupMem.usedBytes != null) {
      return cgroupMem.usedBytes;
    }
    if (totalBytes != null && meminfo.availableBytes != null) {
      return Math.max(0, totalBytes - meminfo.availableBytes);
    }
    if (params.scope !== "host") {
      return Math.max(0, os.totalmem() - os.freemem());
    }
    return undefined;
  })();
  if (totalBytes != null && usedBytes != null) {
    snapshot.memory = {
      totalBytes,
      usedBytes,
      availableBytes: meminfo.availableBytes,
    };
  }

  if (diskRoot) {
    const diskStats = readDiskStats(diskRoot);
    if (diskStats) {
      snapshot.disk = diskStats;
    }
  }

  if (params.includeTop) {
    if (params.scope === "host") {
      warnings.push("Top processes are only available for the container scope.");
    } else {
      const top = readTopProcesses(5);
      snapshot.topProcesses = top.processes;
      if (top.warning) {
        warnings.push(top.warning);
      }
    }
  }

  if (warnings.length === 0) {
    delete snapshot.warnings;
  }

  return snapshot;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return "?";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const label = value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${label} ${units[index]}`;
}
