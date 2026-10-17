import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const found = (state: unknown, extra = {}) => ({
  status: 0,
  stdout: JSON.stringify({ state, ...extra }),
});
const timedOut = () => ({
  error: Object.assign(new Error("Native probe timed out"), { code: "ETIMEDOUT" }),
});
function advanceProbe(elapsed: number | undefined, state: number, cap = false) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  spawnSync.mockImplementation((_command, _args, options) => {
    const duration = elapsed ?? options.timeout;
    vi.setSystemTime(Date.now() + (cap ? Math.min(duration, options.timeout) : duration));
    return elapsed === undefined || (cap && duration > options.timeout) ? timedOut() : found(state);
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync,
}));

vi.mock("./gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: async () => ["127.0.0.1"],
}));

vi.mock("./schtasks-process-snapshot.js", async (original) => ({
  ...(await original<typeof import("./schtasks-process-snapshot.js")>()),
  readWindowsProcessSnapshot: () => [{ ProcessId: 111, CommandLine: "powershell.exe" }],
}));

beforeEach(() => spawnSync.mockReset());

const readRuntime = () =>
  readScheduledTaskRuntime({ USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "default" });

it.each([
  [1, 267009, "stopped", "Disabled"],
  [3, 267009, "stopped", "Ready"],
  [4, -2147024891, "unknown", "Running"],
  [2, 0, "unknown", "Queued"],
  [0, 267009, "unknown", "Unknown"],
  [3, "unavailable", "stopped", "Ready"],
  ["3", undefined, "unknown", "Unknown"],
  [5, undefined, "unknown", "Unknown"],
])("derives runtime from state %j, not history %j", async (state, result, status, name) => {
  spawnSync.mockReturnValue(
    found(state, {
      lastRunResult: result,
      lastRunTime: false,
      taskPath: "OpenClaw Gateway",
      actions: [
        {
          type: 0,
          path: "C:\\node.exe",
          arguments: "C:\\openclaw\\entry.js gateway --port 18789",
          workingDirectory: "",
        },
      ],
    }),
  );
  await expect(readRuntime()).resolves.toMatchObject({
    status,
    state: name,
    lastRunResult: typeof result === "number" ? String(result) : undefined,
  });
  expect(probeScheduledTaskExists("OpenClaw Gateway")).toBe(true);
  expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(status === "stopped");
});

it.each([
  { status: 1, stdout: "-2147024894", missing: true },
  { status: 1, stdout: "-2147024893", missing: true },
  { status: 1, stdout: "-2147024891", missing: false },
  { status: 2, stdout: "-2147024894", missing: false },
  { status: 1, stdout: "-2147024894 trailing", missing: false },
  { status: 0, stdout: "not JSON", missing: false },
  { status: 0, stdout: "null", missing: false },
  { status: null, stdout: "", error: new Error("ENOENT"), missing: false },
])("distinguishes missing tasks from failed inspection: %j", async ({ missing, ...response }) => {
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
});

it("requires current Scheduler running state before retiring the Startup owner", async () => {
  spawnSync
    .mockReturnValueOnce(found(3, { lastRunResult: 267009 }))
    .mockReturnValueOnce(found(4, { lastRunResult: 0 }));
  await expect(waitForScheduledTaskRunningEvidence({})).resolves.toBe(true);
  expect(spawnSync).toHaveBeenCalledTimes(2);
});

it.each<[number, boolean]>([
  [4_999, true],
  [5_001, false],
])("bounds Ready evidence after %s ms", (responseMs, expected) => {
  advanceProbe(responseMs, 3, true);
  expect(isScheduledTaskDefinitelyNotRunning("OpenClaw Gateway")).toBe(expected);
  expect(Date.now()).toBe(Math.min(responseMs, 5_000));
});

it.each([
  { name: "hung probe", elapsedMs: undefined, expected: false },
  { name: "running before deadline", elapsedMs: 14_999, expected: true },
  { name: "running at deadline", elapsedMs: 15_000, expected: false },
])("bounds Scheduler takeover evidence for $name", async (task) => {
  advanceProbe(task.elapsedMs, 4);
  await expect(waitForScheduledTaskRunningEvidence({})).resolves.toBe(task.expected);
  expect(Date.now()).toBe(task.elapsedMs ?? 15_000);
  expect(spawnSync).toHaveBeenCalledOnce();
});
let now = 0;

async function loadState(startup = false, timeoutMs?: number) {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const env = {
    APPDATA: tempDirs.make("schtasks-load-state-"),
    OPENCLAW_WINDOWS_TASK_NAME: "Registration Fixture",
  };
  if (startup) {
    const startupPath = resolveStartupEntryPath(env);
    await fs.mkdir(path.dirname(startupPath), { recursive: true });
    await fs.writeFile(startupPath, "@rem synthetic Startup entry; never executed\r\n");
  }
  return readGatewayServiceLoadState({ isLoaded: isScheduledTaskInstalled }, { env, timeoutMs });
}

it.each<[number | undefined, number, "loaded" | "unknown", ("found" | "missing")?, number?]>([
  [undefined, 45_000, "loaded"],
  [undefined, 60_001, "unknown"],
  [200, 100, "loaded"],
  [20_000, 45_000, "unknown"],
  [200, 200, "unknown", "found"],
  [200, 200, "unknown", "missing"],
  [200, 150, "unknown", "missing", 51],
])(
  "bounds registration (%s allowance, %s response, %s, %s, %s access)",
  async (timeoutMs, responseAfterMs, expected, observation, accessMs) => {
    if (accessMs !== undefined) {
      vi.spyOn(fs, "access").mockImplementation(async () => {
        now += accessMs;
      });
    }
    spawnSync.mockImplementation((_command, _args, options) => {
      now += Math.min(responseAfterMs, options.timeout);
      return responseAfterMs > options.timeout
        ? timedOut()
        : observation === "missing"
          ? { status: 1, stdout: "-2147024894" }
          : found(3);
    });
    const loaded = await loadState(observation !== undefined, timeoutMs);
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
])("classifies $hresult with Startup=$startup", async ({ hresult, startup, expected }) => {
  spawnSync.mockReturnValue({ status: 1, stdout: hresult, stderr: "native-secret-canary" });
  const loaded = await loadState(startup, 200);
  expect(loaded.status).toBe(expected);
  if (expected === "unknown") {
    expect(loaded).toMatchObject({
      inspectionReason: "windows-task-inspection-failed",
      detail: expect.stringContaining("HRESULT 0x80070005"),
    });
    expect(JSON.stringify(loaded)).not.toContain("native-secret-canary");
  }
});
