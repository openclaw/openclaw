import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  scenario: "settle" as "settle" | "pending" | "wait-error" | "pipe-error" | "close-error",
  terminated: false,
  rootSettled: false,
  rootWaits: 0,
  pipesEnded: new Set<bigint>(),
  closed: [] as bigint[],
  earlyClose: false,
  clock: 0,
}));

vi.mock("../../src/process/supervisor/service-child-windows-job-native.ts", () => ({
  createWindowsJobBindings: () => ({
    assertLayouts() {},
    requireHandle: (value: bigint) => value,
    lastError: (operation: string) => new Error(operation),
    getLastErrorCode: () => (control.scenario === "pipe-error" && control.terminated ? 5 : 109),
    CreateJobObjectW: () => 1n,
    SetExtendedLimits: () => 1,
    extendedLimits: {},
    extendedLimitsSize: 144,
    startupInfoExSize: 112,
    basicAccountingSize: 48,
    createCommandStdio: () => ({
      inheritedHandles: [5n, 6n, 7n],
      stdinHandle: 5n,
      stdoutWriteHandle: 6n,
      stderrWriteHandle: 7n,
      closeChildHandles() {},
      close() {},
      takeOutputReadHandles: () => ({ stdoutReadHandle: 3n, stderrReadHandle: 4n }),
    }),
    createProcessAttributeList: () => ({ attributeList: Buffer.alloc(0), release() {} }),
    CreateProcessW: (...args: unknown[]) => {
      Object.assign(args.at(-1) as object, { hProcess: 2n, hThread: 8n, dwProcessId: 123 });
      return 1;
    },
    TerminateJobObject: () => {
      control.terminated = true;
      return 1;
    },
    QueryInformationJobObject: (_job: bigint, _class: number, accounting: object) => {
      Object.assign(accounting, { ActiveProcesses: control.terminated ? 0 : 1 });
      return 1;
    },
    WaitForSingleObject: () => {
      if (!control.terminated) {
        return 258;
      }
      control.rootWaits++;
      if (control.scenario === "wait-error") {
        return 0xffff_ffff;
      }
      if (control.scenario === "pending" || control.rootWaits < 2) {
        return 258;
      }
      control.rootSettled = true;
      return 0;
    },
    GetExitCodeProcess: (_root: bigint, code: number[]) => {
      code[0] = 1;
      return 1;
    },
    PeekNamedPipe: (
      handle: bigint,
      _buffer: unknown,
      _size: number,
      _read: unknown,
      available: number[],
    ) => {
      available[0] = 0;
      if (control.scenario === "pipe-error" && control.terminated) {
        return 0;
      }
      if (!control.rootSettled) {
        return 1;
      }
      control.pipesEnded.add(handle);
      return 0;
    },
    ReadFile: () => {
      throw new Error("Unexpected read");
    },
    CloseHandle: (handle: bigint) => {
      if (handle === 2n && (!control.rootSettled || control.pipesEnded.size !== 2)) {
        control.earlyClose = true;
      }
      control.closed.push(handle);
      return control.scenario === "close-error" && handle === 2n ? 0 : 1;
    },
  }),
}));

describe.runIf(process.platform === "win32")("npm Windows Job settlement", () => {
  beforeEach(() => {
    control.scenario = "settle";
    control.terminated = false;
    control.rootSettled = false;
    control.rootWaits = 0;
    control.pipesEnded.clear();
    control.closed = [];
    control.earlyClose = false;
    control.clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      control.clock += control.scenario === "pending" ? 2_000 : 1;
      return control.clock;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function timedOutJob() {
    const { runNpmWindowsJob } = await import("../../scripts/lib/npm-windows-job.mts");
    return runNpmWindowsJob("cmd.exe", ["/d", "/s", "/c", "npm"], {
      cwd: ".",
      env: {},
      timeout: 0,
      maxBuffer: 100,
    });
  }

  it("waits for the owned root and pipe EOF after Job accounting reaches zero", async () => {
    const result = await timedOutJob();
    expect(result).toMatchObject({ error: { code: "ETIMEDOUT" }, processTreeState: "terminated" });
    expect(control.rootWaits).toBe(2);
    expect(control.rootSettled).toBe(true);
    expect([...control.pipesEnded]).toEqual([3n, 4n]);
    expect(control.earlyClose).toBe(false);
    expect(control.closed).toEqual([8n, 3n, 4n, 2n, 1n]);
  });

  it("does not claim settlement when the root remains unsignalled", async () => {
    control.scenario = "pending";
    const result = await timedOutJob();
    expect(result).toMatchObject({
      processTreeState: "indeterminate",
      error: {
        code: "ETIMEDOUT",
        cleanupError: { message: "npm Job resource settlement could not be verified" },
      },
    });
    expect(control.clock).toBeLessThanOrEqual(12_000);
  });

  it.each([
    ["wait-error", "WaitForSingleObject(npm cleanup)"],
    ["pipe-error", "PeekNamedPipe(npm stdout)"],
    ["close-error", "CloseHandle(npm owner)"],
  ] as const)("preserves the deadline error and %s cleanup error", async (scenario, message) => {
    control.scenario = scenario;
    const result = await timedOutJob();
    expect(result.error).toMatchObject({ code: "ETIMEDOUT", cleanupError: { message } });
    expect(control.closed).toContain(1n);
    if (scenario !== "close-error") {
      expect(result.processTreeState).toBe("indeterminate");
    }
  });
});
