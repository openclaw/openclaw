import { describe, expect, it, vi } from "vitest";
import type { SlackStreamSession } from "./streaming.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "./streaming.js";

function createMockStreamer() {
  const append = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  return { append, stop };
}

function createMockClient(streamer: ReturnType<typeof createMockStreamer>) {
  return {
    chatStream: vi.fn(() => streamer),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- mock
}

function createMockSession(streamer: ReturnType<typeof createMockStreamer>): SlackStreamSession {
  return {
    streamer: streamer as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- mock
    channel: "C123",
    threadTs: "1000.1",
    stopped: false,
  };
}

describe("slack native streaming does not double-convert markdown", () => {
  it("startSlackStream passes raw markdown to markdown_text", async () => {
    const streamer = createMockStreamer();
    const client = createMockClient(streamer);

    await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1000.1",
      text: "**bold** and *italic*",
    });

    expect(streamer.append).toHaveBeenCalledWith({
      markdown_text: "**bold** and *italic*",
    });
  });

  it("appendSlackStream passes raw markdown to markdown_text", async () => {
    const streamer = createMockStreamer();
    const session = createMockSession(streamer);

    await appendSlackStream({
      session,
      text: "**bold** and ~~strike~~",
    });

    expect(streamer.append).toHaveBeenCalledWith({
      markdown_text: "**bold** and ~~strike~~",
    });
  });

  it("stopSlackStream passes raw markdown to markdown_text", async () => {
    const streamer = createMockStreamer();
    const session = createMockSession(streamer);

    await stopSlackStream({
      session,
      text: "**final bold**",
    });

    expect(streamer.stop).toHaveBeenCalledWith({
      markdown_text: "**final bold**",
    });
  });

  it("does not convert **bold** to *bold* (mrkdwn)", async () => {
    const streamer = createMockStreamer();
    const client = createMockClient(streamer);

    await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1000.1",
      text: "**important text**",
    });

    const call = streamer.append.mock.calls[0] as unknown as [{ markdown_text: string }];
    // Must NOT be mrkdwn-converted "*important text*"
    expect(call[0].markdown_text).toBe("**important text**");
    expect(call[0].markdown_text).not.toBe("*important text*");
  });
});
