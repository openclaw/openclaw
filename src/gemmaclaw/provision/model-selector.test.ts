import { describe, expect, it } from "vitest";
import type { HardwareInfo } from "./hardware.js";
import { selectBestModel } from "./model-selector.js";

function makeHw(overrides: Partial<HardwareInfo> = {}): HardwareInfo {
  return {
    cpu: { arch: "x64", cores: 8, model: "Intel Core i7" },
    ram: { totalBytes: 16 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 },
    gpu: { detected: false, nvidia: false, apple: false },
    ...overrides,
  };
}

describe("selectBestModel", () => {
  it("selects e2b for minimal RAM (4 GB)", () => {
    const hw = makeHw({ ram: { totalBytes: 4 * 1024 ** 3, availableBytes: 2 * 1024 ** 3 } });
    const rec = selectBestModel(hw);
    expect(rec.model.id).toBe("gemma4:e2b");
    expect(rec.tier.tier).toBe("minimal");
  });

  it("selects e2b for 8 GB edge tier", () => {
    const hw = makeHw({ ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 } });
    const rec = selectBestModel(hw);
    expect(rec.model.id).toBe("gemma4:e2b");
  });

  it("selects e4b for 16 GB default tier (CPU-only, 75% headroom = 12 GB)", () => {
    const hw = makeHw({ ram: { totalBytes: 16 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 } });
    const rec = selectBestModel(hw);
    expect(rec.model.id).toBe("gemma4:e4b");
    expect(rec.tier.tier).toBe("default");
  });

  it("selects 26b for 32 GB workstation tier", () => {
    const hw = makeHw({ ram: { totalBytes: 32 * 1024 ** 3, availableBytes: 20 * 1024 ** 3 } });
    const rec = selectBestModel(hw);
    expect(rec.model.id).toBe("gemma4:26b");
    expect(rec.tier.tier).toBe("workstation");
  });

  it("selects 26b (fallback) for 48 GB Apple Silicon due to 31b blockers", () => {
    const hw = makeHw({
      ram: { totalBytes: 48 * 1024 ** 3, availableBytes: 20 * 1024 ** 3 },
      gpu: {
        detected: true,
        nvidia: false,
        apple: true,
        name: "Apple M4 Max",
        vramBytes: 48 * 1024 ** 3,
      },
    });
    const rec = selectBestModel(hw);
    expect(rec.model.id).toBe("gemma4:26b");
    expect(rec.tier.tier).toBe("high-memory");
    expect(rec.skippedIssues).toBeDefined();
    expect(rec.skippedIssues!.length).toBeGreaterThan(0);
    expect(rec.reason).toContain("skipped");
  });

  it("uses full RAM for GPU-accelerated systems", () => {
    const hw = makeHw({
      ram: { totalBytes: 24 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 },
      gpu: {
        detected: true,
        nvidia: true,
        apple: false,
        name: "RTX 4090",
        vramBytes: 24 * 1024 ** 3,
      },
    });
    const rec = selectBestModel(hw);
    expect(rec.model.id).toBe("gemma4:26b");
  });

  it("applies 75% headroom for CPU-only systems", () => {
    // 24 GB * 0.75 = 18 GB effective -> default tier (12-20 GB)
    const hw = makeHw({ ram: { totalBytes: 24 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 } });
    const rec = selectBestModel(hw);
    expect(rec.model.id).toBe("gemma4:e4b");
    expect(rec.tier.tier).toBe("default");
  });

  it("includes hardware description in reason", () => {
    const hw = makeHw({
      ram: { totalBytes: 48 * 1024 ** 3, availableBytes: 20 * 1024 ** 3 },
      gpu: {
        detected: true,
        nvidia: false,
        apple: true,
        name: "Apple M4 Max",
        vramBytes: 48 * 1024 ** 3,
      },
    });
    const rec = selectBestModel(hw);
    expect(rec.reason).toContain("Apple Silicon");
    expect(rec.reason).toContain("48 GB");
  });
});
