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

import {
  resolveCurrentCliProgramArguments,
  resolveGatewayProgramArguments,
} from "./program-args.js";

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
});

describe("resolveCurrentCliProgramArguments", () => {
  it("omits argv[1] when the current process is already the CLI binary", async () => {
    process.argv = ["/usr/local/bin/openclaw", "gateway"];

    const result = await resolveCurrentCliProgramArguments([
      "--profile",
      "work",
      "doctor",
      "--repair",
      "--non-interactive",
    ]);

    expect(result).toEqual([
      process.execPath,
      "--profile",
      "work",
      "doctor",
      "--repair",
      "--non-interactive",
    ]);
    expect(fsMocks.access).not.toHaveBeenCalled();
  });

  it("keeps a source entrypoint when no built dist entry exists", async () => {
    const devEntrypoint = path.resolve("/workspaces/openclaw/src/index.ts");
    process.argv = ["/usr/local/bin/bun", devEntrypoint];
    fsMocks.realpath.mockResolvedValue(devEntrypoint);
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === devEntrypoint) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveCurrentCliProgramArguments([
      "--profile",
      "work",
      "doctor",
      "--repair",
      "--non-interactive",
    ]);

    expect(result).toEqual([
      process.execPath,
      devEntrypoint,
      "--profile",
      "work",
      "doctor",
      "--repair",
      "--non-interactive",
    ]);
  });

  it("keeps a relative source entrypoint when no built dist entry exists", async () => {
    process.argv = ["/usr/local/bin/bun", "src/index.ts"];
    const normalizedEntrypoint = path.resolve("src/index.ts");
    fsMocks.realpath.mockResolvedValue(normalizedEntrypoint);
    fsMocks.access.mockImplementation(async (target: string) => {
      if (target === normalizedEntrypoint) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveCurrentCliProgramArguments([
      "--profile",
      "work",
      "doctor",
      "--repair",
      "--non-interactive",
    ]);

    expect(result).toEqual([
      process.execPath,
      normalizedEntrypoint,
      "--profile",
      "work",
      "doctor",
      "--repair",
      "--non-interactive",
    ]);
  });

  it("still fails for non-source path entrypoints without a built CLI", async () => {
    const npxShim = path.resolve("/tmp/.npm/_npx/63c3/node_modules/.bin/openclaw");
    process.argv = ["/usr/local/bin/node", npxShim];
    fsMocks.realpath.mockResolvedValue(npxShim);
    fsMocks.access.mockRejectedValue(new Error("missing"));

    await expect(
      resolveCurrentCliProgramArguments([
        "--profile",
        "work",
        "doctor",
        "--repair",
        "--non-interactive",
      ]),
    ).rejects.toThrow('Run "pnpm build" first, or use dev mode.');
  });
});
