import { afterEach, expect, it, vi } from "vitest";
import type { GatewayCrashRecord } from "../infra/gateway-crash.js";
import * as native from "./exec-file.js";
import { readGatewayCrashCause } from "./gateway-crash-cause.js";

afterEach(() => vi.restoreAllMocks());

const empty = { code: 0, termination: "exit" as const, stdout: "", stderr: "" };

const crash: GatewayCrashRecord = {
  bootId: "previous",
  pid: 123,
  startedAtMs: 1_000,
  detectedAtMs: 10_000,
  supervisor: { kind: "systemd", name: "openclaw-gateway.service" },
  systemdInvocationId: "synthetic-invocation",
};

it.each([
  [
    { EXIT_CODE: "dumped", EXIT_STATUS: "11" },
    { signal: "SIGSEGV", uptimeMs: 8_000 },
  ],
  [
    { EXIT_CODE: "exited", EXIT_STATUS: "137" },
    { exitCode: 137, uptimeMs: 8_000 },
  ],
  [{ EXIT_CODE: "unknown", EXIT_STATUS: "11" }, undefined],
  [
    {
      EXIT_CODE: "exited",
      EXIT_STATUS: "1",
      MESSAGE: "openclaw-gateway.service: Control process exited, code=exited, status=1/FAILURE",
    },
    undefined,
  ],
  [{ EXIT_CODE: "dumped", EXIT_STATUS: "11", INVOCATION_ID: "other" }, undefined],
  [{ MESSAGE: "Main process exited, code=dumped, status=11/SEGV" }, undefined],
  [{ EXIT_CODE: "dumped", EXIT_STATUS: "11", __REALTIME_TIMESTAMP: "11000000" }, undefined],
])("uses only matching structured exit evidence (%j)", async (fields, expected) => {
  const execute = vi
    .spyOn(native, "execFileUtf8")
    .mockResolvedValue(empty)
    .mockResolvedValueOnce({
      code: 0,
      termination: "exit",
      stdout: JSON.stringify({
        __REALTIME_TIMESTAMP: "9000000",
        _COMM: "systemd",
        MESSAGE_ID: "98e322203f7a4ed290d09fe03c09fe15",
        MESSAGE: "openclaw-gateway.service: Main process exited, code=dumped, status=11/SEGV",
        INVOCATION_ID: "synthetic-invocation",
        ...fields,
      }),
      stderr: "",
    });
  expect(await readGatewayCrashCause(crash)).toEqual(expected);
  expect(execute).toHaveBeenCalledTimes(2);
});

it("keeps unavailable journal evidence unknown", async () => {
  vi.spyOn(native, "execFileUtf8").mockResolvedValue({
    code: 1,
    termination: "error",
    stdout: "",
    stderr: "Permission denied",
  });
  expect(await readGatewayCrashCause(crash)).toBeUndefined();
});

it("attaches a matching self-recovery reason to the same crash", async () => {
  vi.spyOn(native, "execFileUtf8")
    .mockResolvedValueOnce(empty)
    .mockResolvedValueOnce({
      code: 0,
      termination: "exit",
      stdout: JSON.stringify({
        __REALTIME_TIMESTAMP: "9000000",
        _SYSTEMD_INVOCATION_ID: "synthetic-invocation",
        _PID: "123",
        MESSAGE:
          "[gateway/event-loop] main-thread stall recovery: pid=123 elapsedMs=300001 thresholdMs=300000 signal=SIGKILL",
      }),
      stderr: "",
    });
  expect(await readGatewayCrashCause(crash)).toEqual({ reason: "main-thread stall self-recovery" });
});

it("uses indexed exit matches and limits stall text scanning for a day-long run", async () => {
  const execute = vi.spyOn(native, "execFileUtf8").mockResolvedValue({
    code: 0,
    termination: "exit",
    stdout: "",
    stderr: "",
  });
  await readGatewayCrashCause({ ...crash, detectedAtMs: 86_400_000 });
  const exitArgs = execute.mock.calls[0][1];
  expect(exitArgs.some((arg) => arg.startsWith("--grep"))).toBe(false);
  expect(exitArgs.slice(-5)).toEqual([
    "MESSAGE_ID=98e322203f7a4ed290d09fe03c09fe15",
    "UNIT=openclaw-gateway.service",
    "+",
    "MESSAGE_ID=98e322203f7a4ed290d09fe03c09fe15",
    "USER_UNIT=openclaw-gateway.service",
  ]);
  const stallArgs = execute.mock.calls[1][1];
  expect(stallArgs).toContain("--since=@86370");
  expect(stallArgs).toContain("--until=@86400");
  expect(stallArgs).toContain(
    "--grep=^\\[gateway/event-loop\\] main-thread stall recovery: pid=123 elapsedMs=\\d+ thresholdMs=\\d+ signal=SIGKILL$",
  );
  expect(stallArgs.slice(-5)).toEqual([
    "_PID=123",
    "_SYSTEMD_UNIT=openclaw-gateway.service",
    "+",
    "_PID=123",
    "_SYSTEMD_USER_UNIT=openclaw-gateway.service",
  ]);
});

it.each([false, true])(
  "keeps exit evidence when stall inspection is unavailable (budget exhausted: %s)",
  async (exhausted) => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const execute = vi
      .spyOn(native, "execFileUtf8")
      .mockResolvedValue({ ...empty, code: 1 })
      .mockImplementationOnce(async () => {
        if (exhausted) {
          clock.mockReturnValue(1_001);
        }
        return {
          ...empty,
          stdout: JSON.stringify({
            __REALTIME_TIMESTAMP: "80000000",
            _COMM: "systemd",
            MESSAGE_ID: "98e322203f7a4ed290d09fe03c09fe15",
            USER_INVOCATION_ID: "synthetic-invocation",
            MESSAGE: "openclaw-gateway.service: Main process exited, code=dumped, status=11/SEGV",
            EXIT_CODE: "dumped",
            EXIT_STATUS: "11",
          }),
        };
      });
    expect(await readGatewayCrashCause({ ...crash, detectedAtMs: 90_000 })).toEqual({
      signal: "SIGSEGV",
      uptimeMs: 79_000,
    });
    expect(execute).toHaveBeenCalledTimes(exhausted ? 1 : 2);
    if (!exhausted) {
      expect(execute.mock.calls[1][1]).toContain("--since=@50");
      expect(execute.mock.calls[1][1]).toContain("--until=@80");
    }
    expect(execute.mock.calls[0][2]?.timeout).toBe(1_000);
  },
);
