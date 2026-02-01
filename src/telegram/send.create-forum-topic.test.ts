import { type ForumTopic } from "@grammyjs/types";
import { Bot } from "grammy";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createForumTopicTelegram } from "./send.js";

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    channels: {
      telegram: {
        botToken: "tok",
      },
    },
  }),
}));

vi.mock("../infra/channel-activity.js", () => ({
  recordChannelActivity: vi.fn(),
}));

vi.mock("../infra/retry-policy.js", () => ({
  createTelegramRetryRunner: () => (fn: any) => fn(),
}));

vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: ({ fn }: { fn: () => Promise<unknown> }) => fn(),
}));

describe("createForumTopicTelegram", () => {
  const createForumTopicMock = vi.fn();
  const mockApi = {
    createForumTopic: createForumTopicMock,
  } as unknown as Bot["api"];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws error if topic name is empty", async () => {
    await expect(
      createForumTopicTelegram("123", "", {
        api: mockApi,
        token: "tok",
      }),
    ).rejects.toThrow("Forum topic name is required");

    await expect(
      createForumTopicTelegram("123", "   ", {
        api: mockApi,
        token: "tok",
      }),
    ).rejects.toThrow("Forum topic name is required");
  });

  it("throws error if topic name exceeds 128 characters", async () => {
    const longName = "a".repeat(129);
    await expect(
      createForumTopicTelegram("123", longName, {
        api: mockApi,
        token: "tok",
      }),
    ).rejects.toThrow("Forum topic name must be 128 characters or less (received: 129)");
  });

  it("creates a forum topic with default parameters", async () => {
    const mockResult: ForumTopic = {
      message_thread_id: 123,
      name: "Test Topic",
      icon_color: 0x6fb9f0,
    };
    createForumTopicMock.mockResolvedValue(mockResult);

    const result = await createForumTopicTelegram(" telegram:123  ", "Test Topic", {
      api: mockApi,
      token: "tok",
    });

    expect(createForumTopicMock).toHaveBeenCalledWith("123", "Test Topic", undefined);
    expect(result).toEqual({
      threadId: 123,
      name: "Test Topic",
      iconColor: 0x6fb9f0,
    });
  });

  it("prefers iconCustomEmojiId over iconColor", async () => {
    const mockResult: ForumTopic = {
      message_thread_id: 123,
      name: "Emoji Topic",
      icon_custom_emoji_id: "emoji123",
    };
    createForumTopicMock.mockResolvedValue(mockResult);

    await createForumTopicTelegram("123", "Emoji Topic", {
      api: mockApi,
      token: "tok",
      iconColor: 0xff0000,
      iconCustomEmojiId: "emoji123",
    });

    expect(createForumTopicMock).toHaveBeenCalledWith("123", "Emoji Topic", {
      icon_custom_emoji_id: "emoji123",
    });
  });

  it("wraps chat not found error", async () => {
    const error = new Error("400: Bad Request: chat not found");
    createForumTopicMock.mockRejectedValue(error);

    await expect(
      createForumTopicTelegram("123", "Error Topic", {
        api: mockApi,
        token: "tok",
      }),
    ).rejects.toThrow(/chat not found/);
  });

  it("wraps missing rights error", async () => {
    const error = new Error("400: Bad Request: not enough rights");
    createForumTopicMock.mockRejectedValue(error);

    await expect(
      createForumTopicTelegram("123", "Error Topic", {
        api: mockApi,
        token: "tok",
      }),
    ).rejects.toThrow(/bot must be an administrator/);
  });

  it("wraps forum not enabled error", async () => {
    const error = new Error("Bad Request: FORUM_ENABLED key is disabled");
    createForumTopicMock.mockRejectedValue(error);

    await expect(
      createForumTopicTelegram("123", "Error Topic", {
        api: mockApi,
        token: "tok",
      }),
    ).rejects.toThrow(/forum topics are not enabled/);
  });
});
