import { describe, expect, it } from "vitest";
import { transcribeSarvamAudio, DEFAULT_SARVAM_AUDIO_MODEL } from "./audio.js";

const resolveRequestUrl = (input: Request | string | URL) => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

describe("transcribeSarvamAudio", () => {
  it("builds the expected request with default options", async () => {
    let seenUrl: string | null = null;
    let seenInit: RequestInit | undefined;
    const fetchFn = async (input: RequestInfo | URL, _init?: RequestInit) => {
      seenUrl = resolveRequestUrl(input);
      seenInit = _init;
      return new Response(
        JSON.stringify({ transcript: "hello world" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const result = await transcribeSarvamAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-api-key",
      timeoutMs: 5000,
      fetchFn,
    });

    expect(result.text).toBe("hello world");
    expect(result.model).toBe(DEFAULT_SARVAM_AUDIO_MODEL);
    expect(seenUrl).toBe("https://api.sarvam.ai/speech-to-text");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    // Check headers
    const headers = new Headers(seenInit?.headers);
    expect(headers.get("api-subscription-key")).toBe("test-api-key");

    // Check FormData
    const form = seenInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe(DEFAULT_SARVAM_AUDIO_MODEL);

    const file = form.get("file") as Blob;
    expect(file).not.toBeNull();
    expect(file.type).toBe("application/octet-stream");
  });

  it("respects custom baseUrl", async () => {
    let seenUrl: string | null = null;
    const fetchFn = async (input: RequestInfo | URL, _init?: RequestInit) => {
      seenUrl = resolveRequestUrl(input);
      return new Response(
        JSON.stringify({ transcript: "ok" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await transcribeSarvamAudio({
      buffer: Buffer.from("audio"),
      fileName: "test.mp3",
      apiKey: "key",
      timeoutMs: 1000,
      baseUrl: "https://custom.sarvam.ai/v2/",
      fetchFn,
    });

    expect(seenUrl).toBe("https://custom.sarvam.ai/v2/speech-to-text");
  });

  it("sends language_code when provided", async () => {
    let seenInit: RequestInit | undefined;
    const fetchFn = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      seenInit = _init;
      return new Response(
        JSON.stringify({ transcript: "namaste" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const result = await transcribeSarvamAudio({
      buffer: Buffer.from("audio"),
      fileName: "hindi.mp3",
      apiKey: "key",
      timeoutMs: 1000,
      language: "hi-IN",
      fetchFn,
    });

    expect(result.text).toBe("namaste");
    const form = seenInit?.body as FormData;
    expect(form.get("language_code")).toBe("hi-IN");
  });

  it("sends correct model parameter", async () => {
    let seenInit: RequestInit | undefined;
    const fetchFn = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      seenInit = _init;
      return new Response(
        JSON.stringify({ transcript: "test" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const result = await transcribeSarvamAudio({
      buffer: Buffer.from("audio"),
      fileName: "test.mp3",
      apiKey: "key",
      timeoutMs: 1000,
      model: "saaras:v3",
      fetchFn,
    });

    expect(result.model).toBe("saaras:v3");
    const form = seenInit?.body as FormData;
    expect(form.get("model")).toBe("saaras:v3");
  });

  it("handles query parameters for advanced features", async () => {
    let seenInit: RequestInit | undefined;
    const fetchFn = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      seenInit = _init;
      return new Response(
        JSON.stringify({ transcript: "speaker 1: hello" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await transcribeSarvamAudio({
      buffer: Buffer.from("audio"),
      fileName: "meeting.wav",
      apiKey: "key",
      timeoutMs: 1000,
      query: {
        with_diarization: true,
        num_speakers: 2,
        with_timestamps: true,
        mode: "transcribe",
      },
      fetchFn,
    });

    const form = seenInit?.body as FormData;
    expect(form.get("with_diarization")).toBe("true");
    expect(form.get("num_speakers")).toBe("2");
    expect(form.get("with_timestamps")).toBe("true");
    expect(form.get("mode")).toBe("transcribe");
  });

  it("respects api-subscription-key header override", async () => {
    let seenApiKey: string | null = null;
    const fetchFn = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const headers = new Headers(_init?.headers);
      seenApiKey = headers.get("api-subscription-key");
      return new Response(
        JSON.stringify({ transcript: "ok" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await transcribeSarvamAudio({
      buffer: Buffer.from("audio"),
      fileName: "test.mp3",
      apiKey: "default-key",
      timeoutMs: 1000,
      headers: { "api-subscription-key": "override-key" },
      fetchFn,
    });

    expect(seenApiKey).toBe("override-key");
  });

  it("handles mime type correctly", async () => {
    let seenInit: RequestInit | undefined;
    const fetchFn = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      seenInit = _init;
      return new Response(
        JSON.stringify({ transcript: "test" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await transcribeSarvamAudio({
      buffer: Buffer.from("audio"),
      fileName: "recording.mp3",
      apiKey: "key",
      timeoutMs: 1000,
      mime: "audio/mpeg",
      fetchFn,
    });

    const form = seenInit?.body as FormData;
    const file = form.get("file") as Blob;
    expect(file.type).toBe("audio/mpeg");
  });

  it("throws on HTTP error", async () => {
    const fetchFn = async () => {
      return new Response(
        JSON.stringify({ error: "Invalid API key" }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await expect(
      transcribeSarvamAudio({
        buffer: Buffer.from("audio"),
        fileName: "test.mp3",
        apiKey: "bad-key",
        timeoutMs: 1000,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription failed (HTTP 401)");
  });

  it("throws when transcript is missing", async () => {
    const fetchFn = async () => {
      return new Response(
        JSON.stringify({ language_code: "hi-IN" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    await expect(
      transcribeSarvamAudio({
        buffer: Buffer.from("audio"),
        fileName: "test.mp3",
        apiKey: "key",
        timeoutMs: 1000,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription response missing transcript");
  });

  it("trims whitespace from transcript", async () => {
    const fetchFn = async () => {
      return new Response(
        JSON.stringify({ transcript: "  hello world  " }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const result = await transcribeSarvamAudio({
      buffer: Buffer.from("audio"),
      fileName: "test.mp3",
      apiKey: "key",
      timeoutMs: 1000,
      fetchFn,
    });

    expect(result.text).toBe("hello world");
  });
});


