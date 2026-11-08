import { describe, expect, it } from "vitest";
import {
  formatChildRuntimeSpawnWarning,
  formatMissingChildRuntimeWarning,
  readChildRuntimeViability,
} from "./child-runtime-viability.ts";

const removedCellarPath = "/opt/homebrew/Cellar/node@24/24.20.0/bin/node";

describe("child runtime viability", () => {
  it.each([
    { path: "/missing-user-command", code: "ENOENT" },
    { path: process.execPath, code: "ENOENT" },
    { path: process.execPath, code: "EACCES" },
  ])("does not mislabel a command, cwd, or permission failure: $path $code", (fields) => {
    expect(
      formatChildRuntimeSpawnWarning(Object.assign(new Error("spawn failed"), fields)),
    ).toBeUndefined();
  });
  it.each([
    { execPath: removedCellarPath, code: "ENOENT", available: false },
    { execPath: process.execPath, code: undefined, available: true },
    { execPath: "/fixture/restricted-node", code: "EACCES", available: true },
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
        : `The Node.js runtime this Gateway started with (${removedCellarPath}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`,
    );
  });
});
