import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { access: fsMocks.access },
  access: fsMocks.access,
}));

import {
  renderSystemNodeWarning,
  resolvePreferredNodePath,
  resolveSystemNodeInfo,
} from "./runtime-paths.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolvePreferredNodePath", () => {
  const darwinNode = "/opt/homebrew/bin/node";
  const fnmNode = "/Users/test/.fnm/node-versions/v24.11.1/installation/bin/node";

  it("prefers execPath (version manager node) over system node", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === darwinNode) {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockResolvedValue({ stdout: "24.11.1\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: fnmNode,
    });

    expect(result).toBe(fnmNode);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to system node when execPath version is unsupported", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === darwinNode) {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "18.0.0\n", stderr: "" }) // execPath too old
      .mockResolvedValueOnce({ stdout: "22.12.0\n", stderr: "" }); // system node ok

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: "/some/old/node",
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("ignores execPath when it is not node", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === darwinNode) {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockResolvedValue({ stdout: "22.12.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: "/Users/test/.bun/bin/bun",
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(darwinNode, ["-p", "process.versions.node"], {
      encoding: "utf8",
    });
  });

  it("uses system node when it meets the minimum version", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === darwinNode) {
        return;
      }
      throw new Error("missing");
    });

    // Node 22.12.0+ is the minimum required version
    const execFile = vi.fn().mockResolvedValue({ stdout: "22.12.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: darwinNode,
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("skips system node when it is too old", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === darwinNode) {
        return;
      }
      throw new Error("missing");
    });

    // Node 22.11.x is below minimum 22.12.0
    const execFile = vi.fn().mockResolvedValue({ stdout: "22.11.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: "",
    });

    expect(result).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when no system node is found", async () => {
    fsMocks.access.mockRejectedValue(new Error("missing"));

    const execFile = vi.fn().mockRejectedValue(new Error("not found"));

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: "",
    });

    expect(result).toBeUndefined();
  });
});

describe("resolveSystemNodeInfo", () => {
  const darwinNode = "/opt/homebrew/bin/node";

  it("returns supported info when version is new enough", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === darwinNode) {
        return;
      }
      throw new Error("missing");
    });

    // Node 22.12.0+ is the minimum required version
    const execFile = vi.fn().mockResolvedValue({ stdout: "22.12.0\n", stderr: "" });

    const result = await resolveSystemNodeInfo({
      env: {},
      platform: "darwin",
      execFile,
    });

    expect(result).toEqual({
      path: darwinNode,
      version: "22.12.0",
      supported: true,
    });
  });

  it("renders a warning when system node is too old", () => {
    const warning = renderSystemNodeWarning(
      {
        path: darwinNode,
        version: "18.19.0",
        supported: false,
      },
      "/Users/me/.fnm/node-22/bin/node",
    );

    expect(warning).toContain("below the required Node 22+");
    expect(warning).toContain(darwinNode);
  });
});
