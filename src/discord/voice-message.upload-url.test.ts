import { DiscordError, RateLimitError } from "@buape/carbon";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceMessageMetadata } from "./voice-message.js";
import { sendDiscordVoiceMessage } from "./voice-message.js";

describe("sendDiscordVoiceMessage upload-url step (#16103)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses raw fetch for upload-url to bypass Carbon FormData interception", async () => {
    let fetchCallIndex = 0;
    const fetchCalls: Array<{ init: RequestInit }> = [];

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ init: init ?? {} });
      const idx = fetchCallIndex++;

      // Step 1: upload-url response
      if (idx === 0) {
        return new Response(
          JSON.stringify({
            attachments: [
              {
                upload_url: "https://cdn.discordapp.com/upload/test",
                upload_filename: "attachments/0/voice-message.ogg",
              },
            ],
          }),
          { status: 200 },
        );
      }

      // Step 2: CDN upload response
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const mockRest = {
      post: vi.fn().mockResolvedValue({ id: "msg123", channel_id: "ch456" }),
    };

    const metadata: VoiceMessageMetadata = {
      durationSecs: 5.0,
      waveform: "AAAA",
    };

    const request = async (fn: () => Promise<unknown>) => fn();

    await sendDiscordVoiceMessage(
      mockRest as never,
      "channel123",
      Buffer.from("fake-ogg-data"),
      metadata,
      undefined,
      request as never,
      false,
      "test-bot-token",
    );

    // Step 1 used raw fetch with JSON body (not Carbon's rest.post)
    expect(fetchCalls).toHaveLength(2);
    const step1Headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(step1Headers["Content-Type"]).toBe("application/json");
    expect(step1Headers.Authorization).toBe("Bot test-bot-token");
    const step1Body = JSON.parse(fetchCalls[0].init.body as string);
    expect(step1Body.files[0].filename).toBe("voice-message.ogg");

    // Step 3 used rest.post (Carbon is fine for non-files bodies)
    expect(mockRest.post).toHaveBeenCalledTimes(1);
  });

  it("throws DiscordError with structured payload on upload-url failure", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ message: "Missing Access", code: 50001 }), {
        status: 403,
      });
    }) as typeof fetch;

    const mockRest = { post: vi.fn() };
    const metadata: VoiceMessageMetadata = { durationSecs: 3.0, waveform: "BBBB" };
    const request = async (fn: () => Promise<unknown>) => fn();

    await expect(
      sendDiscordVoiceMessage(
        mockRest as never,
        "channel123",
        Buffer.from("fake-ogg-data"),
        metadata,
        undefined,
        request as never,
        false,
        "test-bot-token",
      ),
    ).rejects.toThrow(DiscordError);
  });

  it("throws RateLimitError on 429 so retry runner can back off", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ message: "You are being rate limited.", retry_after: 1.5, global: false }),
        {
          status: 429,
          headers: {
            "X-RateLimit-Scope": "user",
            "X-RateLimit-Bucket": "abc123",
          },
        },
      );
    }) as typeof fetch;

    const mockRest = { post: vi.fn() };
    const metadata: VoiceMessageMetadata = { durationSecs: 2.0, waveform: "CCCC" };
    const request = async (fn: () => Promise<unknown>) => fn();

    await expect(
      sendDiscordVoiceMessage(
        mockRest as never,
        "channel123",
        Buffer.from("fake-ogg-data"),
        metadata,
        undefined,
        request as never,
        false,
        "test-bot-token",
      ),
    ).rejects.toThrow(RateLimitError);
  });
});
