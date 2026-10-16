import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { readWindowsProcessSnapshot } from "./schtasks-process-snapshot.js";
import {
  listScheduledTasks,
  probeScheduledTaskExists,
  probeScheduledTaskState,
  probeScheduledTaskUpdateAccess,
  ScheduledTaskInspectionError,
} from "./schtasks-state-probe.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

beforeEach(() => vi.mocked(spawnSync).mockReset());

it.each([
  { callerElevated: true, taskUserSid: "S-1-5-18", taskRunLevel: 1, expected: "allowed" },
  { callerElevated: false, taskUserSid: null, taskRunLevel: 0, expected: "allowed" },
  {
    callerElevated: false,
    taskUserSid: "unresolved account",
    taskRunLevel: 0,
    expected: "unknown",
  },
])("keeps native task access uncertainty distinct from elevation: %j", (scenario) => {
  vi.mocked(spawnSync).mockReturnValue(
    nativeResult(
      JSON.stringify({
        callerSid: "S-1-5-21-111-222-333-1001",
        callerElevated: scenario.callerElevated,
        taskUserSid: scenario.taskUserSid,
        taskRunLevel: scenario.taskRunLevel,
      }),
    ),
  );
  expect(probeScheduledTaskUpdateAccess("Synthetic Gateway").status).toBe(scenario.expected);
});

function nativeResult(stdout = "", status: number | null = 0, error?: Error) {
  return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status, signal: null, error };
}

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
    detail: "Scheduled Task check failed (exit 2): no output from PowerShell.",
    diagnostic: { kind: "native", exitCode: 2 },
  });
});

it.each([
  { budget: undefined, expected: 60_000, inventory: false },
  { budget: 899.75, expected: 899, inventory: false },
  { budget: 0.75, expected: 0, inventory: false },
  { budget: Number.NaN, expected: 0, inventory: false },
  { budget: 47_000, expected: 47_000, inventory: true },
  { budget: 2_400_000, expected: 60_000, inventory: false },
  { budget: 2_400_000, expected: 60_000, inventory: true },
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
            : `Scheduled Task check timed out after ${expected} ms (ETIMEDOUT).`,
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

function lastProbeArgs(): readonly string[] {
  return vi.mocked(spawnSync).mock.calls.at(-1)?.[1] ?? [];
}

function lastProbeInput(): unknown {
  return vi.mocked(spawnSync).mock.calls.at(-1)?.[2]?.input;
}

describe("Scheduled Task probe command transport", () => {
  it("launches a literal command body instead of an encoded one", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [null, JSON.stringify({ state: 3 }), ""],
      stdout: JSON.stringify({ state: 3 }),
      stderr: "",
      status: 0,
      signal: null,
    });

    expect(probeScheduledTaskState("OpenClaw Gateway")).toMatchObject({ status: "found" });

    expect(vi.mocked(spawnSync).mock.calls[0]?.[0]).toBe(getWindowsPowerShellExePath());
    const args = lastProbeArgs();
    expect(args).not.toContain("-EncodedCommand");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
  });

  it("passes the task name as stdin data so the command body stays constant", () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [null, JSON.stringify({ state: 3 }), ""],
      stdout: JSON.stringify({ state: 3 }),
      stderr: "",
      status: 0,
      signal: null,
    });

    const hostileName = "OpenClaw Gateway & calc.exe";
    probeScheduledTaskState(hostileName);
    const firstArgs = lastProbeArgs();
    const firstInput = lastProbeInput();
    probeScheduledTaskState("A completely different task");
    const secondArgs = lastProbeArgs();
    const secondInput = lastProbeInput();

    expect(firstInput).toBe(`${Buffer.from(hostileName, "utf8").toString("base64")}\n`);
    expect(firstArgs).toEqual(secondArgs);
    expect(firstInput).not.toBe(secondInput);
    const commandLine = firstArgs.join(" ");
    expect(commandLine).not.toContain(hostileName);
    expect(commandLine).not.toContain(Buffer.from(hostileName, "utf8").toString("base64"));
    // The body decodes the stdin payload; the raw task name must never ride in the command line.
    expect(commandLine).toContain("[Console]::In.ReadLine()");
  });
});
