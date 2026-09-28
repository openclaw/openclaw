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
    { state: 1, result: 267009, expected: "stopped", name: "Disabled" },
    { state: 3, result: 267009, expected: "stopped", name: "Ready" },
    { state: 4, result: -2147024891, expected: "running", name: "Running" },
    { state: 2, result: 0, expected: "unknown", name: "Queued" },
    { state: 0, result: 267009, expected: "unknown", name: "Unknown" },
  ])("uses $name rather than stale last-run result $result", async (task) => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ state: task.state, lastRunResult: task.result }),
    });
    await expect(readRuntime()).resolves.toMatchObject({
      status: task.expected,
      state: task.name,
      lastRunResult: String(task.result),
    });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
    expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(
      task.expected === "stopped",
    );
  });

  it.each([{ state: 3 }, { state: 3, lastRunResult: "unavailable", lastRunTime: false }])(
    "preserves task state and existence without optional history: %j",
    async (snapshot) => {
      spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify(snapshot) });
      await expect(readRuntime()).resolves.toMatchObject({
        status: "stopped",
        state: "Ready",
      });
      expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
      expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(true);
    },
  );

  it.each(["3", 5])("preserves existence but not offline proof for state %j", async (state) => {
    spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify({ state }) });
    await expect(readRuntime()).resolves.toMatchObject({ status: "unknown" });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
    expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(false);
  });

  it.each(["-2147024894", "-2147024893"])(
    "recognizes lookup HRESULT %s as missing",
    async (stdout) => {
      spawnSync.mockReturnValue({ status: 1, stdout });
      await expect(readRuntime()).resolves.toEqual({
        status: "stopped",
        missingUnit: true,
      });
      expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(false);
      expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(false);
    },
  );

  it.each([
    { name: "access denied", status: 1, stdout: "-2147024891" },
    { name: "connection missing file", status: 2, stdout: "-2147024894" },
    { name: "malformed HRESULT", status: 1, stdout: "-2147024894 trailing" },
    { name: "invalid JSON", status: 0, stdout: "not JSON" },
    { name: "non-object JSON", status: 0, stdout: "null" },
    { name: "spawn failure", status: null, stdout: "", error: new Error("ENOENT") },
  ])("keeps $name unavailable, not missing or stopped", async (response) => {
    spawnSync.mockReturnValue(response);
    await expect(readRuntime()).resolves.toMatchObject({
      status: "unknown",
      missingUnit: false,
      inspectionFailure: { code: "service-runtime-inspection-failed" },
    });
    expect(probeScheduledTaskExists("OpenClaw Gateway")).toBeNull();
  });

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
    { name: "running after deadline", elapsedMs: 15_001, expected: false },
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
    { timeoutMs: 90_000, responseAfterMs: 45_000, expected: "loaded" },
  ])(
    "bounds native registration taking $responseAfterMs ms by allowance $timeoutMs",
    async ({ timeoutMs, responseAfterMs, expected }) => {
      const env = await loadEnv();
      spawnSync.mockImplementation((_command, _args, options) => {
        now += Math.min(responseAfterMs, options.timeout);
        return responseAfterMs > options.timeout
          ? {
              status: null,
              stdout: "",
              error: Object.assign(new Error("synthetic native timeout"), { code: "ETIMEDOUT" }),
            }
          : { status: 0, stdout: JSON.stringify({ state: 3 }) };
      });
      const loaded = await readGatewayServiceLoadState(
        { isLoaded: isScheduledTaskInstalled },
        { env, timeoutMs },
      );
      expect(loaded.status).toBe(expected);
      expect(now).toBe(Math.min(responseAfterMs, timeoutMs ?? 60_000));
      if (expected === "unknown") {
        expect(loaded).toMatchObject({
          inspectionReason: "windows-task-inspection-failed",
          detail: expect.stringContaining(`timed out after ${timeoutMs ?? 60_000} ms`),
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

  it.each(["found", "missing"])(
    "rejects a late %s observation before accepting task or Startup registration",
    async (observation) => {
      const env = await loadEnv(true);
      spawnSync.mockImplementation(() => {
        now = 200;
        return observation === "found"
          ? { status: 0, stdout: JSON.stringify({ state: 3 }) }
          : { status: 1, stdout: "-2147024894" };
      });
      await expect(
        readGatewayServiceLoadState(
          { isLoaded: isScheduledTaskInstalled },
          { env, timeoutMs: 200 },
        ),
      ).resolves.toMatchObject({
        status: "unknown",
        inspectionReason: "windows-task-inspection-failed",
      });
    },
  );

  it("charges native registration time to the remaining Startup inspection budget", async () => {
    const env = await loadEnv(true);
    spawnSync.mockImplementation(() => {
      now = 150;
      return { status: 1, stdout: "-2147024894" };
    });
    vi.spyOn(fs, "access").mockImplementation(async () => {
      now += 51;
    });
    await expect(
      readGatewayServiceLoadState({ isLoaded: isScheduledTaskInstalled }, { env, timeoutMs: 200 }),
    ).resolves.toMatchObject({ status: "unknown" });
    expect(now).toBe(201);
  });
});
