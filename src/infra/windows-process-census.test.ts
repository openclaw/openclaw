import { ProcSafeError } from "@openclaw/proc-safe/errors";
import type { ProcessSnapshot } from "@openclaw/proc-safe/inspect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const { list, identity, spawn, pin } = vi.hoisted(() => ({
  list: vi.fn(),
  identity: vi.fn(),
  spawn: vi.fn(),
  pin: vi.fn(),
}));
vi.mock("@openclaw/proc-safe/windows-job", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/windows-job")>()),
  PinnedProcess: { open: pin },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawn,
}));
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessIdentity: identity,
}));
vi.mock("@openclaw/proc-safe/inspect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/inspect")>()),
  listProcesses: list,
}));
import { readWindowsProcessCensus } from "./windows-process-census.js";
import { readWindowsUserSid } from "./windows-user-sid.js";

beforeEach(() => {
  list.mockReset();
  identity.mockReset().mockReturnValue(null);
  spawn.mockReset();
  pin.mockReset().mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

function processIdentity(startTimeMicros: number, exited = false) {
  return { pid: 12, parentPid: 100, startTimeMicros, startTimeResolutionMicros: 1, exited };
}

it("preserves command facts and the existing millisecond start identity", () => {
  const command = {
    executable: "C:\\node.exe",
    argv: ["node", "worker.js"],
    commandLine: 'node "C:\\retained runtime\\worker.js" --run=run-123',
    cwd: "C:\\retained runtime\\工作",
    environment: {},
  };
  list.mockReturnValue([
    { pid: 12, owner: "same", identity: processIdentity(1_725_526_400_000_999), command },
  ] satisfies ProcessSnapshot[]);
  expect(readWindowsProcessCensus(15_000)).toEqual([
    {
      pid: 12,
      parentPid: 100,
      startIdentity: "1725526400000",
      executable: command.executable,
      commandLine: command.commandLine,
      cwd: command.cwd,
    },
  ]);
  expect(list).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 15_000, includeCommand: true });
});

it("reads an opaque process image from an identity-matched limited-query handle", () => {
  const dispose = vi.fn();
  list.mockReturnValue([{ pid: 12, owner: "same", identity: processIdentity(300_000) }]);
  pin.mockReturnValue({
    imagePath: "C:\\Windows\\DefenderSessionHelper.exe",
    [Symbol.dispose]: dispose,
  });
  expect(readWindowsProcessCensus(1_000)).toEqual([
    {
      pid: 12,
      parentPid: 100,
      startIdentity: "300",
      executable: "C:\\Windows\\DefenderSessionHelper.exe",
    },
  ]);
  expect(pin).toHaveBeenCalledWith(12, {
    access: "observe",
    expect: { startTimeMicros: 300_000 },
  });
  expect(dispose).toHaveBeenCalledOnce();
  pin.mockImplementation(() => {
    throw new ProcSafeError("access-denied", "denied");
  });
  expect(readWindowsProcessCensus(1_000)).toEqual([
    { pid: 12, parentPid: 100, startIdentity: "300" },
  ]);
});

it.each(["same", "different", "unknown"] as const)(
  "retains denied identity and command facts for %s owners",
  (owner) => {
    list.mockReturnValue([{ pid: 12, owner }] satisfies ProcessSnapshot[]);
    expect(readWindowsProcessCensus(1_000)).toEqual([
      { pid: 12, ...(owner === "different" ? { foreignOwner: true } : {}) },
    ]);
  },
);

it.each(["access-denied", "layout-mismatch", "operation-failed"] as const)(
  "distinguishes native %s from an unrelated inaccessible process",
  (code) => {
    list.mockReturnValue([{ pid: 12, owner: "unknown" }]);
    identity.mockImplementation(() => {
      throw new ProcSafeError(code, "Unreadable process");
    });
    expect(readWindowsProcessCensus(1_000)).toEqual([
      { pid: 12, ...(code === "access-denied" ? { accessDenied: true } : {}) },
    ]);
  },
);

it.each([
  { status: 0, stdout: "S-1-5-21-100\r\n", expected: "S-1-5-21-100" },
  { status: 1, stdout: "S-1-5-21-100", expected: undefined },
  { status: 0, stdout: "unresolved account", expected: undefined },
])("reads the launching token SID ($status, $stdout)", ({ status, stdout, expected }) => {
  mockProcessPlatform("win32");
  spawn.mockReturnValue({ status, stdout });
  expect(readWindowsUserSid()).toBe(expected);
});

it("omits only kernel processes and proven exited identities", () => {
  list.mockReturnValue([
    { pid: 0, owner: "unknown" },
    { pid: 4, owner: "unknown" },
    { pid: 12, owner: "unknown", identity: processIdentity(1_725_526_400_000_999, true) },
    { pid: 13, owner: "unknown" },
  ] satisfies ProcessSnapshot[]);
  expect(readWindowsProcessCensus(1_000)).toEqual([{ pid: 13 }]);
});

it.each(["incomplete", "timeout", "helper-unavailable"] as const)(
  "propagates %s instead of claiming an empty census",
  (code) => {
    const error = new ProcSafeError(code, "Census failed");
    list.mockImplementation(() => {
      throw error;
    });
    expect(() => readWindowsProcessCensus(1_000)).toThrow(error);
  },
);
