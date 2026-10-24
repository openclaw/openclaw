import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));

import { resolveMeetingAudioRuntimeForFormat } from "./audio-backend.js";
import { createPulseCommands } from "./audio-backend.test-support.js";
import { createMeetingConfiguredNodeHost } from "./configured-node-host.js";

const defaults = { backend: "auto", bufferBytes: 4_096, format: "pcm16-24khz" } as const;
const channelMap = "front-left,front-right";
const properties = `'device.description="OpenClaw Meeting Audio"'`;
const sink = "openclaw_meeting_audio";
const modules = [
  [
    "module-null-sink",
    `sink_name=${sink}`,
    "rate=48000",
    "channels=2",
    `channel_map=${channelMap}`,
    `sink_properties=${properties}`,
  ],
  [
    "module-remap-source",
    `source_name=${sink}`,
    `master=${sink}.monitor`,
    "channels=2",
    `master_channel_map=${channelMap}`,
    `channel_map=${channelMap}`,
    "remix=no",
    `source_properties=${properties}`,
  ],
];

function mockPulse(loaded = false) {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(Date, "now").mockReturnValue(0);
  const run = createPulseCommands(loaded);
  spawnSync.mockImplementation((command: string, args: string[]) => run([command, ...args]));
}

function expectCommand(command: string) {
  expect(spawnSync).toHaveBeenCalledWith(
    "/bin/sh",
    ["-lc", 'command -v "$1" >/dev/null 2>&1', "sh", command],
    expect.objectContaining({ encoding: "utf8" }),
  );
}

function createHost() {
  return createMeetingConfiguredNodeHost({
    agentMode: "agent",
    bridgeIdPrefix: "test-node-",
    browser: {
      application: "Google Chrome",
      buildProfileArgs: () => [],
      openedNotes: [],
      openedStatus: "opened",
    },
    browserLabel: "Test meeting",
    commandName: "testmeeting.chrome",
    defaultAudio: defaults,
    defaultAudioInputCommand: ["legacy-capture"],
    defaultAudioOutputCommand: ["legacy-playback"],
    displayName: "Test meeting",
    meetingLabel: "Test meeting",
    normalizeMeetingKey: (url) => url,
    normalizeUrl: (value) => String(value),
    sharePrerequisiteDeadline: true,
    talkBackModes: new Set(["agent", "bidi"]),
  });
}

describe("configured meeting node host", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it.each([false, true])("provisions and probes audio with existing modules=%s", async (loaded) => {
    mockPulse(loaded);
    const overrides = loaded
      ? {
          audioInputCommand: ["trusted-capture", "--raw"],
          audioOutputCommand: ["trusted-playback", "--raw"],
          bargeInInputCommand: ["trusted-barge-in"],
        }
      : {};
    const result: unknown = JSON.parse(
      await createHost()(JSON.stringify({ action: "setup", ...overrides })),
    );

    expect(result).toEqual({
      ok: true,
      audioBackend: "pipewire-pulse",
      audioDeviceLabel: "OpenClaw Meeting Audio",
    });
    for (const command of loaded
      ? ["trusted-capture", "trusted-playback", "trusted-barge-in"]
      : ["parec", "pacat"]) {
      expectCommand(command);
    }
    expect(spawnSync).not.toHaveBeenCalledWith(
      "/bin/sh",
      expect.arrayContaining(["legacy-capture"]),
      expect.anything(),
    );
    const loads = spawnSync.mock.calls.filter(([, args]) => args[0] === "load-module");
    expect(loads).toEqual(
      loaded
        ? []
        : modules.map((args) => [
            "pactl",
            ["load-module", ...args],
            { encoding: "utf8", timeout: 10_000 },
          ]),
    );
  });

  it("selects the native backend for macOS and Linux", () => {
    expect(
      (["darwin", "linux"] as const).map(
        (platform) => resolveMeetingAudioRuntimeForFormat({ ...defaults, platform }).backend,
      ),
    ).toEqual(["blackhole-2ch", "pipewire-pulse"]);
    expect(() => resolveMeetingAudioRuntimeForFormat({ ...defaults, platform: "win32" })).toThrow(
      "unsupported on win32",
    );
  });

  it("builds PipeWire-Pulse raw command pairs", () => {
    const rawArgs = [
      "--raw",
      `--device=${sink}`,
      "--format=s16le",
      "--rate=24000",
      "--channels=1",
      "--latency-msec=86",
    ];
    expect(resolveMeetingAudioRuntimeForFormat({ ...defaults, platform: "linux" })).toMatchObject({
      backend: "pipewire-pulse",
      deviceLabel: "OpenClaw Meeting Audio",
      inputCommand: ["parec", ...rawArgs],
      outputCommand: ["pacat", "--raw", "--playback", ...rawArgs.slice(1)],
    });
  });

  it("preserves explicit command overrides while resolving the host backend", () => {
    expect(
      resolveMeetingAudioRuntimeForFormat({
        ...defaults,
        inputCommand: ["capture"],
        outputCommand: ["playback"],
        platform: "linux",
      }),
    ).toMatchObject({ inputCommand: ["capture"], outputCommand: ["playback"] });
  });
});
