import { describe, expect, it } from "vitest";

import { telnyxProvider } from "./index.js";

const resolveRequestUrl = (input: RequestInfo | URL) => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

describe("telnyxProvider", () => {
  it("has correct id and capabilities", () => {
    expect(telnyxProvider.id).toBe("telnyx");
    expect(telnyxProvider.capabilities).toEqual(["audio"]);
    expect(telnyxProvider.transcribeAudio).toBeDefined();
  });

  it("uses the correct Telnyx API base URL", async () => {
    let seenUrl: string | null = null;
    const fetchFn = async (input: RequestInfo | URL, _init?: RequestInit) => {
      seenUrl = resolveRequestUrl(input);
      return new Response(JSON.stringify({ text: "transcribed text" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await telnyxProvider.transcribeAudio!({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.ogg",
      apiKey: "test-telnyx-key",
      timeoutMs: 5000,
      fetchFn,
    });

    expect(seenUrl).toBe("https://api.telnyx.com/v2/ai/audio/transcriptions");
    expect(result.text).toBe("transcribed text");
  });

  it("allows overriding the base URL", async () => {
    let seenUrl: string | null = null;
    const fetchFn = async (input: RequestInfo | URL, _init?: RequestInit) => {
      seenUrl = resolveRequestUrl(input);
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await telnyxProvider.transcribeAudio!({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      baseUrl: "https://custom.telnyx.example/v1",
      fetchFn,
    });

    expect(seenUrl).toBe("https://custom.telnyx.example/v1/audio/transcriptions");
  });

  it("sends the correct authorization header", async () => {
    let seenAuth: string | null = null;
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("authorization");
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await telnyxProvider.transcribeAudio!({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "KEY_TELNYX_12345",
      timeoutMs: 1000,
      fetchFn,
    });

    expect(seenAuth).toBe("Bearer KEY_TELNYX_12345");
  });
});
