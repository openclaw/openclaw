import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  realpath: vi.fn(),
}));

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { access: fsMocks.access, realpath: fsMocks.realpath },
  access: fsMocks.access,
  realpath: fsMocks.realpath,
}));

vi.mock("node:child_process", () => ({
  execFileSync: childProcessMocks.execFileSync,
}));

import { resolveGatewayProgramArguments } from "./program-args.js";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  childProcessMocks.execFileSync.mockReset();
  vi.resetAllMocks();
});

describe("resolveGatewayProgramArguments", () => {
  it("prefers invoking CLI entrypoint over unrelated PATH openclaw", async () => {
    const globalBin = path.resolve("/Users/test/Library/pnpm/global/5/node_modules/.bin/openclaw");
    const globalSymlinkEntrypoint = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
    );
    const invokedEntrypoint = path.resolve("/tmp/dev/openclaw/dist/entry.js");
    process.argv = ["node", invokedEntrypoint];
    childProcessMocks.execFileSync.mockReturnValue(`${globalBin}\n`);
    fsMocks.realpath.mockImplementation(async (target: string) => {
      if (target === globalBin) {
        return globalBin;
      }
      return target;
    });
    fsMocks.access.mockImplementation(async (target: string) => {
      if (
        target === invokedEntrypoint ||
        target === globalSymlinkEntrypoint ||
        target === globalBin
      ) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments[1]).toBe(invokedEntrypoint);
  });

  it("prefers stable global symlink when it matches invoking install", async () => {
    const globalBin = path.resolve("/Users/test/Library/pnpm/global/5/node_modules/.bin/openclaw");
    const globalSymlinkEntrypoint = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
    );
    const invokedRealpath = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/.pnpm/openclaw@2026.1.21-2/node_modules/openclaw/dist/index.js",
    );
    process.argv = ["node", invokedRealpath];
    childProcessMocks.execFileSync.mockReturnValue(`${globalBin}\n`);
    fsMocks.realpath.mockImplementation(async (target: string) => {
      if (target === globalBin) {
        return globalBin;
      }
      if (target === globalSymlinkEntrypoint) {
        return invokedRealpath;
      }
      if (target === invokedRealpath) {
        return invokedRealpath;
      }
      return target;
    });
    fsMocks.access.mockImplementation(async (target: string) => {
      if (
        target === invokedRealpath ||
        target === globalSymlinkEntrypoint ||
        target === globalBin
      ) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments[1]).toBe(globalSymlinkEntrypoint);
    expect(result.programArguments[1]).not.toContain("@2026.1.21-2");
  });

  it("uses realpath-resolved dist entry when running via npx shim", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/openclaw");
    const entryPath = path.resolve("/tmp/.npm/_npx/63c3/node_modules/openclaw/dist/entry.js");
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

  it("keeps npx entrypoint when PATH openclaw points to a different install", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/openclaw");
    const npxEntrypoint = path.resolve("/tmp/.npm/_npx/63c3/node_modules/openclaw/dist/entry.js");
    const globalBin = path.resolve("/Users/test/Library/pnpm/global/5/node_modules/.bin/openclaw");
    const globalSymlinkEntrypoint = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
    );

    process.argv = ["node", argv1];
    childProcessMocks.execFileSync.mockReturnValue(`${globalBin}\n`);
    fsMocks.realpath.mockImplementation(async (target: string) => {
      if (target === argv1) {
        return npxEntrypoint;
      }
      return target;
    });
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === npxEntrypoint || target === globalBin || target === globalSymlinkEntrypoint) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments[1]).toBe(npxEntrypoint);
    expect(result.programArguments[1]).not.toBe(globalSymlinkEntrypoint);
  });

  it("throws invoking CLI error instead of silently falling back to PATH openclaw", async () => {
    const argv1 = path.resolve("/tmp/dev/openclaw/src/index.ts");
    const globalBin = path.resolve("/Users/test/Library/pnpm/global/5/node_modules/.bin/openclaw");
    const globalSymlinkEntrypoint = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
    );

    process.argv = ["node", argv1];
    childProcessMocks.execFileSync.mockReturnValue(`${globalBin}\n`);
    fsMocks.realpath.mockImplementation(async (target: string) => target);
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === globalBin || target === globalSymlinkEntrypoint) {
        return;
      }
      throw new Error("missing");
    });

    await expect(resolveGatewayProgramArguments({ port: 18789 })).rejects.toThrow(
      /Cannot find built CLI/,
    );
    expect(childProcessMocks.execFileSync).not.toHaveBeenCalled();
  });

  it("prefers symlinked path over realpath for stable service config", async () => {
    // Simulates pnpm global install where node_modules/openclaw is a symlink
    // to .pnpm/openclaw@X.Y.Z/node_modules/openclaw
    const symlinkPath = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/entry.js",
    );
    const realpathResolved = path.resolve(
      "/Users/test/Library/pnpm/global/5/node_modules/.pnpm/openclaw@2026.1.21-2/node_modules/openclaw/dist/entry.js",
    );
    process.argv = ["node", symlinkPath];
    fsMocks.realpath.mockResolvedValue(realpathResolved);
    fsMocks.access.mockResolvedValue(undefined); // Both paths exist

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    // Should use the symlinked path, not the realpath-resolved versioned path
    expect(result.programArguments[1]).toBe(symlinkPath);
    expect(result.programArguments[1]).not.toContain("@2026.1.21-2");
  });

  it("falls back to node_modules package dist when .bin path is not resolved", async () => {
    const argv1 = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/openclaw");
    const indexPath = path.resolve("/tmp/.npm/_npx/63c3/node_modules/openclaw/dist/index.js");
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
});
