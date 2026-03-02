import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const transcribeFirstAudioMock = vi.fn();

vi.mock("../media-understanding/audio-preflight.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

describe("buildTelegramMessageContext audio transcript body", () => {
  it("uses preflight transcript as BodyForAgent for mention-gated group voice messages", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("hey bot please help");

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        date: 1700000000,
        text: undefined,
        from: { id: 42, first_name: "Alice" },
        voice: { file_id: "voice-1" },
      },
      allMedia: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
      options: { forceWasMentioned: true },
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: ["\\bbot\\b"] } },
      },
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

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 2,
        chat: { id: -1001234567891, type: "supergroup", title: "Test Group 2" },
        date: 1700000100,
        text: undefined,
        from: { id: 43, first_name: "Bob" },
        voice: { file_id: "voice-2" },
      },
      allMedia: [{ path: "/tmp/voice2.ogg", contentType: "audio/ogg" }],
      options: { forceWasMentioned: true },
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: ["\\bbot\\b"] } },
      },
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

  it("uses topic disableAudioPreflight=false to override group disableAudioPreflight=true", async () => {
    transcribeFirstAudioMock.mockResolvedValueOnce("topic override transcript");

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 3,
        chat: { id: -1001234567892, type: "supergroup", title: "Test Group 3" },
        date: 1700000200,
        text: undefined,
        from: { id: 44, first_name: "Cara" },
        voice: { file_id: "voice-3" },
      },
      allMedia: [{ path: "/tmp/voice3.ogg", contentType: "audio/ogg" }],
      options: { forceWasMentioned: true },
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: ["\\bbot\\b"] } },
      },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true, disableAudioPreflight: true },
        topicConfig: { disableAudioPreflight: false },
      }),
    });

    expect(ctx).not.toBeNull();
    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(ctx?.ctxPayload?.BodyForAgent).toBe("topic override transcript");
    expect(ctx?.ctxPayload?.Body).toContain("topic override transcript");
    expect(ctx?.ctxPayload?.Body).not.toContain("<media:audio>");
  });

  it("uses topic disableAudioPreflight=true to override group disableAudioPreflight=false", async () => {
    transcribeFirstAudioMock.mockClear();

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 4,
        chat: { id: -1001234567893, type: "supergroup", title: "Test Group 4" },
        date: 1700000300,
        text: undefined,
        from: { id: 45, first_name: "Dan" },
        voice: { file_id: "voice-4" },
      },
      allMedia: [{ path: "/tmp/voice4.ogg", contentType: "audio/ogg" }],
      options: { forceWasMentioned: true },
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
        channels: { telegram: {} },
        messages: { groupChat: { mentionPatterns: ["\\bbot\\b"] } },
      },
      resolveGroupActivation: () => true,
      resolveGroupRequireMention: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: true, disableAudioPreflight: false },
        topicConfig: { disableAudioPreflight: true },
      }),
    });

    expect(ctx).not.toBeNull();
    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(ctx?.ctxPayload?.Body).toContain("<media:audio>");
  });
});
