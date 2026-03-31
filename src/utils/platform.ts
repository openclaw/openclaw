import os from "node:os";

/**
 * Detect if running on Apple Silicon (ARM64) architecture
 */
export function isAppleSilicon(): boolean {
  return process.arch === "arm64" && process.platform === "darwin";
}

/**
 * Detect if running on any ARM64 architecture
 */
export function isArm64(): boolean {
  return process.arch === "arm64";
}

/**
 * Get the number of physical CPU cores (not logical)
 * On Apple Silicon, this is important for optimizing parallel work
 */
export function getPhysicalCpuCount(): number {
  if (process.platform === "darwin" && isAppleSilicon()) {
    // On Apple Silicon, use sysctl to get physical core count
    try {
      const { execSync } = require("node:child_process");
      // On Apple Silicon M1+, there are different core types (performance vs efficiency)
      // We want total physical cores
      const output = execSync("sysctl -n hw.perflevel0.cpu_count 2>/dev/null || sysctl -n hw.ncpu", {
        encoding: "utf8",
      }).trim();
      const count = parseInt(output, 10);
      if (!isNaN(count) && count > 0) {
        return count;
      }
    } catch {
      // Fall back to logical CPU count
    }
  }
  
  // Fallback to logical CPU count for other platforms
  return os.cpus().length;
}

/**
 * Get memory info optimized for Apple Silicon's unified memory architecture
 */
export function getMemoryInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  
  // On Apple Silicon, the unified memory architecture means
  // we should be more aggressive with memory usage
  const isAppleSiliconPlatform = isAppleSilicon();
  
  return {
    total: totalMem,
    free: freeMem,
    used: totalMem - freeMem,
    usagePercentage: (1 - freeMem / totalMem) * 100,
    isAppleSilicon: isAppleSiliconPlatform,
    // On Apple Silicon with unified memory, we can use more aggressive thresholds
    safeUsageThreshold: isAppleSiliconPlatform ? 85 : 80,
  };
}

/**
 * Get optimal buffer size for I/O operations based on architecture
 * ARM64 can handle larger buffers more efficiently
 */
export function getOptimalBufferSize(): number {
  // On ARM64 (including Apple Silicon), larger buffers are more efficient
  const baseSize = 64 * 1024; // 64KB base
  
  if (isArm64()) {
    return baseSize * 2; // 128KB for ARM64
  }
  
  return baseSize;
}

/**
 * Get optimal parallelization factor based on CPU architecture
 */
export function getOptimalParallelFactor(): number {
  const cpuCount = getPhysicalCpuCount();
  
  // On Apple Silicon, we can use more threads due to efficient core management
  if (isAppleSilicon()) {
    // Use all physical cores for parallel work
    return cpuCount;
  }
  
  // On other platforms, be more conservative
  return Math.max(1, cpuCount - 1);
}

/**
 * Detect if we're running in a Docker container on Apple Silicon
 */
export function isDockerOnAppleSilicon(): boolean {
  if (!isAppleSilicon()) {
    return false;
  }
  
  try {
    // Check for Docker environment indicators
    const fs = require("node:fs");
    if (fs.existsSync("/.dockerenv")) {
      return true;
    }
    
    // Check for Docker-related cgroups
    const content = fs.readFileSync("/proc/1/cgroup", "utf8");
    return content.includes("docker") || content.includes("containerd");
  } catch {
    return false;
  }
}

/**
 * Get platform-specific spawn options optimized for Apple Silicon
 */
export function getSpawnOptions(options?: {
  detached?: boolean;
  stdio?: any;
}): import("node:child_process").SpawnOptions {
  const baseOptions: import("node:child_process").SpawnOptions = {};
  
  if (options?.detached !== undefined) {
    baseOptions.detached = options.detached;
  } else if (isAppleSilicon()) {
    // On Apple Silicon, detached processes are more efficient
    baseOptions.detached = true;
  }
  
  if (options?.stdio) {
    baseOptions.stdio = options.stdio;
  }
  
  // Add Apple Silicon-specific optimizations
  if (isAppleSilicon()) {
    // Use process group for better signal handling on Apple Silicon
    baseOptions.detached = true;
  }
  
  return baseOptions;
}

/**
 * Get shell command optimized for Apple Silicon
 */
export function getShellCommand(): { shell: string; args: string[] } {
  if (process.platform !== "darwin") {
    // Use default shell for non-macOS platforms
    const { getShellConfig } = require("./shell-utils.js");
    return getShellConfig();
  }
  
  // On Apple Silicon macOS, prefer zsh (default shell since macOS 10.15)
  // zsh has better ARM64 support and performance than bash
  const shellPath = process.env.SHELL || "/bin/zsh";
  
  // Check if zsh is available
  try {
    const { execSync } = require("node:child_process");
    execSync(`test -x "${shellPath}"`, { stdio: "ignore" });
  } catch {
    // Fall back to bash if zsh is not available
    return { shell: "/bin/bash", args: ["-c"] };
  }
  
  // On Apple Silicon, use zsh with optimized flags
  return { shell: shellPath, args: ["-c"] };
}

/**
 * Get optimal timeout multiplier for Apple Silicon
 * Apple Silicon can be faster but may need different timeout handling
 */
export function getTimeoutMultiplier(): number {
  // On Apple Silicon, operations are typically faster
  // But we should be conservative with timeouts to avoid false failures
  if (isAppleSilicon()) {
    return 1.0; // No adjustment needed for Apple Silicon
  }
  
  return 1.2; // Slightly more conservative on other platforms
}
