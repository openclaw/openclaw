import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let isContainerEnvironment: typeof import("./container-environment.js").isContainerEnvironment;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("FLY_MACHINE_ID", undefined);
  vi.stubEnv("FLY_APP_NAME", undefined);
  ({ isContainerEnvironment } = await import("./container-environment.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mockCgroup(contents: string) {
  vi.spyOn(fs, "accessSync").mockImplementation(() => {
    throw new Error("ENOENT");
  });
  return vi.spyOn(fs, "readFileSync").mockReturnValue(contents);
}

describe("isContainerEnvironment", () => {
  it("returns true when /run/.containerenv exists", () => {
    vi.spyOn(fs, "accessSync").mockImplementation((filePath: unknown) => {
      if (filePath === "/run/.containerenv") {
        return undefined;
      }
      throw new Error("ENOENT");
    });
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true on Fly Machines without Docker sentinel files", () => {
    mockCgroup("10:cpuset:/\n9:perf_event:/\n8:memory:/\n0::/\n");
    vi.stubEnv("FLY_MACHINE_ID", "3d8d5459a03038");
    vi.stubEnv("FLY_APP_NAME", "openclaw-test");
    expect(isContainerEnvironment()).toBe(true);
  });

  it.each([
    ["12:memory:/user.slice\n", false],
    ["12:memory:/docker/abc123def456\n", true],
  ] as const)("detects and caches cgroup %s as %s", (contents, expected) => {
    const readCgroup = mockCgroup(contents);
    expect(isContainerEnvironment()).toBe(expected);
    expect(isContainerEnvironment()).toBe(expected);
    expect(readCgroup).toHaveBeenCalledOnce();
  });
});
