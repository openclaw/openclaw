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
    });

    expect(result).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("prefers process.execPath over system node when it is a supported version-managed node", async () => {
    const fnmNode = "/Users/me/.fnm/node-versions/v24.11.1/installation/bin/node";

    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === darwinNode || target === fnmNode) {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockImplementation(async (bin: string) => {
      if (bin === fnmNode) {
        return { stdout: "24.11.1\n", stderr: "" };
      }
      if (bin === darwinNode) {
        return { stdout: "25.5.0\n", stderr: "" };
      }
      throw new Error("not found");
    });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      processExecPath: fnmNode,
    });

    expect(result).toBe(fnmNode);
  });

  it("falls back to system node when processExecPath is not provided", async () => {
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
    });

    expect(result).toBe(darwinNode);
  });

  it("falls back to system node when processExecPath node is unsupported", async () => {
    const oldFnmNode = "/Users/me/.fnm/node-versions/v18.0.0/installation/bin/node";

    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === darwinNode || target === oldFnmNode) {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockImplementation(async (bin: string) => {
      if (bin === oldFnmNode) {
        return { stdout: "18.0.0\n", stderr: "" };
      }
      if (bin === darwinNode) {
        return { stdout: "22.12.0\n", stderr: "" };
      }
      throw new Error("not found");
    });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      processExecPath: oldFnmNode,
    });

    expect(result).toBe(darwinNode);
  });

  it("falls back to system node when processExecPath version check fails", async () => {
    const brokenNode = "/Users/me/.nvm/versions/node/v22.0.0/bin/node";

    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === darwinNode) {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockImplementation(async (bin: string) => {
      if (bin === brokenNode) {
        throw new Error("ENOENT");
      }
      if (bin === darwinNode) {
        return { stdout: "22.12.0\n", stderr: "" };
      }
      throw new Error("not found");
    });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      processExecPath: brokenNode,
    });

    expect(result).toBe(darwinNode);
  });

  it("falls back to system node when processExecPath returns empty version", async () => {
    const weirdNode = "/Users/me/.volta/bin/node";

    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === darwinNode) {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockImplementation(async (bin: string) => {
      if (bin === weirdNode) {
        return { stdout: "", stderr: "" };
      }
      if (bin === darwinNode) {
        return { stdout: "22.12.0\n", stderr: "" };
      }
      throw new Error("not found");
    });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      processExecPath: weirdNode,
    });

    expect(result).toBe(darwinNode);
  });

  it("returns undefined when runtime is not node even with processExecPath", async () => {
    const execFile = vi.fn();

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "bun",
      platform: "darwin",
      execFile,
      processExecPath: "/Users/me/.fnm/node-versions/v24.0.0/installation/bin/node",
    });

    expect(result).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("prefers processExecPath on Linux too", async () => {
    const nvmNode = "/home/user/.nvm/versions/node/v22.12.0/bin/node";

    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === "/usr/local/bin/node") {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockImplementation(async (bin: string) => {
      if (bin === nvmNode) {
        return { stdout: "22.12.0\n", stderr: "" };
      }
      if (bin === "/usr/local/bin/node") {
        return { stdout: "22.12.0\n", stderr: "" };
      }
      throw new Error("not found");
    });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "linux",
      execFile,
      processExecPath: nvmNode,
    });

    expect(result).toBe(nvmNode);
  });

  it("returns undefined when no system node is found", async () => {
    fsMocks.access.mockRejectedValue(new Error("missing"));

    const execFile = vi.fn();

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
    });

    expect(result).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
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
