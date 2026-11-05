import type { SpawnSyncReturns } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { createPulseCommands } from "./audio-backend.test-support.js";
import { loadBrowserMeetingPlugins } from "./browser-plugin.test-support.js";

type Probe = (
  ...args: [string, string[], { timeout: number }]
) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error">;
const spawnSync = vi.hoisted(() => vi.fn<Probe>());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));
let plugins: Awaited<ReturnType<typeof loadBrowserMeetingPlugins>>;
const successfulProbe = { status: 0, stderr: "", stdout: "BlackHole 2ch" };
const ready = { ok: true, audioBackend: "blackhole-2ch", audioDeviceLabel: "BlackHole 2ch" };
const commands = { audioInputCommand: ["capture"], audioOutputCommand: ["play"] };
const setup = (params = commands) =>
  plugins.zoomMeetingsPlugin.nodeHandler(JSON.stringify({ action: "setup", ...params }));
const timeoutMessage = "Zoom meeting audio prerequisite check timed out on the node.";
function mockClock(values: number[]) {
  const clock = vi.spyOn(performance, "now");
  values.forEach((value) => clock.mockReturnValueOnce(value));
}
beforeAll(async () => {
  vi.resetModules();
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  try {
    plugins = await loadBrowserMeetingPlugins();
  } finally {
    platform.mockRestore();
  }
});
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  spawnSync.mockReset().mockReturnValue(successfulProbe);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

it.each(["zoomMeetingsPlugin", "teamsMeetingsPlugin", "slackHuddlesPlugin"] as const)(
  "%s wires the shared prerequisite deadline",
  async (key) => {
    const plugin = plugins[key];
    mockClock([0, 0, 6_000, 8_000]);
    const params = JSON.stringify({
      action: "setup",
      audioInputCommand: plugin.config.defaultAudioInputCommand,
      audioOutputCommand: plugin.config.defaultAudioOutputCommand,
      bargeInInputCommand: ["barge-in"],
    });
    await expect(plugin.nodeHandler(params)).resolves.toBe(JSON.stringify(ready));
    expect(spawnSync.mock.calls.map((call) => call[2].timeout)).toEqual([10_000, 4_000, 2_000]);
    expect(spawnSync.mock.calls.slice(1).map(([, args]) => args.at(-1))).toEqual([
      "sox",
      "barge-in",
    ]);
  },
);

it.each(["deadline", "profiler", "command"])(
  "reports %s expiry without further probes",
  async (probe) => {
    if (probe === "deadline") {
      mockClock([1_000, 1_000, 11_000]);
    } else {
      if (probe === "command") {
        spawnSync.mockReturnValueOnce(successfulProbe);
      }
      const error = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
      spawnSync.mockReturnValueOnce({ status: null, stderr: "", stdout: "", error });
    }
    await expect(setup()).rejects.toThrow(timeoutMessage);
    expect(spawnSync).toHaveBeenCalledTimes(probe === "command" ? 2 : 1);
  },
);

it.each([false, true])("provisions Linux audio with existing modules=%s", async (loaded) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(performance, "now").mockReturnValue(0);
  const run = createPulseCommands(loaded);
  spawnSync.mockImplementation((command, args) => run([command, ...args]));
  const overrides = loaded ? { ...commands, bargeInInputCommand: ["barge-in"] } : undefined;
  const result: unknown = JSON.parse(
    await plugins.zoomMeetingsPlugin.nodeHandler(JSON.stringify({ action: "setup", ...overrides })),
  );
  expect(result).toEqual({
    ok: true,
    audioBackend: "pipewire-pulse",
    audioDeviceLabel: "OpenClaw Meeting Audio",
  });
  expect(
    spawnSync.mock.calls
      .filter(([command]) => command === "/bin/sh")
      .map(([, args]) => args.at(-1)),
  ).toEqual(loaded ? ["capture", "play", "barge-in"] : ["parec", "pacat"]);
  expect(
    spawnSync.mock.calls.filter(([, args]) => args[0] === "load-module").map(([, args]) => args[1]),
  ).toEqual(loaded ? [] : ["module-null-sink", "module-remap-source"]);
});
