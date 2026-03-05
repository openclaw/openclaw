import { describe, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import type { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "./streaming.js";

describe("Slack streaming text passthrough", () => {
  it("starts stream with raw markdown text payload", async () => {
    const streamer: ChatStreamer = {
      append: vi.fn(),
      stop: vi.fn(),
    } as ChatStreamer;

    const client = {
      chatStream: vi.fn().mockReturnValue(streamer),
    } as unknown as WebClient;

    await startSlackStream({
      client,
      channel: "C1",
      threadTs: "123.456",
      text: "**bold**",
    });

    expect(streamer.append).toHaveBeenCalledWith({ markdown_text: "**bold**" });
    expect(streamer.append).not.toHaveBeenCalledWith({ markdown_text: "*bold*" });
  });

  it("appends subsequent markdown chunks without normalization", async () => {
    const streamer: ChatStreamer = {
      append: vi.fn(),
      stop: vi.fn(),
    } as ChatStreamer;

    const streamSession = { streamer, channel: "C1", threadTs: "123.456", stopped: false };

    await appendSlackStream({
      session: streamSession,
      text: "`code` and **bold**",
    });

    expect(streamer.append).toHaveBeenCalledWith({ markdown_text: "`code` and **bold**" });
  });

  it("stops stream without normalizing final text", async () => {
    const streamer: ChatStreamer = {
      append: vi.fn(),
      stop: vi.fn(),
    } as ChatStreamer;

    const streamSession = { streamer, channel: "C1", threadTs: "123.456", stopped: false };

    await stopSlackStream({
      session: streamSession,
      text: "**final**",
    });

    expect(streamer.stop).toHaveBeenCalledWith({ markdown_text: "**final**" });
  });
});
