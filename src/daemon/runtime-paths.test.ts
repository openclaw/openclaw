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
  resolveBundledNodeInfo,
  resolveBundledNodePath,
  resolvePreferredNodePath,
  resolveSystemNodeInfo,
} from "./runtime-paths.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolveBundledNodePath", () => {
  it("returns bundled node path for darwin", () => {
    const result = resolveBundledNodePath({ HOME: "/Users/test" }, "darwin");
    expect(result).toBe("/Users/test/.openclaw/tools/node/bin/node");
  });

  it("returns bundled node path for linux", () => {
    const result = resolveBundledNodePath({ HOME: "/home/test" }, "linux");
    expect(result).toBe("/home/test/.openclaw/tools/node/bin/node");
  });

  it("returns bundled node path for win32", () => {
    const result = resolveBundledNodePath({ USERPROFILE: "C:\\Users\\test" }, "win32");
    expect(result).toBe("C:\\Users\\test\\.openclaw\\tools\\node\\bin\\node.exe");
  });
});

describe("resolveBundledNodeInfo", () => {
  it("returns bundled node info when it exists and is supported", async () => {
    const bundledPath = "/Users/test/.openclaw/tools/node/bin/node";
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === bundledPath) {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockResolvedValue({ stdout: "22.22.0\n", stderr: "" });

    const result = await resolveBundledNodeInfo({
      env: { HOME: "/Users/test" },
      platform: "darwin",
      execFile,
    });

    expect(result).toEqual({
      path: bundledPath,
      version: "22.22.0",
      supported: true,
    });
  });

  it("returns null when bundled node does not exist", async () => {
    fsMocks.access.mockRejectedValue(new Error("missing"));

    const execFile = vi.fn();

    const result = await resolveBundledNodeInfo({
      env: { HOME: "/Users/test" },
      platform: "darwin",
      execFile,
    });

    expect(result).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("resolvePreferredNodePath", () => {
  const darwinNode = "/opt/homebrew/bin/node";
  const bundledNode = "/Users/test/.openclaw/tools/node/bin/node";

  it("prefers bundled node over system node", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === bundledNode || target === darwinNode) {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockResolvedValue({ stdout: "22.1.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: { HOME: "/Users/test" },
      runtime: "node",
      platform: "darwin",
      execFile,
    });

    expect(result).toBe(bundledNode);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to system node when bundled node is missing", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === darwinNode) {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockResolvedValue({ stdout: "22.1.0\n", stderr: "" });

    const result = await resolvePreferredNodePath({
      env: { HOME: "/Users/test" },
      runtime: "node",
      platform: "darwin",
      execFile,
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to system node when bundled node is too old", async () => {
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === bundledNode || target === darwinNode) {
        return;
      }
      throw new Error("missing");
    });

    const execFile = vi.fn().mockImplementation(async (nodePath: string) => {
      if (nodePath === bundledNode) {
        return { stdout: "18.0.0\n", stderr: "" };
      }
      return { stdout: "22.1.0\n", stderr: "" };
    });

    const result = await resolvePreferredNodePath({
      env: { HOME: "/Users/test" },
      runtime: "node",
      platform: "darwin",
      execFile,
    });

    expect(result).toBe(darwinNode);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("uses system node when it meets the minimum version (no bundled)", async () => {
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
