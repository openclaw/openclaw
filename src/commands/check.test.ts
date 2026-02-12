import { describe, it, expect } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  checkCommand,
  checkNodeVersion,
  checkPnpmVersion,
  parseVersion,
  compareVersions,
} from "./check.js";

describe("check command", () => {
  it("should run installation checks and return results", async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const mockRuntime: RuntimeEnv = {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
      debug: () => {},
      warn: () => {},
      exit: (_code?: number) => {},
      channelLog: () => {},
    };

    await checkCommand(mockRuntime, { json: true });

    // Should output JSON results
    expect(logs.length).toBe(1);
    const result = JSON.parse(logs[0]);
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);

    // Should have expected check IDs
    const checkIds = result.checks.map((c: { id: string }) => c.id);
    expect(checkIds).toContain("node-version");
    expect(checkIds).toContain("pnpm-version");
    expect(checkIds).toContain("config-exists");
    expect(checkIds).toContain("config-valid");
    expect(checkIds).toContain("gateway-mode");
    expect(checkIds).toContain("package-root");
  });

  it("should output JSON when json option is true", async () => {
    const logs: string[] = [];

    const mockRuntime: RuntimeEnv = {
      log: (msg: string) => logs.push(msg),
      error: () => {},
      debug: () => {},
      warn: () => {},
      exit: () => {},
      channelLog: () => {},
    };

    await checkCommand(mockRuntime, { json: true });

    expect(logs.length).toBe(1);
    const result = JSON.parse(logs[0]);
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.checks)).toBe(true);
  });

  it("should handle non-interactive mode", async () => {
    const logs: string[] = [];

    const mockRuntime: RuntimeEnv = {
      log: (msg: string) => logs.push(msg),
      error: () => {},
      debug: () => {},
      warn: () => {},
      exit: () => {},
      channelLog: () => {},
    };

    await checkCommand(mockRuntime, { json: true, nonInteractive: true });

    // Should still output results
    expect(logs.length).toBe(1);
    const result = JSON.parse(logs[0]);
    expect(typeof result.ok).toBe("boolean");
  });
});

describe("parseVersion", () => {
  it("should parse valid version strings", () => {
    expect(parseVersion("22.12.0")).toEqual([22, 12, 0]);
    expect(parseVersion("v22.12.0")).toEqual([22, 12, 0]);
    expect(parseVersion("10.23.0")).toEqual([10, 23, 0]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });

  it("should return null for invalid version strings", () => {
    expect(parseVersion("invalid")).toBeNull();
    expect(parseVersion("a.b.c")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("should return 0 for equal versions", () => {
    expect(compareVersions([22, 12, 0], [22, 12, 0])).toBe(0);
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it("should return positive when first version is greater", () => {
    expect(compareVersions([23, 0, 0], [22, 12, 0])).toBeGreaterThan(0);
    expect(compareVersions([22, 13, 0], [22, 12, 0])).toBeGreaterThan(0);
    expect(compareVersions([22, 12, 1], [22, 12, 0])).toBeGreaterThan(0);
  });

  it("should return negative when first version is smaller", () => {
    expect(compareVersions([21, 0, 0], [22, 12, 0])).toBeLessThan(0);
    expect(compareVersions([22, 11, 0], [22, 12, 0])).toBeLessThan(0);
    expect(compareVersions([22, 12, 0], [22, 12, 1])).toBeLessThan(0);
  });

  it("should handle different length versions", () => {
    expect(compareVersions([22, 12], [22, 12, 0])).toBe(0);
    expect(compareVersions([22, 12, 0], [22, 12])).toBe(0);
    expect(compareVersions([22, 12, 0, 1], [22, 12, 0])).toBeGreaterThan(0);
  });
});

describe("checkNodeVersion", () => {
  it("should return current Node.js version", () => {
    const result = checkNodeVersion();
    expect(typeof result.ok).toBe("boolean");
    expect(result.current).toBe(process.version);
    expect(result.required).toBe("22.12.0");
  });
});

describe("checkPnpmVersion", () => {
  it("should check pnpm version", () => {
    const result = checkPnpmVersion();
    // Should have ok property
    expect(typeof result.ok).toBe("boolean");
    // Should have required version
    expect(result.required).toBe("10.23.0");

    if (result.ok) {
      // If check passes, we should have a current version
      expect(result.current).toBeTruthy();
      expect(typeof result.current).toBe("string");
    }
  });
});
