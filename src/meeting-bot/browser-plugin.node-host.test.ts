import type { SpawnSyncReturns } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { loadBrowserMeetingPlugins } from "./browser-plugin.test-support.js";

const spawnSync = vi.hoisted(() =>
  vi.fn<
    (
      command: string,
      args: string[],
      options: { timeout: number },
    ) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error">
  >(),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));

const declarations = [
  {
    name: "Zoom meeting",
    load: async () => (await loadBrowserMeetingPlugins()).zoomMeetingsPlugin,
  },
  {
    name: "Microsoft Teams meeting",
    load: async () => (await loadBrowserMeetingPlugins()).teamsMeetingsPlugin,
  },
  {
    name: "Slack huddle",
    load: async () => (await loadBrowserMeetingPlugins()).slackHuddlesPlugin,
  },
];
const successfulProbe = { status: 0, stderr: "", stdout: "BlackHole 2ch" };
const setupParams = JSON.stringify({
  action: "setup",
  audioInputCommand: ["capture"],
  audioOutputCommand: ["play"],
});
const ready = JSON.stringify({
  ok: true,
  audioBackend: "blackhole-2ch",
  audioDeviceLabel: "BlackHole 2ch",
});

beforeAll(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe.each(declarations)("$name node prerequisite setup", ({ name, load }) => {
  let plugin: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    // Audio command defaults are captured when each declaration loads.
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      plugin = await load();
    } finally {
      platform.mockRestore();
    }
  });
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    spawnSync.mockReset().mockReturnValue(successfulProbe);
  });

  it.each([
    { now: [0, 0, 6_000, 8_000], timeouts: [10_000, 4_000, 2_000] },
    { now: [1_000, 1_000, 4_000, 8_000], timeouts: [10_000, 7_000, 3_000] },
  ])("shares one deadline across sequential probes ($timeouts)", async ({ now, timeouts }) => {
    const clock = vi.spyOn(Date, "now");
    for (const value of now) {
      clock.mockReturnValueOnce(value);
    }
    await expect(plugin.nodeHandler(setupParams)).resolves.toBe(ready);
    expect(spawnSync.mock.calls.map((call) => call[2].timeout)).toEqual(timeouts);
  });

  it("probes the default sox executable only once", async () => {
    await expect(
      plugin.nodeHandler(
        JSON.stringify({
          action: "setup",
          audioInputCommand: plugin.config.defaultAudioInputCommand,
          audioOutputCommand: plugin.config.defaultAudioOutputCommand,
        }),
      ),
    ).resolves.toBe(ready);
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync.mock.calls[1]?.[1]).toEqual([
      "-lc",
      'command -v "$1" >/dev/null 2>&1',
      "sh",
      "sox",
    ]);
  });

  it("does not start another probe after the shared deadline expires", async () => {
    const clock = vi.spyOn(Date, "now");
    for (const value of [1_000, 1_000, 11_000]) {
      clock.mockReturnValueOnce(value);
    }
    await expect(plugin.nodeHandler(setupParams)).rejects.toThrow(
      `${name} audio prerequisite check timed out on the node.`,
    );
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it.each(["profiler", "command"])(
    "reports a timed-out %s separately from a missing prerequisite",
    async (probe) => {
      if (probe === "command") {
        spawnSync.mockReturnValueOnce(successfulProbe);
      }
      const error = Object.assign(new Error(`spawnSync ${probe} ETIMEDOUT`), { code: "ETIMEDOUT" });
      spawnSync.mockReturnValueOnce({ status: null, stderr: "", stdout: "", error });
      await expect(plugin.nodeHandler(setupParams)).rejects.toThrow(
        `${name} audio prerequisite check timed out on the node.`,
      );
      expect(spawnSync).toHaveBeenCalledTimes(probe === "command" ? 2 : 1);
    },
  );
});
