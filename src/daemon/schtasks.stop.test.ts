import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stopScheduledTask } from "./schtasks.js";

const schtasksCalls: string[][] = [];

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[]) => {
    schtasksCalls.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  },
}));

const killedPids: { pid: number; graceMs?: number }[] = [];

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: (pid: number, opts?: { graceMs?: number }) => {
    killedPids.push({ pid, graceMs: opts?.graceMs });
  },
}));

let portUsageMock: {
  port: number;
  status: string;
  listeners: { pid?: number; command?: string }[];
  hints: string[];
} = { port: 18789, status: "free", listeners: [], hints: [] };

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortUsage: async (_port: number) => portUsageMock,
}));

beforeEach(() => {
  schtasksCalls.length = 0;
  killedPids.length = 0;
  portUsageMock = { port: 18789, status: "free", listeners: [], hints: [] };
});

describe("stopScheduledTask", () => {
  it("terminates gateway process listening on the configured port after schtasks /End", async () => {
    portUsageMock = {
      port: 18789,
      status: "busy",
      listeners: [{ pid: 12345, command: "node.exe" }],
      hints: [],
    };

    const stdout = new PassThrough();
    await stopScheduledTask({
      stdout,
      env: { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "default" },
    });

    // Should call schtasks /Query (availability check) then /End
    expect(schtasksCalls[0]).toEqual(["/Query"]);
    expect(schtasksCalls[1]).toEqual(["/End", "/TN", "OpenClaw Gateway"]);

    // Should kill the gateway process found on the port
    expect(killedPids).toEqual([{ pid: 12345, graceMs: 2000 }]);
  });

  it("uses OPENCLAW_GATEWAY_PORT from env when set", async () => {
    portUsageMock = {
      port: 9999,
      status: "busy",
      listeners: [{ pid: 54321, command: "node.exe" }],
      hints: [],
    };

    const stdout = new PassThrough();
    await stopScheduledTask({
      stdout,
      env: {
        USERPROFILE: "C:\\Users\\test",
        OPENCLAW_PROFILE: "default",
        OPENCLAW_GATEWAY_PORT: "9999",
      },
    });

    expect(killedPids).toEqual([{ pid: 54321, graceMs: 2000 }]);
  });

  it("does not kill any process when port is free", async () => {
    portUsageMock = {
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    };

    const stdout = new PassThrough();
    await stopScheduledTask({
      stdout,
      env: { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "default" },
    });

    expect(killedPids).toEqual([]);
  });

  it("does not kill listeners without a valid pid", async () => {
    portUsageMock = {
      port: 18789,
      status: "busy",
      listeners: [{ command: "node.exe" }],
      hints: [],
    };

    const stdout = new PassThrough();
    await stopScheduledTask({
      stdout,
      env: { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "default" },
    });

    expect(killedPids).toEqual([]);
  });
});
