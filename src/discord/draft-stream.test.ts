import { Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { createDiscordDraftStream } from "./draft-stream.js";

function createHarness(params?: {
  throttleMs?: number;
  minInitialChars?: number;
  post?: (typeof vi)["fn"];
  patch?: (typeof vi)["fn"];
  del?: (typeof vi)["fn"];
}) {
  const rest = {
    post: params?.post ?? vi.fn().mockResolvedValue({ id: "17" }),
    patch: params?.patch ?? vi.fn().mockResolvedValue({}),
    delete: params?.del ?? vi.fn().mockResolvedValue({}),
  };
  const stream = createDiscordDraftStream({
    rest: rest as never,
    channelId: "123",
    throttleMs: params?.throttleMs,
    minInitialChars: params?.minInitialChars,
  });
  return { rest, stream };
}

describe("createDiscordDraftStream", () => {
  it("creates a new message after forceNewMessage is called", async () => {
    const { rest, stream } = createHarness({
      post: vi.fn().mockResolvedValueOnce({ id: "17" }).mockResolvedValueOnce({ id: "42" }),
    });

    stream.update("Hello");
    await stream.flush();
    expect(rest.post).toHaveBeenCalledTimes(1);

    stream.update("Hello edited");
    await stream.flush();
    expect(rest.patch).toHaveBeenCalledWith(Routes.channelMessage("123", "17"), {
      body: { content: "Hello edited" },
    });

    stream.forceNewMessage();
    stream.update("After thinking");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.post).toHaveBeenLastCalledWith(Routes.channelMessages("123"), {
      body: { content: "After thinking" },
    });
    expect(stream.messageId()).toBe("42");
  });

  it("sends first update immediately after forceNewMessage within throttle window", async () => {
    vi.useFakeTimers();
    try {
      const { rest, stream } = createHarness({
        throttleMs: 1000,
        post: vi.fn().mockResolvedValueOnce({ id: "17" }).mockResolvedValueOnce({ id: "42" }),
      });

      stream.update("Hello");
      await vi.waitFor(() => expect(rest.post).toHaveBeenCalledTimes(1));

      stream.update("Hello edited");
      expect(rest.patch).not.toHaveBeenCalled();

      stream.forceNewMessage();
      stream.update("Second message");
      await vi.waitFor(() => expect(rest.post).toHaveBeenCalledTimes(2));
      expect(rest.post).toHaveBeenLastCalledWith(Routes.channelMessages("123"), {
        body: { content: "Second message" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rebind to an old message when forceNewMessage races an in-flight send", async () => {
    let resolveFirstSend: ((value: { id: string }) => void) | undefined;
    const firstSend = new Promise<{ id: string }>((resolve) => {
      resolveFirstSend = resolve;
    });
    const post = vi.fn().mockReturnValueOnce(firstSend).mockResolvedValueOnce({ id: "42" });
    const { rest, stream } = createHarness({ post });

    stream.update("Message A partial");
    await vi.waitFor(() => expect(rest.post).toHaveBeenCalledTimes(1));

    stream.forceNewMessage();
    stream.update("Message B partial");

    resolveFirstSend?.({ id: "17" });
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.post).toHaveBeenNthCalledWith(2, Routes.channelMessages("123"), {
      body: { content: "Message B partial" },
    });
    expect(rest.patch).not.toHaveBeenCalled();
    expect(stream.messageId()).toBe("42");
  });
});
