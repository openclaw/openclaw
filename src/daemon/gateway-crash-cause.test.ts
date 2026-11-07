import { afterEach, expect, it, vi } from "vitest";
import type { GatewayCrashRecord } from "../infra/gateway-crash.js";
import * as native from "./exec-file.js";
import { readGatewayCrashCause } from "./gateway-crash-cause.js";

afterEach(() => vi.restoreAllMocks());

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
  [{ EXIT_CODE: "dumped", EXIT_STATUS: "11", INVOCATION_ID: "other" }, undefined],
  [{ MESSAGE: "Main process exited, code=dumped, status=11/SEGV" }, undefined],
  [{ EXIT_CODE: "dumped", EXIT_STATUS: "11", __REALTIME_TIMESTAMP: "11000000" }, undefined],
])("uses only matching structured exit evidence (%j)", async (fields, expected) => {
  const execute = vi.spyOn(native, "execFileUtf8").mockResolvedValue({
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
  expect(execute).toHaveBeenCalledTimes(1);
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
  vi.spyOn(native, "execFileUtf8").mockResolvedValue({
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
