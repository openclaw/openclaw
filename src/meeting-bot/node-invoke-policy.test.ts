import { describe, expect, it, vi } from "vitest";
import { createMeetingBrowserNodeInvokePolicy } from "./node-invoke-policy.js";

const audio = {
  audioBackend: "auto" as const,
  audioBufferBytes: 4_096,
  audioFormat: "pcm16-24khz" as const,
  bargeInInputCommand: ["trusted-barge-in"],
};
const route = { url: "https://meeting.test/call", mode: "bidi" };

describe("meeting browser node invoke policy audio", () => {
  it("forwards configured start audio without local generated commands", async () => {
    const policy = createMeetingBrowserNodeInvokePolicy({
      commandName: "testmeeting.chrome",
      deniedCode: "TEST_MEETING_DENIED",
      displayName: "Test meeting",
      normalizeUrl: (value) => String(value),
      start: {
        ...audio,
        launch: true,
        joinTimeoutMs: 30_000,
        // Local generated commands must never become remote overrides.
        audioInputCommand: ["gateway-generated-capture"],
        audioOutputCommand: ["gateway-generated-playback"],
        audioInputCommandOverride: undefined,
        audioOutputCommandOverride: undefined,
      },
      supportedModes: new Set(["agent", "bidi", "transcribe"]),
      useConfiguredSetupCommands: true,
    });
    const invokeNode = vi.fn(async () => ({ ok: true as const }));
    await policy.handle({
      command: "testmeeting.chrome",
      config: {},
      invokeNode,
      nodeId: "node-1",
      params: {
        action: "start",
        ...route,
        audioBackend: "blackhole-2ch",
        audioBufferBytes: 1,
        audioFormat: "g711-ulaw-8khz",
        audioInputCommand: ["caller-capture"],
        audioOutputCommand: ["caller-playback"],
      },
    });
    expect(invokeNode).toHaveBeenCalledWith({
      params: {
        action: "start",
        ...audio,
        ...route,
        launch: true,
        browserProfile: undefined,
        joinTimeoutMs: 30_000,
      },
    });
  });
});
