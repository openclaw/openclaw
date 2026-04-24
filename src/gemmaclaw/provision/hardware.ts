import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

export type HardwareInfo = {
  cpu: {
    arch: string;
    cores: number;
    model: string;
  };
  ram: {
    totalBytes: number;
    availableBytes: number;
  };
  gpu: {
    detected: boolean;
    nvidia: boolean;
    name?: string;
    vramBytes?: number;
  };
};

export type SystemTools = {
  ollamaInstalled: boolean;
  ollamaPath?: string;
  llamacppInstalled: boolean;
  llamacppPath?: string;
  cmakeInstalled: boolean;
  cppCompilerInstalled: boolean;
  gitInstalled: boolean;
};

/**
 * Detect hardware: CPU arch/cores, RAM, GPU presence.
 * Best-effort and safe: if any probe fails, that field defaults to unknown/absent.
 */
export function detectHardware(): HardwareInfo {
  const cpus = os.cpus();
  return {
    cpu: {
      arch: process.arch,
      cores: cpus.length || 1,
      model: cpus[0]?.model ?? "unknown",
    },
    ram: {
      totalBytes: os.totalmem(),
      availableBytes: os.freemem(),
    },
    gpu: detectGpu(),
  };
}

function detectGpu(): HardwareInfo["gpu"] {
  // Check for NVIDIA GPU via /dev/nvidia0 or nvidia-smi.
  const devExists = safeFileExists("/dev/nvidia0");

  if (devExists || hasNvidiaSmi()) {
    const smiInfo = queryNvidiaSmi();
    if (smiInfo) {
      return {
        detected: true,
        nvidia: true,
        name: smiInfo.name,
        vramBytes: smiInfo.vramMb ? smiInfo.vramMb * 1024 * 1024 : undefined,
      };
    }
    // Device exists but nvidia-smi gave no details.
    return { detected: true, nvidia: true };
  }

  return { detected: false, nvidia: false };
}

function safeFileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function hasNvidiaSmi(): boolean {
  try {
    execSync("which nvidia-smi", { timeout: 3_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function queryNvidiaSmi(): { name: string; vramMb?: number } | null {
  try {
    const output = execSync(
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits",
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!output) {
      return null;
    }
    const parts = output.split(",").map((s) => s.trim());
    const name = parts[0] ?? "NVIDIA GPU";
    const vramMb = parts[1] ? Number.parseInt(parts[1], 10) : undefined;
    return { name, vramMb: vramMb && !Number.isNaN(vramMb) ? vramMb : undefined };
  } catch {
    return null;
  }
}

/**
 * Detect system-installed tools.
 * Uses PATH binaries before downloading.
 */
export function detectSystemTools(): SystemTools {
  return {
    ollamaInstalled: !!whichSync("ollama"),
    ollamaPath: whichSync("ollama"),
    llamacppInstalled: !!whichSync("llama-server"),
    llamacppPath: whichSync("llama-server"),
    cmakeInstalled: !!whichSync("cmake"),
    cppCompilerInstalled: !!whichSync("g++") || !!whichSync("clang++"),
    gitInstalled: !!whichSync("git"),
  };
}

function whichSync(cmd: string): string | undefined {
  try {
    const result = execSync(`which ${cmd}`, {
      timeout: 3_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format hardware info for display.
 */
export function formatHardwareInfo(hw: HardwareInfo): string[] {
  const ramGb = (hw.ram.totalBytes / 1024 ** 3).toFixed(1);
  const freeRamGb = (hw.ram.availableBytes / 1024 ** 3).toFixed(1);

  const lines: string[] = [
    `  CPU: ${hw.cpu.arch}, ${hw.cpu.cores} cores (${hw.cpu.model.trim()})`,
    `  RAM: ${ramGb} GB total, ${freeRamGb} GB available`,
  ];

  if (hw.gpu.detected && hw.gpu.nvidia) {
    const vram = hw.gpu.vramBytes ? ` (${(hw.gpu.vramBytes / 1024 ** 3).toFixed(0)} GB VRAM)` : "";
    lines.push(`  GPU: ${hw.gpu.name ?? "NVIDIA GPU"}${vram}`);
  } else {
    lines.push("  GPU: none detected");
  }

  return lines;
}
