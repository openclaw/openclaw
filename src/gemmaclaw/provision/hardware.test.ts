import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process and fs before importing the module.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: { existsSync: vi.fn() },
  existsSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  default: {
    cpus: vi.fn(),
    totalmem: vi.fn(),
    freemem: vi.fn(),
  },
  cpus: vi.fn(),
  totalmem: vi.fn(),
  freemem: vi.fn(),
}));

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import {
  detectHardware,
  detectSystemTools,
  formatHardwareInfo,
  type HardwareInfo,
} from "./hardware.js";

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockCpus = vi.mocked(os.cpus);
const mockTotalmem = vi.mocked(os.totalmem);
const mockFreemem = vi.mocked(os.freemem);

describe("detectHardware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCpus.mockReturnValue([
      {
        model: "Intel Core i7-9700K",
        speed: 3600,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      },
      {
        model: "Intel Core i7-9700K",
        speed: 3600,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      },
      {
        model: "Intel Core i7-9700K",
        speed: 3600,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      },
      {
        model: "Intel Core i7-9700K",
        speed: 3600,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      },
    ]);
    mockTotalmem.mockReturnValue(16 * 1024 ** 3);
    mockFreemem.mockReturnValue(8 * 1024 ** 3);
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
  });

  it("detects CPU info", () => {
    const hw = detectHardware();
    expect(hw.cpu.cores).toBe(4);
    expect(hw.cpu.model).toContain("Intel");
    expect(hw.cpu.arch).toBe(process.arch);
  });

  it("detects RAM info", () => {
    const hw = detectHardware();
    expect(hw.ram.totalBytes).toBe(16 * 1024 ** 3);
    expect(hw.ram.availableBytes).toBe(8 * 1024 ** 3);
  });

  it("reports no GPU when /dev/nvidia0 absent and nvidia-smi fails", () => {
    const hw = detectHardware();
    expect(hw.gpu.detected).toBe(false);
    expect(hw.gpu.nvidia).toBe(false);
  });

  it("detects GPU via /dev/nvidia0 without nvidia-smi details", () => {
    mockExistsSync.mockImplementation((p) => {
      return p === "/dev/nvidia0";
    });
    const hw = detectHardware();
    expect(hw.gpu.detected).toBe(true);
    expect(hw.gpu.nvidia).toBe(true);
    expect(hw.gpu.name).toBeUndefined();
  });

  it("detects GPU with nvidia-smi details", () => {
    mockExistsSync.mockImplementation((p) => {
      return p === "/dev/nvidia0";
    });
    mockExecSync.mockImplementation((cmd) => {
      if (cmd.includes("nvidia-smi --query")) {
        return "NVIDIA RTX 3090, 24576\n";
      }
      if (cmd.includes("which nvidia-smi")) {
        return "/usr/bin/nvidia-smi\n";
      }
      throw new Error("not found");
    });
    const hw = detectHardware();
    expect(hw.gpu.detected).toBe(true);
    expect(hw.gpu.nvidia).toBe(true);
    expect(hw.gpu.name).toBe("NVIDIA RTX 3090");
    expect(hw.gpu.vramBytes).toBe(24576 * 1024 * 1024);
  });

  it("handles empty cpus array gracefully", () => {
    mockCpus.mockReturnValue([]);
    const hw = detectHardware();
    expect(hw.cpu.cores).toBe(1); // fallback minimum
    expect(hw.cpu.model).toBe("unknown");
  });
});

describe("detectSystemTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
  });

  it("detects no tools when which fails for all", () => {
    const tools = detectSystemTools();
    expect(tools.ollamaInstalled).toBe(false);
    expect(tools.llamacppInstalled).toBe(false);
    expect(tools.cmakeInstalled).toBe(false);
    expect(tools.cppCompilerInstalled).toBe(false);
    expect(tools.gitInstalled).toBe(false);
  });

  it("detects ollama when which ollama succeeds", () => {
    mockExecSync.mockImplementation((cmd) => {
      if (cmd === "which ollama") {
        return "/usr/local/bin/ollama\n";
      }
      throw new Error("not found");
    });
    const tools = detectSystemTools();
    expect(tools.ollamaInstalled).toBe(true);
    expect(tools.ollamaPath).toBe("/usr/local/bin/ollama");
  });

  it("detects build tools for gemma.cpp", () => {
    mockExecSync.mockImplementation((cmd) => {
      if (cmd === "which cmake") {
        return "/usr/bin/cmake\n";
      }
      if (cmd === "which g++") {
        return "/usr/bin/g++\n";
      }
      if (cmd === "which git") {
        return "/usr/bin/git\n";
      }
      throw new Error("not found");
    });
    const tools = detectSystemTools();
    expect(tools.cmakeInstalled).toBe(true);
    expect(tools.cppCompilerInstalled).toBe(true);
    expect(tools.gitInstalled).toBe(true);
  });
});

describe("formatHardwareInfo", () => {
  it("formats CPU-only system", () => {
    const hw: HardwareInfo = {
      cpu: { arch: "x64", cores: 8, model: "AMD Ryzen 7" },
      ram: { totalBytes: 16 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 },
      gpu: { detected: false, nvidia: false },
    };
    const lines = formatHardwareInfo(hw);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("x64");
    expect(lines[0]).toContain("8 cores");
    expect(lines[1]).toContain("16.0 GB");
    expect(lines[2]).toContain("none detected");
  });

  it("formats NVIDIA GPU system", () => {
    const hw: HardwareInfo = {
      cpu: { arch: "x64", cores: 12, model: "Intel i9" },
      ram: { totalBytes: 32 * 1024 ** 3, availableBytes: 20 * 1024 ** 3 },
      gpu: { detected: true, nvidia: true, name: "RTX 4090", vramBytes: 24 * 1024 ** 3 },
    };
    const lines = formatHardwareInfo(hw);
    expect(lines[2]).toContain("RTX 4090");
    expect(lines[2]).toContain("24 GB VRAM");
  });
});
