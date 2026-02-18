import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceMessageMetadata } from "./voice-message.js";
import { sendDiscordVoiceMessage } from "./voice-message.js";

describe("sendDiscordVoiceMessage upload-url step (#19668)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses raw fetch for upload-url to bypass Carbon FormData interception", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init: init ?? {} });

      // Step 1: upload-url response
      if (url.includes("/attachments")) {
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
      mockRest as any,
      "channel123",
      Buffer.from("fake-ogg-data"),
      metadata,
      undefined,
      request as any,
      false,
      "test-bot-token",
    );

    // Step 1 used raw fetch with JSON body (not Carbon's rest.post)
    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[0].url).toContain("/channels/channel123/attachments");
    const step1Headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(step1Headers["Content-Type"]).toBe("application/json");
    expect(step1Headers.Authorization).toBe("Bot test-bot-token");
    const step1Body = JSON.parse(fetchCalls[0].init.body as string);
    expect(step1Body.files[0].filename).toBe("voice-message.ogg");

    // Step 3 used rest.post (Carbon is fine for non-files bodies)
    expect(mockRest.post).toHaveBeenCalledTimes(1);
  });
});
