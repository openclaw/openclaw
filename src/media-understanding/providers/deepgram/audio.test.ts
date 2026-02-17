import { describe, expect, it } from "vitest";
import { installPinnedHostnameTestHooks, resolveRequestUrl } from "../audio.test-helpers.js";
import { transcribeDeepgramAudio } from "./audio.js";

installPinnedHostnameTestHooks();

describe("transcribeDeepgramAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    let seenAuth: string | null = null;
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("authorization");
      return new Response(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ transcript: "ok" }] }] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const result = await transcribeDeepgramAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { authorization: "Token override" },
      fetchFn,
    });

    expect(seenAuth).toBe("Token override");
    expect(result.text).toBe("ok");
  });

  it("builds the expected request payload", async () => {
    let seenUrl: string | null = null;
    let seenInit: RequestInit | undefined;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = resolveRequestUrl(input);
      seenInit = init;
      return new Response(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ transcript: "hello" }] }] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const result = await transcribeDeepgramAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 1234,
      baseUrl: "https://api.example.com/v1/",
      model: " ",
      language: " en ",
      mime: "audio/wav",
      headers: { "X-Custom": "1" },
      query: {
        punctuate: false,
        smart_format: true,
      },
      fetchFn,
    });

    expect(result.model).toBe("nova-3");
    expect(result.text).toBe("hello");
    expect(seenUrl).toBe(
      "https://api.example.com/v1/listen?model=nova-3&language=en&punctuate=false&smart_format=true",
    );
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Token test-key");
    expect(headers.get("x-custom")).toBe("1");
    expect(headers.get("content-type")).toBe("audio/wav");
    expect(seenInit?.body).toBeInstanceOf(Uint8Array);
  });
});
