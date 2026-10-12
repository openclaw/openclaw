import { ProcSafeError } from "@openclaw/proc-safe/errors";
import type { ProcessSnapshot } from "@openclaw/proc-safe/inspect";
import { beforeEach, expect, it, vi } from "vitest";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@openclaw/proc-safe/inspect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/inspect")>()),
  listProcesses: list,
}));
import { readWindowsProcessCensus } from "./windows-process-census.js";

beforeEach(() => {
  list.mockReset();
});

it("preserves command facts and the existing millisecond start identity", () => {
  list.mockReturnValue([
    {
      pid: 12,
      owner: "same",
      identity: {
        pid: 12,
        parentPid: 100,
        startTimeMicros: 1_725_526_400_000_999,
        startTimeResolutionMicros: 1,
        exited: false,
      },
      command: {
        executable: "C:\\node.exe",
        argv: ["node", "worker.js"],
        commandLine: 'node "C:\\retained runtime\\worker.js" --run=run-123',
        cwd: "C:\\retained runtime\\工作",
        environment: {},
      },
    },
  ] satisfies ProcessSnapshot[]);
  expect(readWindowsProcessCensus(15_000)).toEqual([
    {
      pid: 12,
      parentPid: 100,
      startIdentity: "1725526400000",
      commandLine: 'node "C:\\retained runtime\\worker.js" --run=run-123',
      cwd: "C:\\retained runtime\\工作",
    },
  ]);
  expect(list).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 15_000, includeCommand: true });
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

it("omits only kernel processes and proven exited identities", () => {
  list.mockReturnValue([
    { pid: 0, owner: "unknown" },
    { pid: 4, owner: "unknown" },
    {
      pid: 12,
      owner: "unknown",
      identity: {
        pid: 12,
        parentPid: 100,
        startTimeMicros: 1_725_526_400_000_999,
        startTimeResolutionMicros: 1,
        exited: true,
      },
    },
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
