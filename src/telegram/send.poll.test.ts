import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { sendPollTelegram } from "./send.js";

describe("sendPollTelegram", () => {
  it("maps durationSeconds to open_period", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ message_id: 123, chat: { id: 555 }, poll: { id: "p1" } })),
    };

    const res = await sendPollTelegram(
      "123",
      { question: " Q ", options: [" A ", "B "], durationSeconds: 60 },
      { token: "t", api: api as unknown as Bot["api"] },
    );

    expect(res).toEqual({ messageId: "123", chatId: "555", pollId: "p1" });
    expect(api.sendPoll).toHaveBeenCalledTimes(1);
    const sendPollMock = api.sendPoll as ReturnType<typeof vi.fn>;
    expect(sendPollMock.mock.calls[0]?.[0]).toBe("123");
    expect(sendPollMock.mock.calls[0]?.[1]).toBe("Q");
    expect(sendPollMock.mock.calls[0]?.[2]).toEqual(["A", "B"]);
    expect(sendPollMock.mock.calls[0]?.[3]).toMatchObject({ open_period: 60 });
  });

  it("retries without message_thread_id on thread-not-found", async () => {
    const api = {
      sendPoll: vi.fn(
        async (_chatId: string, _question: string, _options: string[], params: unknown) => {
          const p = params as { message_thread_id?: unknown } | undefined;
          if (p?.message_thread_id) {
            throw new Error("400: Bad Request: message thread not found");
          }
          return { message_id: 1, chat: { id: 2 }, poll: { id: "p2" } };
        },
      ),
    };

    const res = await sendPollTelegram(
      "123",
      { question: "Q", options: ["A", "B"] },
      { token: "t", api: api as unknown as Bot["api"], messageThreadId: 99 },
    );

    expect(res).toEqual({ messageId: "1", chatId: "2", pollId: "p2" });
    expect(api.sendPoll).toHaveBeenCalledTimes(2);
    const sendPollMock = api.sendPoll as ReturnType<typeof vi.fn>;
    expect(sendPollMock.mock.calls[0]?.[3]).toMatchObject({ message_thread_id: 99 });
    expect(
      (sendPollMock.mock.calls[1]?.[3] as { message_thread_id?: unknown } | undefined)
        ?.message_thread_id,
    ).toBeUndefined();
  });

  it("rejects fractional durationHours after poll normalization", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ message_id: 123, chat: { id: 555 }, poll: { id: "p1" } })),
    };

    await expect(
      sendPollTelegram(
        "123",
        { question: "Q", options: ["A", "B"], durationHours: 0.01 },
        { token: "t", api: api as unknown as Bot["api"] },
      ),
    ).rejects.toThrow(/durationHours must be at least 1/i);
    expect(api.sendPoll).not.toHaveBeenCalled();
  });

  it("rejects out-of-range durationHours", async () => {
    const api = { sendPoll: vi.fn() };

    await expect(
      sendPollTelegram(
        "123",
        { question: "Q", options: ["A", "B"], durationHours: 1 },
        { token: "t", api: api as unknown as Bot["api"] },
      ),
    ).rejects.toThrow(/durationSeconds must be between 5 and 600/i);

    expect(api.sendPoll).not.toHaveBeenCalled();
  });

  it("defaults to non-anonymous polls in direct chats", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ message_id: 10, chat: { id: 123 }, poll: { id: "p3" } })),
    };

    await sendPollTelegram(
      "123",
      { question: "Q", options: ["A", "B"] },
      { token: "t", api: api as unknown as Bot["api"] },
    );

    const sendPollMock = api.sendPoll as ReturnType<typeof vi.fn>;
    expect(sendPollMock.mock.calls[0]?.[3]).toMatchObject({ is_anonymous: false });
  });

  it("defaults to non-anonymous polls in group chats", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ message_id: 11, chat: { id: -1001 }, poll: { id: "p4" } })),
    };

    await sendPollTelegram(
      "-1001",
      { question: "Q", options: ["A", "B"] },
      { token: "t", api: api as unknown as Bot["api"] },
    );

    const sendPollMock = api.sendPoll as ReturnType<typeof vi.fn>;
    expect(sendPollMock.mock.calls[0]?.[3]).toMatchObject({ is_anonymous: false });
  });
});
