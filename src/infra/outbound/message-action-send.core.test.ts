import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { mockFirstRecordArg } from "../../test-utils/mock-call-assertions.js";
import { OutboundDeliveryError } from "./deliver-types.js";
import { runMessageAction as runAction } from "./message-action-runner.js";

type SendInput = Omit<Parameters<typeof runAction>[0], "action" | "cfg"> & { cfg?: OpenClawConfig };
function runMessageAction({ params, ...input }: SendInput) {
  return runAction({
    action: "send",
    cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
    dryRun: false,
    ...input,
    params: { channel: "testchat", target: "channel:abc", ...params },
  });
}

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: ttsMocks.maybeApplyTtsToPayload,
}));

function registerPlugin(
  id: string,
  outbound: NonNullable<ChannelPlugin["outbound"]>,
  overrides: Partial<ChannelPlugin> = {},
) {
  const plugin = { ...createOutboundTestPlugin({ id, outbound }), ...overrides };
  setActivePluginRegistry(createTestRegistry([{ pluginId: id, source: "test", plugin }]));
}
function registerTestChatPlugin(
  outbound: NonNullable<ChannelPlugin["outbound"]>,
  overrides: Partial<ChannelPlugin> = {},
) {
  registerPlugin("testchat", outbound, overrides);
}
const receipt = (channel: string, messageId: string, chatId: string) => ({
  channel,
  messageId,
  chatId,
});

function registerSlackTextPlugin(
  accountIds: string[] = ["default"],
  defaultAccountId?: string,
  deliveryMode: "direct" | "gateway" = "direct",
) {
  const sendText = vi.fn().mockResolvedValue(receipt("slack", "m1", "C123"));
  registerPlugin(
    "slack",
    { deliveryMode, sendText },
    {
      config: {
        listAccountIds: () => accountIds,
        ...(defaultAccountId ? { defaultAccountId: () => defaultAccountId } : {}),
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      threading: { threadAddressing: "message" },
    },
  );
  return sendText;
}

describe("runMessageAction core send routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    ttsMocks.maybeApplyTtsToPayload
      .mockReset()
      .mockImplementation(async (params: { payload: unknown }) => params.payload);
  });

  it.each([
    ["failed", new Error("provider rejected the message"), undefined],
    [
      "partial_failed",
      new OutboundDeliveryError("second send failed", {
        cause: new Error("provider rejected the attachment"),
        results: [{ channel: "testchat", messageId: "first-send-1" }],
        stage: "platform_send",
      }),
      "first-send-1",
    ],
  ] as const)(
    "returns structured %s core delivery outcomes to CLI callers",
    async (expectedStatus, error, expectedMessageId) => {
      const sendText = vi.fn().mockRejectedValue(error);
      registerTestChatPlugin({ deliveryMode: "direct", sendText });

      const result = await runMessageAction({
        params: { message: "hello" },
        gateway: {
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
        },
        conversationReadOrigin: "direct-operator",
      });

      expect(result).toMatchObject({
        kind: "send",
        handledBy: "core",
        sendResult: {
          deliveryStatus: expectedStatus,
          error: expect.any(String),
          ...(expectedMessageId ? { result: { messageId: expectedMessageId } } : {}),
        },
      });
      expect(sendText).toHaveBeenCalledOnce();
    },
  );

  it("keeps throwing core delivery failures for non-CLI callers", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("provider rejected the message"));
    registerTestChatPlugin({ deliveryMode: "direct", sendText });

    await expect(runMessageAction({ params: { message: "hello" } })).rejects.toThrow(
      "provider rejected the message",
    );
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("does not misclassify send as poll when zero-valued poll params are present", async () => {
    const sendMedia = vi.fn().mockResolvedValue(receipt("testchat", "m2", "c1"));
    registerTestChatPlugin({
      deliveryMode: "direct",
      sendText: vi.fn().mockResolvedValue(receipt("testchat", "t2", "c1")),
      sendMedia,
    });
    const result = await runMessageAction({
      params: {
        media: "https://example.com/file.txt",
        message: "hello",
        pollDurationHours: 0,
        pollDurationSeconds: 60,
        pollMulti: false,
        pollPublic: true,
        pollAnonymous: false,
        pollOptionIndex: 0,
        pollQuestion: "",
        pollOption: [],
      },
    });

    expect(result.kind).toBe("send");
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(mockFirstRecordArg(sendMedia, "send media")).toMatchObject({
      text: "hello",
      mediaUrl: "https://example.com/file.txt",
    });
  });

  it("preserves an explicit provider reply target with its canonical thread root", async () => {
    const sendText = vi.fn().mockResolvedValue(receipt("testchat", "m1", "C1"));
    registerTestChatPlugin(
      { deliveryMode: "direct", sendText },
      {
        threading: {
          resolveAutoThreadId: ({ toolContext, replyToId }) =>
            replyToId === toolContext?.currentMessageId ? toolContext?.currentThreadTs : undefined,
          resolveReplyTransport: ({ threadId }) => {
            const root = threadId == null ? undefined : String(threadId);
            return { replyToId: root, threadId: root };
          },
        },
      },
    );

    await runMessageAction({
      params: {
        channel: "testchat",
        target: "channel:C1",
        message: "threaded",
        replyTo: "child-1",
      },
      preparedMessageId: "platform-message-1",
      toolContext: {
        currentChannelProvider: "testchat",
        currentChannelId: "channel:C1",
        currentThreadTs: "root-1",
        currentMessageId: "child-1",
        replyToMode: "all",
      },
    });

    expect(mockFirstRecordArg(sendText, "send text")).toMatchObject({
      replyToId: "root-1",
      replyToIdSource: "explicit",
      threadId: "root-1",
      preparedMessageId: "platform-message-1",
    });
  });

  it.each([
    ["first", {}, ["source-1", undefined], "implicit", "first"],
    ["all", {}, ["source-1", "source-1"], "implicit", "all"],
    ["off", { replyTo: "explicit-1" }, ["explicit-1", "explicit-1"], "explicit", undefined],
  ] as const)(
    "carries resolved reply facts through durable chunk fanout in %s mode",
    async (replyToMode, params, expectedReplyIds, expectedSource, expectedMode) => {
      const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
        channel: "testchat",
        messageId: text,
      }));
      registerTestChatPlugin({
        deliveryMode: "gateway",
        textChunkLimit: 2,
        chunker: (text, limit) => [text.slice(0, limit), text.slice(limit)],
        sendText,
      });

      await runMessageAction({
        params: {
          channel: "testchat",
          target: "channel:C1",
          message: "abcd",
          ...params,
        },
        gatewayOwnedDelivery: true,
        toolContext: {
          currentChannelProvider: "testchat",
          currentChannelId: "channel:C1",
          currentMessagingTarget: "channel:C1",
          currentMessageId: "source-1",
          replyToMode,
          hasRepliedRef: { value: false },
        },
      });

      expect(sendText.mock.calls.map(([call]) => call.replyToId)).toEqual(expectedReplyIds);
      expect(sendText.mock.calls[0]?.[0]).toMatchObject({
        replyToIdSource: expectedSource,
        replyToMode: expectedMode,
      });
    },
  );

  it.each([
    { name: "plugin default", expected: "ada" },
    { name: "sole named account", accountIds: ["ada"], expected: "ada" },
    { name: "agent binding", boundAccountId: "default", expected: "default" },
    {
      name: "host before binding",
      defaultAccountId: "ada",
      boundAccountId: "default",
      expected: "ada",
    },
    {
      name: "explicit before host",
      accountId: "default",
      defaultAccountId: "ada",
      expected: "default",
    },
    { name: "empty account prefix", prefix: "", expected: "ada" },
    { name: "gateway-owned adapter", gatewayOwnedDelivery: true, expected: "ada" },
  ])("uses one account for delivery and prefix: $name", async (testCase) => {
    const sendText = registerSlackTextPlugin(
      testCase.accountIds ?? ["default", "ada"],
      testCase.accountIds ? undefined : "ada",
      testCase.gatewayOwnedDelivery ? "gateway" : "direct",
    );
    await runMessageAction({
      cfg: {
        channels: {
          slack: {
            enabled: true,
            responsePrefix: "[ROOT]",
            accounts: { ada: { responsePrefix: testCase.prefix ?? "[ADA]" } },
          },
        },
        ...(testCase.boundAccountId
          ? {
              bindings: [
                {
                  agentId: "main",
                  match: { channel: "slack", accountId: testCase.boundAccountId },
                },
              ],
            }
          : {}),
      } as OpenClawConfig,
      agentId: "main",
      defaultAccountId: testCase.defaultAccountId,
      gatewayOwnedDelivery: testCase.gatewayOwnedDelivery,
      params: {
        channel: "slack",
        target: "channel:OTHER",
        message: "hello world",
        ...(testCase.accountId ? { accountId: testCase.accountId } : {}),
      },
    });
    const prefix = testCase.expected === "default" ? "[ROOT]" : (testCase.prefix ?? "[ADA]");
    expect(sendText).toHaveBeenCalledOnce();
    expect(mockFirstRecordArg(sendText, "send text")).toMatchObject({
      accountId: testCase.expected,
      text: prefix ? `${prefix} hello world` : "hello world",
    });
  });

  it.each([
    ["[Nexus]", "[Nexus] already prefixed", "[Nexus] already prefixed", false],
    ["[{identity.name}]", "hello world", "[Nexus] hello world", true],
    ["[{provider}/{model}]", "hello world", "hello world", false],
  ] as const)("resolves responsePrefix %s", async (prefix, message, expected, useIdentity) => {
    const sendText = registerSlackTextPlugin();
    await runMessageAction({
      cfg: {
        channels: { slack: { enabled: true, responsePrefix: prefix } },
        ...(useIdentity ? { agents: { entries: { main: { identity: { name: "Nexus" } } } } } : {}),
      } as OpenClawConfig,
      params: { channel: "slack", target: "channel:OTHER", message },
      ...(useIdentity ? { agentId: "main" } : {}),
    });
    expect(sendText).toHaveBeenCalledOnce();
    expect(mockFirstRecordArg(sendText, "send text").text).toBe(expected);
  });

  it("leaves media-only sends without a responsePrefix", async () => {
    const sendMedia = vi.fn().mockResolvedValue(receipt("slack", "m1", "C123"));
    registerPlugin(
      "slack",
      {
        deliveryMode: "direct",
        sendText: vi.fn().mockResolvedValue(receipt("slack", "t1", "C123")),
        sendMedia,
      },
      {
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ enabled: true }),
          isConfigured: () => true,
        },
      },
    );

    await runMessageAction({
      cfg: {
        channels: { slack: { enabled: true, responsePrefix: "[Nexus]" } },
      } as OpenClawConfig,
      params: {
        channel: "slack",
        target: "channel:OTHER",
        media: "https://example.com/cat.png",
      },
    });

    expect(sendMedia).toHaveBeenCalledOnce();
    expect(mockFirstRecordArg(sendMedia, "send media").text ?? "").toBe("");
  });

  it("preserves structured speech through response prefixes when automatic TTS is off", async () => {
    const sendMedia = vi.fn().mockResolvedValue(receipt("testchat", "voice-1", "c1"));
    ttsMocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
      mediaUrl: "file:///tmp/openclaw-voice.ogg",
      audioAsVoice: true,
      spokenText: "hello there",
    });
    registerTestChatPlugin({
      deliveryMode: "direct",
      sendText: vi.fn(),
      sendMedia,
    });

    await runMessageAction({
      cfg: {
        channels: { testchat: { enabled: true, responsePrefix: "[Nexus]" } },
        tts: { auto: "off" },
      } as OpenClawConfig,
      params: {
        message: "Visible greeting",
        voiceText: "hello there",
        voiceProvider: "mock",
        voiceId: "voice-7",
        asVoice: true,
      },
      sessionKey: "agent:main:testchat:channel:abc",
    });

    expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "final",
        channel: "testchat",
        payload: expect.objectContaining({
          text: "[Nexus] Visible greeting",
          audioAsVoice: true,
        }),
      }),
    );
    const ttsPayload = mockFirstRecordArg(ttsMocks.maybeApplyTtsToPayload, "TTS payload").payload;
    expect(typeof ttsPayload === "object" && ttsPayload !== null).toBe(true);
    expect(getReplyPayloadMetadata(ttsPayload as object)?.tts).toEqual({
      tagged: true,
      text: "hello there",
      directives: [{ provider: "mock", values: { voiceid: "voice-7" } }],
    });
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(mockFirstRecordArg(sendMedia, "send media")).toMatchObject({
      text: "",
      mediaUrl: "file:///tmp/openclaw-voice.ogg",
      audioAsVoice: true,
    });
  });

  it("forwards inbound audio context to message-tool TTS", async () => {
    const sendText = vi.fn().mockResolvedValue(receipt("testchat", "text-1", "c1"));
    registerTestChatPlugin({
      deliveryMode: "direct",
      sendText,
    });

    await runMessageAction({
      cfg: {
        channels: { testchat: { enabled: true } },
        tts: { auto: "inbound" },
      } as OpenClawConfig,
      params: { message: "voice reply" },
      sessionKey: "agent:main:testchat:channel:abc",
      inboundAudio: true,
    });

    expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "final",
        channel: "testchat",
        inboundAudio: true,
        payload: expect.objectContaining({
          text: "voice reply",
        }),
      }),
    );
    expect(sendText).toHaveBeenCalledOnce();
  });
});
