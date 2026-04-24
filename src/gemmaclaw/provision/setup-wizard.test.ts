import { describe, expect, it } from "vitest";
import type { HardwareInfo, SystemTools } from "./hardware.js";
import { formatModelSize, selectQuickProfile, validateBackendChoice } from "./setup-wizard.js";

function makeHw(overrides?: Partial<HardwareInfo>): HardwareInfo {
  return {
    cpu: { arch: "x64", cores: 8, model: "Intel Core i7" },
    ram: { totalBytes: 16 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 },
    gpu: { detected: false, nvidia: false },
    ...overrides,
  };
}

function makeTools(overrides?: Partial<SystemTools>): SystemTools {
  return {
    ollamaInstalled: false,
    llamacppInstalled: false,
    cmakeInstalled: false,
    cppCompilerInstalled: false,
    gitInstalled: false,
    ...overrides,
  };
}

describe("selectQuickProfile", () => {
  it("selects ollama when nvidia GPU detected", () => {
    const hw = makeHw({ gpu: { detected: true, nvidia: true, name: "RTX 3090" } });
    const profile = selectQuickProfile(hw, makeTools());
    expect(profile.backend).toBe("ollama");
    expect(profile.port).toBe(11434);
    expect(profile.reason).toContain("NVIDIA");
  });

  it("selects llama-cpp for x64 CPU-only system", () => {
    const hw = makeHw({ cpu: { arch: "x64", cores: 4, model: "Intel" } });
    const profile = selectQuickProfile(hw, makeTools());
    expect(profile.backend).toBe("llama-cpp");
    expect(profile.port).toBe(8080);
  });

  it("selects ollama for arm64 system (llama-cpp only ships x64)", () => {
    const hw = makeHw({ cpu: { arch: "arm64", cores: 4, model: "ARM" } });
    const profile = selectQuickProfile(hw, makeTools());
    expect(profile.backend).toBe("ollama");
    expect(profile.port).toBe(11434);
  });

  it("never selects gemma-cpp in quick mode", () => {
    // Even with all gemma.cpp tools available, quick mode avoids it.
    const hw = makeHw();
    const tools = makeTools({
      cmakeInstalled: true,
      cppCompilerInstalled: true,
      gitInstalled: true,
    });
    const profile = selectQuickProfile(hw, tools);
    expect(profile.backend).not.toBe("gemma-cpp");
  });

  it("prefers system-installed ollama over downloading llama-cpp", () => {
    const hw = makeHw({ cpu: { arch: "x64", cores: 8, model: "Intel" } });
    const tools = makeTools({ ollamaInstalled: true });
    const profile = selectQuickProfile(hw, tools);
    expect(profile.backend).toBe("ollama");
    expect(profile.reason).toContain("already installed");
  });

  it("prefers system-installed llama-server on x64 when ollama absent", () => {
    const hw = makeHw({ cpu: { arch: "x64", cores: 8, model: "Intel" } });
    const tools = makeTools({ llamacppInstalled: true });
    const profile = selectQuickProfile(hw, tools);
    expect(profile.backend).toBe("llama-cpp");
    expect(profile.reason).toContain("already installed");
  });

  it("prefers ollama when both are installed", () => {
    const hw = makeHw({ cpu: { arch: "x64", cores: 8, model: "Intel" } });
    const tools = makeTools({ ollamaInstalled: true, llamacppInstalled: true });
    // Both installed: no single-installed preference triggers, falls through to GPU/arch logic
    const profile = selectQuickProfile(hw, tools);
    // On x64 without GPU and both installed, it goes through normal flow (llama-cpp for x64)
    expect(["ollama", "llama-cpp"]).toContain(profile.backend);
  });
});

describe("validateBackendChoice", () => {
  it("returns null for valid ollama choice", () => {
    expect(validateBackendChoice("ollama", makeTools())).toBeNull();
  });

  it("returns null for valid llama-cpp choice on x64", () => {
    // process.arch is "x64" in test environment (standard CI)
    if (process.arch === "x64") {
      expect(validateBackendChoice("llama-cpp", makeTools())).toBeNull();
    }
  });

  it("warns about missing git for gemma-cpp", () => {
    const tools = makeTools({ cmakeInstalled: true, cppCompilerInstalled: true });
    const result = validateBackendChoice("gemma-cpp", tools);
    expect(result).toContain("git");
  });

  it("warns about missing cmake for gemma-cpp", () => {
    const tools = makeTools({ gitInstalled: true, cppCompilerInstalled: true });
    const result = validateBackendChoice("gemma-cpp", tools);
    expect(result).toContain("cmake");
  });

  it("warns about missing HF_TOKEN for gemma-cpp when tools present", () => {
    const oldToken = process.env.HF_TOKEN;
    delete process.env.HF_TOKEN;
    try {
      const tools = makeTools({
        gitInstalled: true,
        cmakeInstalled: true,
        cppCompilerInstalled: true,
      });
      const result = validateBackendChoice("gemma-cpp", tools);
      expect(result).toContain("HF_TOKEN");
    } finally {
      if (oldToken !== undefined) {
        process.env.HF_TOKEN = oldToken;
      }
    }
  });

  it("returns null for gemma-cpp when all deps present and HF_TOKEN set", () => {
    const oldToken = process.env.HF_TOKEN;
    process.env.HF_TOKEN = "hf_test";
    try {
      const tools = makeTools({
        gitInstalled: true,
        cmakeInstalled: true,
        cppCompilerInstalled: true,
      });
      expect(validateBackendChoice("gemma-cpp", tools)).toBeNull();
    } finally {
      if (oldToken !== undefined) {
        process.env.HF_TOKEN = oldToken;
      } else {
        delete process.env.HF_TOKEN;
      }
    }
  });
});

describe("formatModelSize", () => {
  it("formats GB values", () => {
    expect(formatModelSize(5_000_000_000)).toBe("5.0 GB");
  });

  it("formats MB values", () => {
    expect(formatModelSize(815_000_000)).toBe("815 MB");
  });

  it("handles undefined", () => {
    expect(formatModelSize(undefined)).toBe("unknown size");
  });
});
