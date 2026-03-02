import { describe, expect, it } from "vitest";
import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../audio.test-helpers.js";
import { mimeToAudioFormat, transcribeOpenRouterAudio } from "./audio.js";

installPinnedHostnameTestHooks();

describe("transcribeOpenRouterAudio", () => {
  it("builds an OpenRouter chat completions request with input_audio", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "hello world" } }],
    });

    const result = await transcribeOpenRouterAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "note.wav",
      apiKey: "or-test-key",
      timeoutMs: 1500,
      baseUrl: "https://openrouter.ai/api/v1/",
      model: "google/gemini-3-flash-preview",
      headers: { "X-Trace": "1" },
      fetchFn,
    });
    const { url, init } = getRequest();

    expect(result.text).toBe("hello world");
    expect(result.model).toBe("google/gemini-3-flash-preview");
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer or-test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-trace")).toBe("1");

    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      model?: string;
      messages?: Array<{
        content?: Array<{
          type?: string;
          text?: string;
          input_audio?: { data?: string; format?: string };
        }>;
      }>;
    };
    expect(body.model).toBe("google/gemini-3-flash-preview");
    expect(body.messages?.[0]?.content?.[0]).toMatchObject({
      type: "text",
      text: "Transcribe the audio.",
    });
    expect(body.messages?.[0]?.content?.[1]?.type).toBe("input_audio");
    expect(body.messages?.[0]?.content?.[1]?.input_audio?.format).toBe("wav");
    expect(body.messages?.[0]?.content?.[1]?.input_audio?.data).toBe(
      Buffer.from("audio-bytes").toString("base64"),
    );
  });

  it("respects authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({
      choices: [{ message: { content: "ok" } }],
    });

    const result = await transcribeOpenRouterAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { authorization: "Bearer override" },
      fetchFn,
    });

    expect(getAuthHeader()).toBe("Bearer override");
    expect(result.text).toBe("ok");
  });

  it("uses default model when model is empty", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "transcribed" } }],
    });

    const result = await transcribeOpenRouterAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.wav",
      apiKey: "key",
      timeoutMs: 1000,
      model: "  ",
      fetchFn,
    });

    expect(result.model).toBe("google/gemini-3-flash-preview");
    const { init } = getRequest();
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    expect(body.model).toBe("google/gemini-3-flash-preview");
  });

  it("uses custom prompt when provided", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "done" } }],
    });

    await transcribeOpenRouterAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.wav",
      apiKey: "key",
      timeoutMs: 1000,
      prompt: " Custom transcription prompt ",
      fetchFn,
    });

    const { init } = getRequest();
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    expect(body.messages?.[0]?.content?.[0]?.text).toBe("Custom transcription prompt");
  });

  it("throws when the response has no content", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "" } }],
    });

    await expect(
      transcribeOpenRouterAudio({
        buffer: Buffer.from("audio"),
        fileName: "note.wav",
        apiKey: "key",
        timeoutMs: 1000,
        fetchFn,
      }),
    ).rejects.toThrow("OpenRouter audio transcription response missing content");
  });

  it("throws when choices array is empty", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({ choices: [] });

    await expect(
      transcribeOpenRouterAudio({
        buffer: Buffer.from("audio"),
        fileName: "note.wav",
        apiKey: "key",
        timeoutMs: 1000,
        fetchFn,
      }),
    ).rejects.toThrow("OpenRouter audio transcription response missing content");
  });
});

describe("mimeToAudioFormat", () => {
  it("maps common audio MIME types to format strings", () => {
    expect(mimeToAudioFormat("audio/wav")).toBe("wav");
    expect(mimeToAudioFormat("audio/mp3")).toBe("mp3");
    expect(mimeToAudioFormat("audio/mpeg")).toBe("mp3");
    expect(mimeToAudioFormat("audio/ogg")).toBe("ogg");
    expect(mimeToAudioFormat("audio/flac")).toBe("flac");
    expect(mimeToAudioFormat("audio/m4a")).toBe("m4a");
    expect(mimeToAudioFormat("audio/x-m4a")).toBe("m4a");
    expect(mimeToAudioFormat("audio/aac")).toBe("aac");
  });

  it("falls back to wav for unknown MIME types", () => {
    expect(mimeToAudioFormat("audio/unknown")).toBe("wav");
    expect(mimeToAudioFormat(undefined)).toBe("wav");
  });
});
