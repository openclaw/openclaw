import { describe, expect, it } from "vitest";
import {
  formatMissingChildRuntimeWarning,
  readChildRuntimeViability,
} from "./child-runtime-viability.ts";

const removedCellarPath = "/opt/homebrew/Cellar/node@24/24.20.0/bin/node";

describe("child runtime viability", () => {
  it("treats a missing executable as a stale runtime", () => {
    const viability = readChildRuntimeViability({
      execPath: removedCellarPath,
      access: () => {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      },
    });

    expect(viability).toEqual({ execPath: removedCellarPath, available: false });
    expect(formatMissingChildRuntimeWarning(viability)).toBe(
      `Gateway runtime is stale after Node upgrade: child workers are using ${removedCellarPath}, which no longer exists. Restart the Gateway.`,
    );
  });

  it("stays quiet when the retained executable can still be started", () => {
    const viability = readChildRuntimeViability({
      execPath: process.execPath,
      access: () => undefined,
    });

    expect(viability).toEqual({ execPath: process.execPath, available: true });
    expect(formatMissingChildRuntimeWarning(viability)).toBeUndefined();
  });

  it("does not call a permission error a deleted Node path", () => {
    const viability = readChildRuntimeViability({
      execPath: removedCellarPath,
      access: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });

    expect(viability.available).toBe(true);
    expect(formatMissingChildRuntimeWarning(viability)).toBeUndefined();
  });
});
