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
  resolveStableHomebrewNodePath,
  resolveSystemNodeInfo,
} from "./runtime-paths.js";

afterEach(() => {
  vi.resetAllMocks();
});

function mockNodePathPresent(nodePath: string) {
  fsMocks.access.mockImplementation(async (target: string) => {
    if (target === nodePath) {
      return;
    }
    throw new Error("missing");
  });
}

describe("resolvePreferredNodePath", () => {
  const darwinNode = "/opt/homebrew/bin/node";
  const fnmNode = "/Users/test/.fnm/node-versions/v24.11.1/installation/bin/node";

  it("prefers execPath (version manager node) over system node", async () => {
    mockNodePathPresent(darwinNode);

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
    mockNodePathPresent(darwinNode);

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
    mockNodePathPresent(darwinNode);

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
    mockNodePathPresent(darwinNode);

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
    mockNodePathPresent(darwinNode);

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

  it("resolves Homebrew Cellar path to stable symlink (macOS)", async () => {
    mockNodePathPresent(darwinNode);

    const cellarPath = "/opt/homebrew/Cellar/node/25.5.0/bin/node";
    const execFile = vi.fn().mockResolvedValue({ stdout: "25.5.0\n", stderr: "" });
    const realpath = vi.fn().mockResolvedValue(cellarPath);

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: cellarPath,
      realpath,
    });

    expect(result).toBe(darwinNode);
  });

  it("resolves Linuxbrew Cellar path to stable symlink", async () => {
    const linuxbrewCellar = "/home/linuxbrew/.linuxbrew/Cellar/node/25.5.0/bin/node";
    const linuxbrewStable = "/home/linuxbrew/.linuxbrew/bin/node";
    const execFile = vi.fn().mockResolvedValue({ stdout: "25.5.0\n", stderr: "" });
    const realpath = vi.fn().mockResolvedValue(linuxbrewCellar);

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "linux",
      execFile,
      execPath: linuxbrewCellar,
      realpath,
    });

    expect(result).toBe(linuxbrewStable);
  });

  it("resolves keg-only node@22 Cellar path to opt symlink (macOS)", async () => {
    mockNodePathPresent(darwinNode);

    const cellarPath = "/opt/homebrew/Cellar/node@22/22.15.0/bin/node";
    const stablePath = "/opt/homebrew/opt/node@22/bin/node";
    const execFile = vi.fn().mockResolvedValue({ stdout: "22.15.0\n", stderr: "" });
    const realpath = vi.fn().mockResolvedValue(cellarPath);

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: cellarPath,
      realpath,
    });

    expect(result).toBe(stablePath);
  });

  it("keeps Cellar path when stable symlink points elsewhere", async () => {
    const cellarPath = "/opt/homebrew/Cellar/node/25.5.0/bin/node";
    const differentCellar = "/opt/homebrew/Cellar/node/25.6.0/bin/node";
    const execFile = vi.fn().mockResolvedValue({ stdout: "25.5.0\n", stderr: "" });
    const realpath = vi.fn().mockImplementation(async (p: string) => {
      if (p === "/opt/homebrew/bin/node") {
        return differentCellar; // symlink points to a different version
      }
      return p;
    });

    const result = await resolvePreferredNodePath({
      env: {},
      runtime: "node",
      platform: "darwin",
      execFile,
      execPath: cellarPath,
      realpath,
    });

    // Falls back to the original Cellar path since symlink doesn't match.
    expect(result).toBe(cellarPath);
  });
});

describe("resolveStableHomebrewNodePath", () => {
  it("returns stable symlink for macOS Homebrew Cellar path", async () => {
    const cellarPath = "/opt/homebrew/Cellar/node/25.5.0/bin/node";
    const realpath = vi.fn().mockResolvedValue(cellarPath);

    const result = await resolveStableHomebrewNodePath(cellarPath, realpath);
    expect(result).toBe("/opt/homebrew/bin/node");
  });

  it("returns stable symlink for Linuxbrew Cellar path", async () => {
    const cellarPath = "/home/linuxbrew/.linuxbrew/Cellar/node/25.5.0/bin/node";
    const realpath = vi.fn().mockResolvedValue(cellarPath);

    const result = await resolveStableHomebrewNodePath(cellarPath, realpath);
    expect(result).toBe("/home/linuxbrew/.linuxbrew/bin/node");
  });

  it("returns stable symlink for /usr/local/Cellar (macOS x86 Homebrew)", async () => {
    const cellarPath = "/usr/local/Cellar/node/25.5.0/bin/node";
    const realpath = vi.fn().mockResolvedValue(cellarPath);

    const result = await resolveStableHomebrewNodePath(cellarPath, realpath);
    expect(result).toBe("/usr/local/bin/node");
  });

  it("returns null for non-Cellar paths", async () => {
    const fnmPath = "/Users/test/.fnm/node-versions/v24.11.1/installation/bin/node";
    const realpath = vi.fn().mockResolvedValue(fnmPath);

    const result = await resolveStableHomebrewNodePath(fnmPath, realpath);
    expect(result).toBeNull();
  });

  it("returns null when stable symlink points to different version", async () => {
    const cellarPath = "/opt/homebrew/Cellar/node/25.5.0/bin/node";
    const realpath = vi.fn().mockImplementation(async (p: string) => {
      if (p === "/opt/homebrew/bin/node") {
        return "/opt/homebrew/Cellar/node/25.6.0/bin/node";
      }
      return p;
    });

    const result = await resolveStableHomebrewNodePath(cellarPath, realpath);
    expect(result).toBeNull();
  });

  it("returns null when stable symlink is broken", async () => {
    const cellarPath = "/opt/homebrew/Cellar/node/25.5.0/bin/node";
    const realpath = vi.fn().mockImplementation(async (p: string) => {
      if (p === "/opt/homebrew/bin/node") {
        throw new Error("ENOENT");
      }
      return p;
    });

    const result = await resolveStableHomebrewNodePath(cellarPath, realpath);
    expect(result).toBeNull();
  });

  it("returns opt/<formula>/bin/node for keg-only node@22 install", async () => {
    const cellarPath = "/opt/homebrew/Cellar/node@22/22.15.0/bin/node";
    const realpath = vi.fn().mockResolvedValue(cellarPath);

    const result = await resolveStableHomebrewNodePath(cellarPath, realpath);
    expect(result).toBe("/opt/homebrew/opt/node@22/bin/node");
  });

  it("returns opt/<formula>/bin/node for Linuxbrew keg-only node@20", async () => {
    const cellarPath = "/home/linuxbrew/.linuxbrew/Cellar/node@20/20.18.0/bin/node";
    const realpath = vi.fn().mockResolvedValue(cellarPath);

    const result = await resolveStableHomebrewNodePath(cellarPath, realpath);
    expect(result).toBe("/home/linuxbrew/.linuxbrew/opt/node@20/bin/node");
  });

  it("returns null for keg-only install when stable symlink diverges", async () => {
    const cellarPath = "/opt/homebrew/Cellar/node@22/22.15.0/bin/node";
    const realpath = vi.fn().mockImplementation(async (p: string) => {
      if (p === "/opt/homebrew/opt/node@22/bin/node") {
        return "/opt/homebrew/Cellar/node@22/22.16.0/bin/node";
      }
      return p;
    });

    const result = await resolveStableHomebrewNodePath(cellarPath, realpath);
    expect(result).toBeNull();
  });
});

describe("resolveSystemNodeInfo", () => {
  const darwinNode = "/opt/homebrew/bin/node";

  it("returns supported info when version is new enough", async () => {
    mockNodePathPresent(darwinNode);

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

  it("returns undefined when system node is missing", async () => {
    fsMocks.access.mockRejectedValue(new Error("missing"));
    const execFile = vi.fn();
    const result = await resolveSystemNodeInfo({ env: {}, platform: "darwin", execFile });
    expect(result).toBeNull();
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
