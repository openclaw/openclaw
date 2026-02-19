import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildImageResizeSideGrid, IMAGE_REDUCE_QUALITY_STEPS, prefersSips } from "./image-ops.js";

describe("buildImageResizeSideGrid", () => {
  it("returns descending unique sides capped by maxSide", () => {
    expect(buildImageResizeSideGrid(1200, 900)).toEqual([1200, 1000, 900, 800]);
  });

  it("keeps only positive side values", () => {
    expect(buildImageResizeSideGrid(0, 0)).toEqual([]);
  });
});

describe("IMAGE_REDUCE_QUALITY_STEPS", () => {
  it("keeps expected quality ladder", () => {
    expect([...IMAGE_REDUCE_QUALITY_STEPS]).toEqual([85, 75, 65, 55, 45, 35]);
  });
});

// ---------------------------------------------------------------------------
// prefersSips()
//
// Logic:
//   OPENCLAW_IMAGE_BACKEND === "sips"                         → true  (any platform)
//   OPENCLAW_IMAGE_BACKEND === "sharp"                        → false (any platform)
//   OPENCLAW_IMAGE_BACKEND unset / empty + darwin             → true  (← fix: was Node.js-broken)
//   OPENCLAW_IMAGE_BACKEND unset / empty + linux | win32      → false
// ---------------------------------------------------------------------------
describe("prefersSips", () => {
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Allow overriding process.platform per test
    platformSpy = vi.spyOn(process, "platform", "get");
    // Restore env vars automatically after each test
    vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    platformSpy.mockRestore();
  });

  // Branch 1 — explicit sips, any platform
  describe("OPENCLAW_IMAGE_BACKEND=sips", () => {
    it("returns true on darwin", () => {
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "sips");
      platformSpy.mockReturnValue("darwin" as NodeJS.Platform);
      expect(prefersSips()).toBe(true);
    });

    it("returns true on linux", () => {
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "sips");
      platformSpy.mockReturnValue("linux" as NodeJS.Platform);
      expect(prefersSips()).toBe(true);
    });

    it("returns true on win32", () => {
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "sips");
      platformSpy.mockReturnValue("win32" as NodeJS.Platform);
      expect(prefersSips()).toBe(true);
    });
  });

  // Branch 2 — explicit sharp wins even on darwin
  describe("OPENCLAW_IMAGE_BACKEND=sharp", () => {
    it("returns false on darwin (sharp override takes priority)", () => {
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "sharp");
      platformSpy.mockReturnValue("darwin" as NodeJS.Platform);
      expect(prefersSips()).toBe(false);
    });

    it("returns false on linux", () => {
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "sharp");
      platformSpy.mockReturnValue("linux" as NodeJS.Platform);
      expect(prefersSips()).toBe(false);
    });

    // Branch 5 — explicit sharp on darwin even if runtime resembles Bun
    it("returns false on darwin when env=sharp (Bun-like runtime, regression guard)", () => {
      // Simulates: OPENCLAW_IMAGE_BACKEND=sharp + darwin + Bun process
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "sharp");
      // Fake a Bun version string to confirm sharp env still wins
      const origBun = (process.versions as Record<string, unknown>).bun;
      (process.versions as Record<string, unknown>).bun = "1.0.0";
      platformSpy.mockReturnValue("darwin" as NodeJS.Platform);
      try {
        expect(prefersSips()).toBe(false);
      } finally {
        if (origBun === undefined) {
          delete (process.versions as Record<string, unknown>).bun;
        } else {
          (process.versions as Record<string, unknown>).bun = origBun;
        }
      }
    });
  });

  // Branch 3 — THE FIX: no env var + darwin → must be true for both Node.js and Bun
  describe("no OPENCLAW_IMAGE_BACKEND env var + darwin", () => {
    it("returns true on darwin (Node.js runtime — core fix, was false before)", () => {
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "");
      platformSpy.mockReturnValue("darwin" as NodeJS.Platform);
      expect(prefersSips()).toBe(true);
    });

    it("returns true on darwin when Bun is detected (no regression)", () => {
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "");
      const origBun = (process.versions as Record<string, unknown>).bun;
      (process.versions as Record<string, unknown>).bun = "1.0.0";
      platformSpy.mockReturnValue("darwin" as NodeJS.Platform);
      try {
        expect(prefersSips()).toBe(true);
      } finally {
        if (origBun === undefined) {
          delete (process.versions as Record<string, unknown>).bun;
        } else {
          (process.versions as Record<string, unknown>).bun = origBun;
        }
      }
    });

    // Empty string is distinct from "sips" — falls through to platform check
    it("returns true on darwin when env var is empty string", () => {
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "");
      platformSpy.mockReturnValue("darwin" as NodeJS.Platform);
      expect(prefersSips()).toBe(true);
    });
  });

  // Branch 4 — no env var + non-darwin → false
  describe("no OPENCLAW_IMAGE_BACKEND env var + non-darwin", () => {
    it("returns false on linux", () => {
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "");
      platformSpy.mockReturnValue("linux" as NodeJS.Platform);
      expect(prefersSips()).toBe(false);
    });

    it("returns false on win32", () => {
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "");
      platformSpy.mockReturnValue("win32" as NodeJS.Platform);
      expect(prefersSips()).toBe(false);
    });

    it("returns false on linux when env var is empty string", () => {
      vi.stubEnv("OPENCLAW_IMAGE_BACKEND", "");
      platformSpy.mockReturnValue("linux" as NodeJS.Platform);
      expect(prefersSips()).toBe(false);
    });
  });
});
