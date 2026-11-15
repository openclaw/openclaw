import { spawnSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { readWindowsProcessSnapshot } from "./schtasks-process-snapshot.js";
import {
  listScheduledTasks,
  probeScheduledTaskExists as probeExists,
  probeScheduledTaskState as probeState,
  probeScheduledTaskUpdateAccess as probeAccess,
  ScheduledTaskInspectionError,
} from "./schtasks-state-probe.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const native = vi.mocked(spawnSync);
const respond = (value: unknown) => native.mockReturnValue(nativeResult(JSON.stringify(value)));
const timeout = Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
  code: "ETIMEDOUT",
});
beforeEach(() => {
  native.mockReset();
});

it.each([
  [true, "S-1-5-18", 1, "allowed"],
  [false, null, 0, "allowed"],
  [false, "unresolved account", 0, "unknown"],
] as const)(
  "keeps native task access uncertainty distinct from elevation: %j",
  (callerElevated, taskUserSid, taskRunLevel, expected) => {
    respond({ callerSid: "S-1-5-21-111-222-333-1001", callerElevated, taskUserSid, taskRunLevel });
    expect(probeAccess("Synthetic Gateway").status).toBe(expected);
  },
);

function nativeResult(stdout = "", status: number | null = 0, error?: Error) {
  return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status, signal: null, error };
}

it.each(["ERR_ACCESS_DENIED", "EPERM"])("reports denied launches as unknown (%s)", (code) => {
  const error = Object.assign(new Error(`spawnSync powershell.exe ${code}`), {
    code,
    errno: -4048,
  });
  native.mockImplementation(() => {
    throw error;
  });
  expect(probeState("Synthetic Gateway")).toEqual({
    status: "unknown",
    detail: error.message,
    diagnostic: { kind: "spawn", errno: -4048 },
  });
});

it.each([false, true])(
  "reads task actions without a hidden console (inventory=%s)",
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
    native.mockImplementation((_command, _args, options) =>
      options?.windowsHide === true
        ? nativeResult("", 2)
        : nativeResult(JSON.stringify(inventory ? [snapshot] : snapshot)),
    );
    expect(inventory ? listScheduledTasks() : probeState(snapshot.taskPath)).toEqual(
      inventory ? [snapshot] : { status: "found", ...snapshot },
    );
    expect(spawnSync).toHaveBeenCalledTimes(1);
  },
);

it("explains an empty exit-2 result", () => {
  native.mockReturnValue(nativeResult(" \r\n", 2));
  expect(probeState("OpenClaw Gateway")).toEqual({
    status: "unknown",
    detail: "Scheduled Task check failed (exit 2): no output from PowerShell.",
    diagnostic: { kind: "native", exitCode: 2 },
  });
});

it.each([
  ["task", undefined, 60_000],
  ["task", 899.75, 899],
  ["task", 0.75, 0],
  ["task", Number.NaN, 0],
  ["inventory", 47_000, 47_000],
  ["task", 2_400_000, 60_000],
  ["inventory", 2_400_000, 60_000],
  ["process", 699.5, 699],
  ["process", 0.75, 0],
  ["process", 10_000, 5_000],
] as const)("bounds %s inspection (budget=%s, timeout=%s)", (scope, budget, expected) =>
  withMockedPlatform("win32", () => {
    if (scope === "process") {
      respond([{ ProcessId: 1234 }]);
      const result = readWindowsProcessSnapshot(budget);
      expect(result).toEqual(expected === 0 ? null : [{ ProcessId: 1234 }]);
    } else {
      native.mockReturnValue(nativeResult("", null, timeout));
      if (scope === "inventory") {
        expect(() => listScheduledTasks(budget)).toThrow(ScheduledTaskInspectionError);
      } else {
        expect(probeState("OpenClaw Gateway", budget)).toEqual({
          status: "unknown",
          timeoutMs: expected,
          detail:
            expected === 0
              ? "Scheduled Task inspection deadline expired."
              : `Scheduled Task check timed out after ${expected} ms (ETIMEDOUT).`,
          diagnostic: { kind: "timeout", timeoutMs: expected },
        });
        if (expected === 0) {
          expect(probeExists("OpenClaw Gateway", budget)).toBeNull();
        }
      }
    }
    if (expected === 0) {
      expect(spawnSync).not.toHaveBeenCalled();
    } else {
      expect(native.mock.calls).toEqual([
        [expect.any(String), expect.any(Array), expect.objectContaining({ timeout: expected })],
      ]);
    }
  }),
);
