import os from "node:os";
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

vi.mock("node:fs", () => ({
  constants: { X_OK: 1 },
}));

import { resolveGatewayProgramArguments } from "./program-args.js";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  vi.resetAllMocks();
});

describe("resolveGatewayProgramArguments", () => {
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

  it("prefers wrapper script over pnpm global store path for stable service config", async () => {
    // Simulates pnpm global install where the CLI runs directly from the store path
    // (not via symlink). The wrapper script at ~/.local/bin/openclaw should be preferred
    // because pnpm regenerates it automatically during updates.
    const home = os.homedir();
    const pnpmStorePath = path.resolve(
      `${home}/.local/share/pnpm/5/.pnpm/openclaw@2026.2.6-3_abc123/node_modules/openclaw/openclaw.mjs`,
    );
    const wrapperPath = path.resolve(`${home}/.local/bin/openclaw`);
    process.argv = ["node", pnpmStorePath];
    fsMocks.realpath.mockResolvedValue(pnpmStorePath);
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === pnpmStorePath || target === wrapperPath) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    // Should use the wrapper script, not the versioned pnpm store path
    expect(result.programArguments[1]).toBe(wrapperPath);
    expect(result.programArguments[1]).not.toContain(".pnpm");
    expect(result.programArguments[1]).not.toContain("@2026.2.6-3");
  });

  it("falls back to pnpm store dist path when wrapper is not found", async () => {
    // If the wrapper script doesn't exist, fall back to the store path
    const home = os.homedir();
    const pnpmStoreDistPath = path.resolve(
      `${home}/.local/share/pnpm/5/.pnpm/openclaw@2026.2.6-3_abc123/node_modules/openclaw/dist/entry.mjs`,
    );
    process.argv = ["node", pnpmStoreDistPath];
    fsMocks.realpath.mockResolvedValue(pnpmStoreDistPath);
    fsMocks.access.mockImplementation(async (target: string) => {
      // Only the store dist path exists, wrapper is missing
      if (target === pnpmStoreDistPath) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    // Should fall back to the store path since wrapper doesn't exist
    expect(result.programArguments[1]).toBe(pnpmStoreDistPath);
  });
});
