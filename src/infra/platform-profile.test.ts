import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectResourceProfile,
  getRecommendedConcurrency,
  isArmDevice,
} from "./platform-profile.js";

describe("platform-profile", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_RESOURCE_PROFILE;
    vi.restoreAllMocks();
  });

  describe("detectResourceProfile", () => {
    it("returns env override when set", () => {
      process.env.OPENCLAW_RESOURCE_PROFILE = "low";
      expect(detectResourceProfile()).toBe("low");
    });

    it("ignores invalid env override", () => {
      process.env.OPENCLAW_RESOURCE_PROFILE = "turbo";
      // Falls through to memory-based detection
      expect(["low", "standard", "high"]).toContain(detectResourceProfile());
    });

    it("returns low for <2GB", () => {
      vi.spyOn(os, "totalmem").mockReturnValue(1024 * 1024 * 1024); // 1GB
      expect(detectResourceProfile()).toBe("low");
    });

    it("returns low for ARM with <4GB", () => {
      vi.spyOn(os, "totalmem").mockReturnValue(3 * 1024 * 1024 * 1024);
      vi.stubGlobal("process", { ...process, arch: "arm64" });
      expect(detectResourceProfile()).toBe("low");
    });

    it("returns standard for 4GB", () => {
      vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 * 1024 * 1024);
      expect(detectResourceProfile()).toBe("standard");
    });

    it("returns high for 16GB", () => {
      vi.spyOn(os, "totalmem").mockReturnValue(16 * 1024 * 1024 * 1024);
      expect(detectResourceProfile()).toBe("high");
    });
  });

  describe("isArmDevice", () => {
    it("returns a boolean", () => {
      expect(typeof isArmDevice()).toBe("boolean");
    });
  });

  describe("getRecommendedConcurrency", () => {
    it("returns 1 for low profile", () => {
      process.env.OPENCLAW_RESOURCE_PROFILE = "low";
      expect(getRecommendedConcurrency()).toBe(1);
    });

    it("returns 2 for standard profile", () => {
      process.env.OPENCLAW_RESOURCE_PROFILE = "standard";
      expect(getRecommendedConcurrency()).toBe(2);
    });

    it("returns at least 1 for high profile", () => {
      process.env.OPENCLAW_RESOURCE_PROFILE = "high";
      expect(getRecommendedConcurrency()).toBeGreaterThanOrEqual(1);
    });
  });
});
