import { describe, expect, it, vi } from "vitest";
import { createSlackDraftStream } from "./draft-stream.js";

describe("createSlackDraftStream", () => {
  it("sends the first update and edits subsequent updates", async () => {
    const send = vi.fn(async () => ({
      channelId: "C123",
      messageId: "111.222",
    }));
    const edit = vi.fn(async () => {});
    const stream = createSlackDraftStream({
      target: "channel:C123",
      token: "xoxb-test",
      throttleMs: 250,
      send,
      edit,
    });

    stream.update("hello");
    await stream.flush();
    stream.update("hello world");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("C123", "111.222", "hello world", {
      token: "xoxb-test",
      accountId: undefined,
    });
  });

  it("does not send duplicate text", async () => {
    const send = vi.fn(async () => ({
      channelId: "C123",
      messageId: "111.222",
    }));
    const edit = vi.fn(async () => {});
    const stream = createSlackDraftStream({
      target: "channel:C123",
      token: "xoxb-test",
      throttleMs: 250,
      send,
      edit,
    });

    stream.update("same");
    await stream.flush();
    stream.update("same");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(0);
  });

  it("supports forceNewMessage for subsequent assistant messages", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ channelId: "C123", messageId: "111.222" })
      .mockResolvedValueOnce({ channelId: "C123", messageId: "333.444" });
    const edit = vi.fn(async () => {});
    const stream = createSlackDraftStream({
      target: "channel:C123",
      token: "xoxb-test",
      throttleMs: 250,
      send,
      edit,
    });

    stream.update("first");
    await stream.flush();
    stream.forceNewMessage();
    stream.update("second");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledTimes(0);
    expect(stream.messageId()).toBe("333.444");
  });

  it("stops when text exceeds max chars", async () => {
    const send = vi.fn(async () => ({
      channelId: "C123",
      messageId: "111.222",
    }));
    const edit = vi.fn(async () => {});
    const warn = vi.fn();
    const stream = createSlackDraftStream({
      target: "channel:C123",
      token: "xoxb-test",
      maxChars: 5,
      throttleMs: 250,
      send,
      edit,
      warn,
    });

    stream.update("123456");
    await stream.flush();
    stream.update("ok");
    await stream.flush();

    expect(send).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clear removes preview message when one exists", async () => {
    const send = vi.fn(async () => ({
      channelId: "C123",
      messageId: "111.222",
    }));
    const edit = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const stream = createSlackDraftStream({
      target: "channel:C123",
      token: "xoxb-test",
      throttleMs: 250,
      send,
      edit,
      remove,
    });

    stream.update("hello");
    await stream.flush();
    await stream.clear();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("C123", "111.222", {
      token: "xoxb-test",
      accountId: undefined,
    });
    expect(stream.messageId()).toBeUndefined();
    expect(stream.channelId()).toBeUndefined();
  });

  it("clear is a no-op when no preview message exists", async () => {
    const send = vi.fn(async () => ({
      channelId: "C123",
      messageId: "111.222",
    }));
    const edit = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const stream = createSlackDraftStream({
      target: "channel:C123",
      token: "xoxb-test",
      throttleMs: 250,
      send,
      edit,
      remove,
    });

    await stream.clear();

    expect(remove).not.toHaveBeenCalled();
  });
});
