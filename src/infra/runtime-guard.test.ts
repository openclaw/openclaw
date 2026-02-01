import { describe, expect, it, vi } from "vitest";
import {
  assertSupportedRuntime,
  detectRuntime,
  isAtLeast,
  parseSemver,
  type RuntimeDetails,
  runtimeSatisfies,
} from "./runtime-guard.js";

describe("runtime-guard", () => {
  it("parses semver with or without leading v", () => {
    expect(parseSemver("v22.1.3")).toEqual({ major: 22, minor: 1, patch: 3 });
    expect(parseSemver("1.3.0")).toEqual({ major: 1, minor: 3, patch: 0 });
    expect(parseSemver("invalid")).toBeNull();
  });

  it("compares versions correctly", () => {
    expect(isAtLeast({ major: 22, minor: 0, patch: 0 }, { major: 22, minor: 0, patch: 0 })).toBe(
      true,
    );
    expect(isAtLeast({ major: 22, minor: 1, patch: 0 }, { major: 22, minor: 0, patch: 0 })).toBe(
      true,
    );
    expect(isAtLeast({ major: 21, minor: 9, patch: 0 }, { major: 22, minor: 0, patch: 0 })).toBe(
      false,
    );
  });

  it("validates runtime thresholds", () => {
    const nodeOk: RuntimeDetails = {
      kind: "node",
      version: "22.0.0",
      execPath: "/usr/bin/node",
      pathEnv: "/usr/bin",
    };
    const nodeOld: RuntimeDetails = { ...nodeOk, version: "21.9.0" };
    const unknown: RuntimeDetails = {
      kind: "unknown",
      version: null,
      execPath: null,
      pathEnv: "/usr/bin",
    };
    expect(runtimeSatisfies(nodeOk)).toBe(true);
    expect(runtimeSatisfies(nodeOld)).toBe(false);
    expect(runtimeSatisfies(unknown)).toBe(false);
  });

  it("throws via exit when runtime is too old", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    const details: RuntimeDetails = {
      kind: "node",
      version: "20.0.0",
      execPath: "/usr/bin/node",
      pathEnv: "/usr/bin",
    };
    expect(() => assertSupportedRuntime(runtime, details)).toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("requires Node"));
  });

  it("returns silently when runtime meets requirements", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const details: RuntimeDetails = {
      ...detectRuntime(),
      kind: "node",
      version: "22.0.0",
      execPath: "/usr/bin/node",
    };
    expect(() => assertSupportedRuntime(runtime, details)).not.toThrow();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
