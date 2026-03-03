import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { access: fsMocks.access, realpath: fsMocks.realpath },
  access: fsMocks.access,
  realpath: fsMocks.realpath,
}));

import { resolveGatewayProgramArguments } from "./program-args.js";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  vi.resetAllMocks();
});

describe("resolveGatewayProgramArguments", () => {
  it("uses realpath-resolved dist entry when running via npx shim", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/moltbot");
    const entryPath = path.resolve("/tmp/.npm/_npx/63c3/node_modules/moltbot/dist/entry.js");
    process.argv = ["node", argv1];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === entryPath) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments).toEqual([
      process.execPath,
      entryPath,
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("prefers symlinked path over realpath for stable service config", async () => {
    // Simulates pnpm global install where node_modules/moltbot is a symlink
    // to .pnpm/moltbot@X.Y.Z/node_modules/moltbot
    const symlinkPath = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/moltbot/dist/entry.js",
    );
    const realpathResolved = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/.pnpm/moltbot@2026.1.21-2/node_modules/moltbot/dist/entry.js",
    );
    process.argv = ["node", symlinkPath];
    fsMocks.realpath.mockResolvedValue(realpathResolved);
    fsMocks.access.mockResolvedValue(undefined); // Both paths exist

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    // Should use the symlinked path, not the realpath-resolved versioned path
    expect(result.programArguments[1]).toBe(symlinkPath);
    expect(result.programArguments[1]).not.toContain("@2026.1.21-2");
    // workingDirectory should point to the symlinked package root
    expect(result.workingDirectory).toBe(
      path.resolve("/Users/test/Library/pnpm/global/5/node_modules/moltbot"),
    );
  });

  it("falls back to node_modules package dist when .bin path is not resolved", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/moltbot");
    const indexPath = path.resolve("/tmp/.npm/_npx/63c3/node_modules/moltbot/dist/index.js");
    process.argv = ["node", argv1];
    fsMocks.realpath.mockRejectedValue(new Error("no realpath"));
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === indexPath) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments).toEqual([
      process.execPath,
      indexPath,
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("sets workingDirectory to parent of dist for standard entrypoint", async () => {
    const entryPath = path.resolve("/opt/moltbot/dist/entry.js");
    process.argv = ["node", entryPath];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockResolvedValue(undefined);

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.workingDirectory).toBe(path.resolve("/opt/moltbot"));
  });

  it("sets correct workingDirectory when 'dist' appears earlier in path", async () => {
    // e.g. /mnt/distcache/apps/moltbot/dist/entry.js — "dist" in the path
    // but only the immediate parent "dist" segment should be used
    const entryPath = path.resolve("/mnt/distcache/apps/moltbot/dist/entry.js");
    process.argv = ["node", entryPath];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockResolvedValue(undefined);

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.workingDirectory).toBe(path.resolve("/mnt/distcache/apps/moltbot"));
  });

  it("returns undefined workingDirectory when entry is not directly under dist/", async () => {
    // e.g. /opt/moltbot/dist/subdir/entry.js — dist is not the immediate parent
    const entryPath = path.resolve("/opt/moltbot/dist/subdir/entry.js");
    process.argv = ["node", entryPath];
    fsMocks.realpath.mockResolvedValue(entryPath);
    fsMocks.access.mockResolvedValue(undefined);

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.workingDirectory).toBeUndefined();
  });
});
