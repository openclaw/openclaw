import { spawnSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { readWindowsProcessSnapshot } from "./schtasks-process-snapshot.js";
import {
  listScheduledTasks,
  probeScheduledTaskExists,
  probeScheduledTaskState,
  ScheduledTaskInspectionError,
} from "./schtasks-state-probe.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

beforeEach(() => vi.mocked(spawnSync).mockReset());

function nativeResult(stdout = "", status: number | null = 0, error?: Error) {
  return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status, signal: null, error };
}

it("returns an unknown result when PowerShell execution is denied", () => {
  vi.mocked(spawnSync).mockImplementationOnce(() => {
    throw Object.assign(new Error("spawnSync powershell.exe ERR_ACCESS_DENIED"), {
      code: "ERR_ACCESS_DENIED",
    });
  });

  expect(probeScheduledTaskState("OpenClaw Gateway")).toEqual({
    status: "unknown",
    detail: "spawnSync powershell.exe ERR_ACCESS_DENIED",
    diagnostic: { kind: "spawn" },
  });
});

it.each([false, true])(
  "reads native action metadata without a hidden console (inventory=%s)",
  (inventory) => {
    const snapshot = {
      taskPath: "\\Ops\\Backup 任务",
      state: 1,
      enabled: false,
      actions: [
        {
          type: 0,
          path: "C:\\Services\\Backup\\gateway.cmd",
          arguments: "literal argument",
          workingDirectory: "C:\\Services\\Backup",
        },
      ],
    };
    vi.mocked(spawnSync).mockImplementation((_command, _args, options) =>
      options?.windowsHide === true
        ? nativeResult("", 2)
        : nativeResult(JSON.stringify(inventory ? [snapshot] : snapshot)),
    );
    expect(inventory ? listScheduledTasks() : probeScheduledTaskState(snapshot.taskPath)).toEqual(
      inventory ? [snapshot] : { status: "found", ...snapshot },
    );
    expect(spawnSync).toHaveBeenCalledTimes(1);
  },
);

it("explains an empty exit-2 result", () => {
  vi.mocked(spawnSync).mockReturnValue(nativeResult(" \r\n", 2));
  expect(probeScheduledTaskState("OpenClaw Gateway")).toEqual({
    status: "unknown",
    detail: "Scheduled Task probe failed (exit 2): no output from PowerShell.",
    diagnostic: { kind: "native", exitCode: 2 },
  });
});

it.each([
  { budget: undefined, expected: 60_000, inventory: false },
  { budget: 899.75, expected: 899, inventory: false },
  { budget: 0.75, expected: 0, inventory: false },
  { budget: Number.NaN, expected: 0, inventory: false },
  { budget: 47_000, expected: 47_000, inventory: true },
])(
  "bounds native inspection to $expected ms (inventory=$inventory)",
  ({ budget, expected, inventory }) => {
    vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
      const timeout = options?.timeout;
      // Node rejects fractional timeouts before native spawn.
      if (timeout != null && !(Number.isInteger(timeout) && timeout >= 0)) {
        throw Object.assign(new RangeError("timeout must be an unsigned integer"), {
          code: "ERR_OUT_OF_RANGE",
        });
      }
      return expected === 0
        ? nativeResult("-2147024894", 1)
        : nativeResult(
            "",
            null,
            Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }),
          );
    });
    if (inventory) {
      expect(() => listScheduledTasks(budget)).toThrow(ScheduledTaskInspectionError);
    } else {
      expect(probeScheduledTaskState("OpenClaw Gateway", budget)).toEqual({
        status: "unknown",
        detail:
          expected === 0
            ? "Scheduled Task inspection deadline expired."
            : `Scheduled Task probe timed out after ${expected} ms (ETIMEDOUT).`,
        timeoutMs: expected,
        diagnostic: { kind: "timeout", timeoutMs: expected },
      });
    }
    if (expected === 0) {
      expect(probeScheduledTaskExists("OpenClaw Gateway", budget)).toBeNull();
      expect(spawnSync).not.toHaveBeenCalled();
    } else {
      expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.timeout).toBe(expected);
      expect(spawnSync).toHaveBeenCalledTimes(1);
    }
  },
);

it.each([
  { allowance: 699.5, expected: 699 },
  { allowance: 0.75, expected: undefined },
  { allowance: 10_000, expected: 5_000 },
])(
  "bounds process snapshot allowance $allowance without extending the native cap",
  ({ allowance, expected }) =>
    withMockedPlatform("win32", () => {
      const stdout = JSON.stringify([{ ProcessId: 1234, CommandLine: "fixture process" }]);
      vi.mocked(spawnSync).mockReturnValue({
        pid: 0,
        output: [null, stdout, ""],
        stdout,
        stderr: "",
        status: 0,
        signal: null,
      });
      const result = readWindowsProcessSnapshot(allowance);
      if (expected === undefined) {
        expect(result).toBeNull();
        expect(spawnSync).not.toHaveBeenCalled();
      } else {
        expect(result).toHaveLength(1);
        expect(spawnSync).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Array),
          expect.objectContaining({ timeout: expected }),
        );
      }
    }),
);
