import type { SpawnSyncReturns } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { loadBrowserMeetingPlugins } from "./browser-plugin.test-support.js";

type Probe = (
  ...args: [string, string[], { timeout: number }]
) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error">;
const spawnSync = vi.hoisted(() => vi.fn<Probe>());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));

const successfulProbe = { status: 0, stderr: "", stdout: "BlackHole 2ch" };
const commandCheck = 'command -v "$1" >/dev/null 2>&1';
const setupParams = (audioInputCommand = ["capture"], audioOutputCommand = ["play"]) =>
  JSON.stringify({ action: "setup", audioInputCommand, audioOutputCommand });
const ready = JSON.stringify({
  ok: true,
  audioBackend: "blackhole-2ch",
  audioDeviceLabel: "BlackHole 2ch",
});
function mockClock(values: number[]) {
  const clock = vi.spyOn(Date, "now");
  for (const value of values) {
    clock.mockReturnValueOnce(value);
  }
}

beforeAll(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe.each([
  ["Zoom meeting", "zoomMeetingsPlugin"],
  ["Microsoft Teams meeting", "teamsMeetingsPlugin"],
  ["Slack huddle", "slackHuddlesPlugin"],
] as const)("%s node prerequisite setup", (name, key) => {
  let plugin: Awaited<ReturnType<typeof loadBrowserMeetingPlugins>>[typeof key];
  const timeoutMessage = `${name} audio prerequisite check timed out on the node.`;
  beforeAll(async () => {
    // Audio command defaults are captured when each declaration loads.
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      plugin = (await loadBrowserMeetingPlugins())[key];
    } finally {
      platform.mockRestore();
    }
  });
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    spawnSync.mockReset().mockReturnValue(successfulProbe);
  });

  it.each([
    [
      [0, 0, 6_000, 8_000],
      [10_000, 4_000, 2_000],
    ],
    [
      [1_000, 1_000, 4_000, 8_000],
      [10_000, 7_000, 3_000],
    ],
  ])("shares one deadline across sequential probes from %j", async (clock, timeouts) => {
    mockClock(clock);
    await expect(plugin.nodeHandler(setupParams())).resolves.toBe(ready);
    expect(spawnSync.mock.calls.map((call) => call[2].timeout)).toEqual(timeouts);
  });

  it("probes the default sox executable only once", async () => {
    await expect(
      plugin.nodeHandler(
        setupParams(
          plugin.config.defaultAudioInputCommand,
          plugin.config.defaultAudioOutputCommand,
        ),
      ),
    ).resolves.toBe(ready);
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync.mock.calls[1]?.[1]).toEqual(["-lc", commandCheck, "sh", "sox"]);
  });

  it("does not start another probe after the shared deadline expires", async () => {
    mockClock([1_000, 1_000, 11_000]);
    await expect(plugin.nodeHandler(setupParams())).rejects.toThrow(timeoutMessage);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it.each(["profiler", "command"])("reports %s timeouts", async (probe) => {
    if (probe === "command") {
      spawnSync.mockReturnValueOnce(successfulProbe);
    }
    const error = Object.assign(new Error(`spawnSync ${probe} ETIMEDOUT`), { code: "ETIMEDOUT" });
    spawnSync.mockReturnValueOnce({ status: null, stderr: "", stdout: "", error });
    await expect(plugin.nodeHandler(setupParams())).rejects.toThrow(timeoutMessage);
    expect(spawnSync).toHaveBeenCalledTimes(probe === "command" ? 2 : 1);
  });
});
