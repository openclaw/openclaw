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
    process.argv = ["node", "/tmp/.npm/_npx/63c3/node_modules/.bin/clawdbot"];
    fsMocks.realpath.mockResolvedValue(
      "/tmp/.npm/_npx/63c3/node_modules/clawdbot/dist/entry.js",
    );
    fsMocks.access.mockImplementation(async (target: string) => {
      if (
        target === "/tmp/.npm/_npx/63c3/node_modules/clawdbot/dist/entry.js"
      ) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments).toEqual([
      process.execPath,
      "/tmp/.npm/_npx/63c3/node_modules/clawdbot/dist/entry.js",
      "gateway-daemon",
      "--port",
      "18789",
    ]);
  });

  it("falls back to node_modules package dist when .bin path is not resolved", async () => {
    process.argv = ["node", "/tmp/.npm/_npx/63c3/node_modules/.bin/clawdbot"];
    fsMocks.realpath.mockRejectedValue(new Error("no realpath"));
    fsMocks.access.mockImplementation(async (target: string) => {
      if (
        target === "/tmp/.npm/_npx/63c3/node_modules/clawdbot/dist/index.js"
      ) {
        return;
      }
      throw new Error("missing");
    });

    const result = await resolveGatewayProgramArguments({ port: 18789 });

    expect(result.programArguments).toEqual([
      process.execPath,
      "/tmp/.npm/_npx/63c3/node_modules/clawdbot/dist/index.js",
      "gateway-daemon",
      "--port",
      "18789",
    ]);
  });
});
