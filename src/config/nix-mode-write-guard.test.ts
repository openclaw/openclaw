import { describe, expect, it } from "vitest";
import {
  assertConfigWriteAllowedInCurrentMode,
  blockConfigWritesForRuntime,
} from "./nix-mode-write-guard.js";

describe("runtime config write blocks", () => {
  it("supports overlapping owners released out of order", () => {
    const restoreFirst = blockConfigWritesForRuntime("first owner");
    const restoreSecond = blockConfigWritesForRuntime("second owner");

    try {
      restoreFirst();
      expect(() => assertConfigWriteAllowedInCurrentMode({ env: {} })).toThrow("second owner");

      restoreSecond();
      expect(() => assertConfigWriteAllowedInCurrentMode({ env: {} })).not.toThrow();
    } finally {
      restoreFirst();
      restoreSecond();
    }
  });
});
