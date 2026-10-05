import { describe, expect, it } from "vitest";
import {
  formatMissingChildRuntimeWarning,
  readChildRuntimeViability,
} from "./child-runtime-viability.ts";

const removedCellarPath = "/opt/homebrew/Cellar/node@24/24.20.0/bin/node";

describe("child runtime viability", () => {
  it.each([
    { execPath: removedCellarPath, code: "ENOENT", available: false },
    { execPath: process.execPath, code: undefined, available: true },
    { execPath: removedCellarPath, code: "EACCES", available: true },
  ])("classifies executable access $code", ({ execPath, code, available }) => {
    const viability = readChildRuntimeViability({
      execPath,
      access: () => {
        if (code) {
          throw Object.assign(new Error(code), { code });
        }
      },
    });
    expect(viability).toEqual({ execPath, available });
    expect(formatMissingChildRuntimeWarning(viability)).toBe(
      available
        ? undefined
        : `Gateway runtime is stale after Node upgrade: child workers are using ${removedCellarPath}, which no longer exists. Restart the Gateway.`,
    );
  });
});
