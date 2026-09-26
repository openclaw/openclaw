import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { readWindowsProcessSnapshot } from "./schtasks-process-snapshot.js";
import { probeScheduledTaskExists, probeScheduledTaskState } from "./schtasks-state-probe.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

beforeEach(() => vi.mocked(spawnSync).mockReset());

it("returns an unknown result when PowerShell execution is denied", () => {
  vi.mocked(spawnSync).mockImplementationOnce(() => {
    throw Object.assign(new Error("spawnSync powershell.exe ERR_ACCESS_DENIED"), {
      code: "ERR_ACCESS_DENIED",
    });
  });

  expect(probeScheduledTaskState("OpenClaw Gateway")).toEqual({
    status: "unknown",
    detail: "spawnSync powershell.exe ERR_ACCESS_DENIED",
  });
});

it("reads task state when PowerShell rejects a no-console launch", () => {
  vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
    const hidden = options?.windowsHide === true;
    const stdout = hidden ? "" : JSON.stringify({ state: 4, lastRunResult: 267009 });
    return {
      pid: 0,
      output: [null, stdout, ""],
      stdout,
      stderr: "",
      status: hidden ? 2 : 0,
      signal: null,
    };
  });

  expect(probeScheduledTaskState("OpenClaw Gateway")).toEqual({
    status: "found",
    state: 4,
    lastRunResult: "267009",
  });
  expect(spawnSync).toHaveBeenCalledTimes(1);
});

it.each(["", " \r\n"])("explains an empty exit-2 result: %j", (output) => {
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    output: [null, output, output],
    stdout: output,
    stderr: output,
    status: 2,
    signal: null,
  });
  expect(probeScheduledTaskState("OpenClaw Gateway")).toEqual({
    status: "unknown",
    detail: "Scheduled Task probe failed (exit 2): no output from PowerShell.",
    diagnostic: { kind: "native", exitCode: 2 },
  });
});

describe("Scheduled Task probe timeout", () => {
  it.each([0, -1, 0.5, 0.75, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "does not spawn or infer absence with unavailable allowance %s",
    (timeoutMs) => {
      vi.mocked(spawnSync).mockReturnValue({
        pid: 0,
        output: [null, "-2147024894", ""],
        stdout: "-2147024894",
        stderr: "",
        status: 1,
        signal: null,
      });

      expect(probeScheduledTaskState("OpenClaw Gateway", timeoutMs)).toEqual({
        status: "unknown",
        detail: "Scheduled Task inspection deadline expired.",
        timeoutMs: 0,
        diagnostic: { kind: "timeout", timeoutMs: 0 },
      });
      expect(probeScheduledTaskExists("OpenClaw Gateway", timeoutMs)).toBeNull();
      expect(spawnSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    { budget: undefined, expected: 5_000 },
    { budget: 1, expected: 1 },
    { budget: 899.75, expected: 899 },
    { budget: 457.0681, expected: 457 },
    { budget: 200, expected: 200 },
    { budget: 30_000, expected: 30_000 },
  ])("uses a bounded caller budget: $budget -> $expected ms", ({ budget, expected }) => {
    vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
      const timeout = options?.timeout;
      // Node 24.21.0 child_process.validateTimeout rejects before native spawn.
      if (timeout != null && !(Number.isInteger(timeout) && timeout >= 0)) {
        throw Object.assign(new RangeError("timeout must be an unsigned integer"), {
          code: "ERR_OUT_OF_RANGE",
        });
      }
      return {
        pid: 0,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: null,
        signal: "SIGTERM",
        error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
          code: "ETIMEDOUT",
        }),
      };
    });

    const result = probeScheduledTaskState("OpenClaw Gateway", budget);

    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.timeout).toBe(expected);
    expect(result).toEqual({
      status: "unknown",
      detail: `Scheduled Task probe timed out after ${expected} ms (ETIMEDOUT).`,
      timeoutMs: expected,
      diagnostic: { kind: "timeout", timeoutMs: expected },
    });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});

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
