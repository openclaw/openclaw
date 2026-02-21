import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContext } from "./bot-message-context.js";

const transcribeFirstAudioMock = vi.fn();

vi.mock("../media-understanding/audio-preflight.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

describe("buildTelegramMessageContext audio transcript body", () => {
  it("uses preflight transcript as BodyForAgent for mention-gated group voice messages", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("hey bot please help");

    const ctx = await buildTelegramMessageContext({
      primaryCtx: {
        message: {
          message_id: 1,
          chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
          date: 1700000000,
          from: { id: 42, first_name: "Alice" },
          voice: { file_id: "voice-1" },
        },
        me: { id: 7, username: "bot" },
      } as never,
      allMedia: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
      storeAllowFrom: [],
      options: { forceWasMentioned: true },
      bot: {
        api: {
          sendChatAction: vi.fn(),
          setMessageReaction: vi.fn(),
        },
      } as never,
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: ["\\bbot\\b"] } },
      } as never,
      account: { accountId: "default" } as never,
      historyLimit: 0,
      groupHistories: new Map(),
      dmPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      ackReactionScope: "off",
      logger: { info: vi.fn() },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true },
        topicConfig: undefined,
      }),
    });

    expect(ctx).not.toBeNull();
    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(ctx?.ctxPayload?.BodyForAgent).toBe("hey bot please help");
    expect(ctx?.ctxPayload?.Body).toContain("hey bot please help");
    expect(ctx?.ctxPayload?.Body).not.toContain("<media:audio>");
  });

  it("skips preflight transcription when disableAudioPreflight is true", async () => {
    transcribeFirstAudioMock.mockClear();

    const ctx = await buildTelegramMessageContext({
      primaryCtx: {
        message: {
          message_id: 2,
          chat: { id: -1001234567891, type: "supergroup", title: "Test Group 2" },
          date: 1700000100,
          from: { id: 43, first_name: "Bob" },
          voice: { file_id: "voice-2" },
        },
        me: { id: 7, username: "bot" },
      } as never,
      allMedia: [{ path: "/tmp/voice2.ogg", contentType: "audio/ogg" }],
      storeAllowFrom: [],
      options: { forceWasMentioned: true },
      bot: {
        api: {
          sendChatAction: vi.fn(),
          setMessageReaction: vi.fn(),
        },
      } as never,
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: ["\\bbot\\b"] } },
      } as never,
      account: { accountId: "default" } as never,
      historyLimit: 0,
      groupHistories: new Map(),
      dmPolicy: "open",
      allowFrom: [],
      groupAllowFrom: [],
      ackReactionScope: "off",
      logger: { info: vi.fn() },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true, disableAudioPreflight: true },
        topicConfig: undefined,
      }),
    });

    expect(ctx).not.toBeNull();
    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(ctx?.ctxPayload?.Body).toContain("<media:audio>");
  });
});
