import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/plugin-registration.types.js";
import { createMeetingBrowserNodeInvokePolicy } from "./node-invoke-policy.js";

const expectedAudio = {
  audioBackend: "auto",
  audioBufferBytes: 4_096,
  audioFormat: "pcm16-24khz",
  bargeInInputCommand: ["trusted-barge-in"],
};

async function expectForwarded(
  params: Record<string, unknown>,
  expected: Record<string, unknown>,
  audio: {
    audioInputCommandOverride?: string[];
    audioOutputCommandOverride?: string[];
  } = {},
) {
  const policy = createMeetingBrowserNodeInvokePolicy({
    commandName: "testmeeting.chrome",
    deniedCode: "TEST_MEETING_DENIED",
    displayName: "Test meeting",
    normalizeUrl: (value) => String(value),
    start: {
      launch: true,
      joinTimeoutMs: 30_000,
      audioBackend: "auto",
      audioBufferBytes: 4_096,
      audioFormat: "pcm16-24khz",
      // Resolved local commands remain available to local Chrome but are not node overrides.
      audioInputCommand: ["gateway-generated-capture"],
      audioInputCommandOverride: audio.audioInputCommandOverride,
      audioOutputCommand: ["gateway-generated-playback"],
      audioOutputCommandOverride: audio.audioOutputCommandOverride,
      bargeInInputCommand: ["trusted-barge-in"],
    },
    supportedModes: new Set(["agent", "bidi", "transcribe"]),
    useConfiguredSetupCommands: true,
  });
  const invokeNode = vi.fn(async () => ({ ok: true as const }));
  const context: OpenClawPluginNodeInvokePolicyContext = {
    command: "testmeeting.chrome",
    config: {},
    invokeNode,
    nodeId: "node-1",
    params,
  };
  await policy.handle(context);
  expect(invokeNode).toHaveBeenCalledWith({ params: expected });
}

describe("meeting browser node invoke policy audio", () => {
  it("forwards trusted declarations without gateway-generated command defaults", async () => {
    await expectForwarded(
      {
        action: "start",
        url: "https://meeting.test/call",
        mode: "bidi",
        audioBackend: "blackhole-2ch",
        audioBufferBytes: 1,
        audioFormat: "g711-ulaw-8khz",
        audioInputCommand: ["caller-capture"],
        audioOutputCommand: ["caller-playback"],
      },
      {
        action: "start",
        url: "https://meeting.test/call",
        mode: "bidi",
        launch: true,
        browserProfile: undefined,
        joinTimeoutMs: 30_000,
        ...expectedAudio,
      },
    );
  });

  it("forwards only trusted explicit command overrides for setup", async () => {
    await expectForwarded(
      {
        action: "setup",
        audioInputCommand: ["caller-capture"],
        audioOutputCommand: ["caller-playback"],
      },
      {
        action: "setup",
        ...expectedAudio,
        audioInputCommand: ["trusted-capture", "--raw"],
        audioOutputCommand: ["trusted-playback", "--raw"],
      },
      {
        audioInputCommandOverride: ["trusted-capture", "--raw"],
        audioOutputCommandOverride: ["trusted-playback", "--raw"],
      },
    );
  });
});
