import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveStartupEntryPath } from "./schtasks-layout.js";
import {
  isScheduledTaskDefinitelyNotRunning,
  isScheduledTaskInstalled,
  readScheduledTaskRuntime,
  waitForScheduledTaskRunningEvidence,
} from "./schtasks-runtime.js";
import { probeScheduledTaskExists } from "./schtasks-state-probe.js";
import { readGatewayServiceLoadState } from "./service-load-state.js";

const spawnSync = vi.hoisted(() => vi.fn());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync,
}));

vi.mock("./gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: async () => ["127.0.0.1"],
}));

beforeEach(() => {
  spawnSync.mockReset();
});

describe("scheduled task runtime derivation", () => {
  async function readRuntime() {
    return readScheduledTaskRuntime({
      USERPROFILE: "C:\\Users\\test",
      OPENCLAW_PROFILE: "default",
    });
  }

  it.each([
    [1, 267009, "stopped", "Disabled"],
    [3, 267009, "stopped", "Ready"],
    [4, -2147024891, "running", "Running"],
    [2, 0, "unknown", "Queued"],
    [0, 267009, "unknown", "Unknown"],
    [3, "unavailable", "stopped", "Ready"],
    ["3", undefined, "unknown", "Unknown"],
    [5, undefined, "unknown", "Unknown"],
  ])(
    "derives runtime from state %j rather than history %j",
    async (state, result, status, name) => {
      spawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({ state, lastRunResult: result, lastRunTime: false }),
      });
      await expect(readRuntime()).resolves.toMatchObject({
        status,
        state: name,
        lastRunResult: typeof result === "number" ? String(result) : undefined,
      });
      expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
      expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(status === "stopped");
    },
  );

  it.each([
    { status: 1, stdout: "-2147024894", missing: true },
    { status: 1, stdout: "-2147024893", missing: true },
    { status: 1, stdout: "-2147024891", missing: false },
    { status: 2, stdout: "-2147024894", missing: false },
    { status: 1, stdout: "-2147024894 trailing", missing: false },
    { status: 0, stdout: "not JSON", missing: false },
    { status: 0, stdout: "null", missing: false },
    { status: null, stdout: "", error: new Error("ENOENT"), missing: false },
  ])(
    "distinguishes missing tasks from unavailable inspection: %j",
    async ({ missing, ...response }) => {
      spawnSync.mockReturnValue(response);
      const runtime = await readRuntime();
      if (missing) {
        expect(runtime).toEqual({ status: "stopped", missingUnit: true });
        expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(false);
      } else {
        expect(runtime).toMatchObject({
          status: "unknown",
          missingUnit: false,
          inspectionFailure: { code: "service-runtime-inspection-failed" },
        });
      }
      expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(missing ? false : null);
    },
  );

  it("requires current Scheduler running state before retiring the Startup owner", async () => {
    spawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ state: 3, lastRunResult: 267009 }),
      })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ state: 4, lastRunResult: 0 }) });
    await expect(waitForScheduledTaskRunningEvidence({})).resolves.toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it.each([
    { responseAfterMs: 4_999, expected: true },
    { responseAfterMs: 5_001, expected: false },
  ])("bounds stop verification when Ready arrives after $responseAfterMs ms", (task) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    spawnSync.mockImplementation((_command, _args, options) => {
      vi.setSystemTime(Date.now() + Math.min(task.responseAfterMs, options.timeout));
      return task.responseAfterMs > options.timeout
        ? {
            status: null,
            stdout: "",
            error: Object.assign(new Error("Native probe timed out"), { code: "ETIMEDOUT" }),
          }
        : { status: 0, stdout: JSON.stringify({ state: 3 }) };
    });
    try {
      expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(task.expected);
      expect(Date.now()).toBe(Math.min(task.responseAfterMs, 5_000));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "hung probe", elapsedMs: undefined, expected: false },
    { name: "running before deadline", elapsedMs: 14_999, expected: true },
    { name: "running at deadline", elapsedMs: 15_000, expected: false },
  ])("bounds Scheduler takeover evidence for $name", async (task) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    spawnSync.mockImplementation((_command, _args, options) => {
      vi.setSystemTime(Date.now() + (task.elapsedMs ?? options.timeout));
      return task.elapsedMs === undefined
        ? {
            status: null,
            stdout: "",
            stderr: "",
            error: Object.assign(new Error("Native probe timed out"), { code: "ETIMEDOUT" }),
          }
        : { status: 0, stdout: JSON.stringify({ state: 4 }) };
    });
    try {
      await expect(waitForScheduledTaskRunningEvidence({})).resolves.toBe(task.expected);
      expect(Date.now()).toBe(task.elapsedMs ?? 15_000);
      expect(spawnSync).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Scheduled Task load-state inspection", () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  async function loadEnv(startup = false) {
    const env = {
      APPDATA: tempDirs.make("schtasks-load-state-"),
      OPENCLAW_WINDOWS_TASK_NAME: "Registration Fixture",
    };
    if (startup) {
      const startupPath = resolveStartupEntryPath(env);
      await fs.mkdir(path.dirname(startupPath), { recursive: true });
      await fs.writeFile(startupPath, "@rem synthetic Startup entry; never executed\r\n");
    }
    return env;
  }

  it.each([
    { timeoutMs: undefined, responseAfterMs: 45_000, expected: "loaded" },
    { timeoutMs: undefined, responseAfterMs: 60_001, expected: "unknown" },
    { timeoutMs: 200, responseAfterMs: 100, expected: "loaded" },
    { timeoutMs: 20_000, responseAfterMs: 45_000, expected: "unknown" },
    { timeoutMs: 200, responseAfterMs: 200, expected: "unknown", observation: "found" },
    { timeoutMs: 200, responseAfterMs: 200, expected: "unknown", observation: "missing" },
    {
      timeoutMs: 200,
      responseAfterMs: 150,
      expected: "unknown",
      observation: "missing",
      accessMs: 51,
    },
  ])(
    "bounds native registration taking $responseAfterMs ms by allowance $timeoutMs",
    async ({ timeoutMs, responseAfterMs, expected, observation, accessMs }) => {
      const env = await loadEnv(observation !== undefined);
      if (accessMs !== undefined) {
        vi.spyOn(fs, "access").mockImplementation(async () => {
          now += accessMs;
        });
      }
      spawnSync.mockImplementation((_command, _args, options) => {
        now += Math.min(responseAfterMs, options.timeout);
        return responseAfterMs > options.timeout
          ? {
              status: null,
              stdout: "",
              error: Object.assign(new Error("synthetic native timeout"), { code: "ETIMEDOUT" }),
            }
          : observation === "missing"
            ? { status: 1, stdout: "-2147024894" }
            : { status: 0, stdout: JSON.stringify({ state: 3 }) };
      });
      const loaded = await readGatewayServiceLoadState(
        { isLoaded: isScheduledTaskInstalled },
        { env, timeoutMs },
      );
      expect(loaded.status).toBe(expected);
      expect(now).toBe(Math.min(responseAfterMs, timeoutMs ?? 60_000) + (accessMs ?? 0));
      if (expected === "unknown" && accessMs === undefined) {
        expect(loaded).toMatchObject({
          inspectionReason: "windows-task-inspection-failed",
          ...(observation === undefined
            ? { detail: expect.stringContaining(`timed out after ${timeoutMs ?? 60_000} ms`) }
            : {}),
        });
      }
    },
  );

  it.each([
    { hresult: "-2147024894", startup: false, expected: "not-loaded" },
    { hresult: "-2147024894", startup: true, expected: "loaded" },
    { hresult: "-2147024891", startup: false, expected: "unknown" },
    { hresult: "-2147024891", startup: true, expected: "unknown" },
  ])(
    "distinguishes native result $hresult with Startup=$startup",
    async ({ hresult, startup, expected }) => {
      const env = await loadEnv(startup);
      spawnSync.mockReturnValue({ status: 1, stdout: hresult, stderr: "native-secret-canary" });
      const loaded = await readGatewayServiceLoadState(
        { isLoaded: isScheduledTaskInstalled },
        { env, timeoutMs: 200 },
      );
      expect(loaded.status).toBe(expected);
      if (expected === "unknown") {
        expect(loaded).toMatchObject({
          inspectionReason: "windows-task-inspection-failed",
          detail: expect.stringContaining("HRESULT 0x80070005"),
        });
        expect(JSON.stringify(loaded)).not.toContain("native-secret-canary");
      }
    },
  );
});
