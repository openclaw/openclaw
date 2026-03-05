import * as fs from "fs";
import * as os from "os";

/** Minimum memory required for gateway (1 GiB in bytes) */
export const GATEWAY_MIN_MEMORY_BYTES = 1 * 1024 * 1024 * 1024;

/** Recommended memory for gateway (2 GiB in bytes) */
export const GATEWAY_RECOMMENDED_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

/** Cgroup v2 memory limit file path */
const CGROUP_V2_MEMORY_LIMIT = "/sys/fs/cgroup/memory.max";

/** Cgroup v1 memory limit file path */
const CGROUP_V1_MEMORY_LIMIT = "/sys/fs/cgroup/memory/memory.limit_in_bytes";

export type MemoryAssessmentStatus = "ok" | "warn" | "error";

export type MemoryAssessmentResult = {
  status: MemoryAssessmentStatus;
  totalMemoryBytes: number;
  effectiveMemoryBytes: number;
  source: "system" | "cgroupv2" | "cgroupv1";
};

/**
 * Parse cgroup memory limit from string to bytes.
 * Returns null if the value is "max" (unlimited) or invalid.
 */
export function parseCgroupLimitBytes(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "max") {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = BigInt(trimmed);
  if (parsed <= 0n) {
    return null;
  }
  // Treat very large values as unlimited (practical upper bound: 128TB)
  const SENTINEL = BigInt(128) * BigInt(1024) ** BigInt(4);
  if (parsed >= SENTINEL) {
    return null;
  }
  return Number(parsed);
}

/**
 * Read cgroup v2 memory limit.
 * Returns null if not available or unlimited.
 */
function readCgroupV2MemoryLimit(): number | null {
  try {
    if (!fs.existsSync(CGROUP_V2_MEMORY_LIMIT)) {
      return null;
    }
    const content = fs.readFileSync(CGROUP_V2_MEMORY_LIMIT, "utf-8");
    return parseCgroupLimitBytes(content);
  } catch {
    return null;
  }
}

/**
 * Read cgroup v1 memory limit.
 * Returns null if not available or unlimited.
 */
function readCgroupV1MemoryLimit(): number | null {
  try {
    if (!fs.existsSync(CGROUP_V1_MEMORY_LIMIT)) {
      return null;
    }
    const content = fs.readFileSync(CGROUP_V1_MEMORY_LIMIT, "utf-8");
    return parseCgroupLimitBytes(content);
  } catch {
    return null;
  }
}

/**
 * Get the effective memory limit for the process.
 * Priority: cgroup v2 > cgroup v1 > system total memory
 */
export function getEffectiveMemoryBytes(): { bytes: number; source: MemoryAssessmentResult["source"] } {
  // Try cgroup v2 first
  const cgroupV2Limit = readCgroupV2MemoryLimit();
  if (cgroupV2Limit !== null) {
    return { bytes: cgroupV2Limit, source: "cgroupv2" };
  }

  // Try cgroup v1
  const cgroupV1Limit = readCgroupV1MemoryLimit();
  if (cgroupV1Limit !== null) {
    return { bytes: cgroupV1Limit, source: "cgroupv1" };
  }

  // Fall back to system total memory
  return { bytes: os.totalmem(), source: "system" };
}

/**
 * Assess memory availability for gateway startup.
 * Returns assessment result with status:
 * - "ok": Sufficient memory (>= 2 GiB)
 * - "warn": Low memory (>= 1 GiB but < 2 GiB)
 * - "error": Insufficient memory (< 1 GiB)
 */
export function assessGatewayStartupMemory(): MemoryAssessmentResult {
  const totalMemoryBytes = os.totalmem();
  const { bytes: effectiveMemoryBytes, source } = getEffectiveMemoryBytes();

  let status: MemoryAssessmentStatus;
  if (effectiveMemoryBytes >= GATEWAY_RECOMMENDED_MEMORY_BYTES) {
    status = "ok";
  } else if (effectiveMemoryBytes >= GATEWAY_MIN_MEMORY_BYTES) {
    status = "warn";
  } else {
    status = "error";
  }

  return {
    status,
    totalMemoryBytes,
    effectiveMemoryBytes,
    source,
  };
}

/**
 * Format memory size in human-readable format.
 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Format memory assessment result as a user-friendly message.
 */
export function formatMemoryAssessmentMessage(result: MemoryAssessmentResult): string {
  const effective = formatBytes(result.effectiveMemoryBytes);
  const min = formatBytes(GATEWAY_MIN_MEMORY_BYTES);
  const recommended = formatBytes(GATEWAY_RECOMMENDED_MEMORY_BYTES);

  if (result.status === "error") {
    return [
      `❌ Insufficient memory for OpenClaw gateway`,
      ``,
      `Available: ${effective}`,
      `Required: ${min} (minimum), ${recommended} (recommended)`,
      ``,
      `The gateway requires at least ${min} of available memory to start.`,
      `Please free up memory or increase your system's RAM.`,
      ``,
      `📖 See: https://docs.openclaw.ai/gateway/requirements`,
    ].join("\n");
  }

  if (result.status === "warn") {
    return [
      `⚠️ Low memory warning for OpenClaw gateway`,
      ``,
      `Available: ${effective}`,
      `Recommended: ${recommended}`,
      ``,
      `The gateway may experience performance issues with limited memory.`,
      `For optimal performance, consider using at least ${recommended} of RAM.`,
    ].join("\n");
  }

  return `✅ Sufficient memory: ${effective}`;
}
