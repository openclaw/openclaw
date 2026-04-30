import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

// Spy on the lazy-loaded tts.runtime so we can observe whether the message
// tool path runs the same TTS hook as auto-reply (see
// src/auto-reply/reply/dispatch-from-config.ts for the auto-reply call site).
const ttsMock = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(
    async (params: { payload: { text?: string; mediaUrl?: string } }) => params.payload,
  ),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMock.maybeApplyTtsToPayload(params as never),
}));

function ttsTaggedConfig(): OpenClawConfig {
  return {
    channels: { testchat: { enabled: true } },
    messages: {
      tts: {
        auto: "tagged",
        provider: "openai",
        providers: { openai: { apiKey: "sk-test" } },
      },
    },
  } as unknown as OpenClawConfig;
}

function ttsOffConfig(): OpenClawConfig {
  return {
    channels: { testchat: { enabled: true } },
    messages: { tts: { auto: "off" } },
  } as unknown as OpenClawConfig;
}

function setupTestChannel() {
  const sendText = vi.fn().mockResolvedValue({
    channel: "testchat",
    messageId: "t1",
    chatId: "c1",
  });
  const sendMedia = vi.fn().mockResolvedValue({
    channel: "testchat",
    messageId: "m1",
    chatId: "c1",
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "testchat",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "testchat",
          outbound: { deliveryMode: "direct", sendText, sendMedia },
        }),
      },
    ]),
  );
  return { sendText, sendMedia };
}

describe("runMessageAction tagged TTS hook", () => {
  beforeEach(() => {
    ttsMock.maybeApplyTtsToPayload.mockClear();
    ttsMock.maybeApplyTtsToPayload.mockImplementation(async (params) => params.payload);
  });
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("invokes maybeApplyTtsToPayload when tagged TTS is configured and no media is attached", async () => {
    const { sendText } = setupTestChannel();
    await runMessageAction({
      cfg: ttsTaggedConfig(),
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        message: "Standup summary. [[tts:text]]Standup summary spoken[[/tts:text]]",
      },
      dryRun: false,
    });
    expect(ttsMock.maybeApplyTtsToPayload).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalled();
  });

  it("does not invoke TTS when auto is off", async () => {
    setupTestChannel();
    await runMessageAction({
      cfg: ttsOffConfig(),
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        message: "Standup summary. [[tts:text]]would-be-spoken[[/tts:text]]",
      },
      dryRun: false,
    });
    expect(ttsMock.maybeApplyTtsToPayload).not.toHaveBeenCalled();
  });

  it("does not invoke TTS when media is already attached", async () => {
    setupTestChannel();
    await runMessageAction({
      cfg: ttsTaggedConfig(),
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        message: "see attachment [[tts:text]]hello[[/tts:text]]",
        media: "https://example.com/cat.png",
      },
      dryRun: false,
    });
    expect(ttsMock.maybeApplyTtsToPayload).not.toHaveBeenCalled();
  });

  it("applies returned audio: visible text and media path on the outbound payload", async () => {
    // The hook-set asVoice flag flows through executeSendAction once the shared
    // asVoice plumbing lands (see #73483); this test only locks in the parts of
    // the contract this patch is responsible for: TTS-stripped visible text and
    // the synthesized media path.
    const { sendMedia } = setupTestChannel();
    ttsMock.maybeApplyTtsToPayload.mockImplementation(async () => ({
      text: "Standup summary.",
      mediaUrl: "/tmp/standup.ogg",
      audioAsVoice: true,
    }));
    await runMessageAction({
      cfg: ttsTaggedConfig(),
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        message: "Standup summary. [[tts:text]]spoken[[/tts:text]]",
      },
      dryRun: false,
    });
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Standup summary.",
        mediaUrl: "/tmp/standup.ogg",
      }),
    );
  });
});
