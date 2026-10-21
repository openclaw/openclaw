import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));

import { createPulseCommands } from "./audio-backend.test-support.js";
import { createMeetingConfiguredNodeHost } from "./configured-node-host.js";

function mockPulse(loaded = false) {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
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
    defaultAudio: {
      backend: "auto",
      bufferBytes: 4_096,
      format: "pcm16-24khz",
    },
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

  it("provisions PipeWire-Pulse and probes node-local default commands", async () => {
    mockPulse();
    const result: unknown = JSON.parse(await createHost()(JSON.stringify({ action: "setup" })));

    expect(result).toEqual({
      ok: true,
      audioBackend: "pipewire-pulse",
      audioDeviceLabel: "OpenClaw Meeting Audio",
    });
    expectCommand("parec");
    expectCommand("pacat");
    expect(spawnSync).not.toHaveBeenCalledWith(
      "/bin/sh",
      expect.arrayContaining(["legacy-capture"]),
      expect.anything(),
    );
  });

  it("probes explicit command overrides after provisioning the backend", async () => {
    mockPulse(true);

    await createHost()(
      JSON.stringify({
        action: "setup",
        audioInputCommand: ["trusted-capture", "--raw"],
        audioOutputCommand: ["trusted-playback", "--raw"],
        bargeInInputCommand: ["trusted-barge-in"],
      }),
    );

    for (const command of ["trusted-capture", "trusted-playback", "trusted-barge-in"]) {
      expectCommand(command);
    }
  });
});
