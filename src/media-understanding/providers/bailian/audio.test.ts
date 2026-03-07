import { describe, expect, it } from "vitest";
import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../audio.test-helpers.js";
import { transcribeBailianAudio } from "./audio.js";

installPinnedHostnameTestHooks();

describe("transcribeBailianAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({
      choices: [{ message: { content: "ok" } }],
    });

    const result = await transcribeBailianAudio({
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

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "ni hao" } }],
    });

    const result = await transcribeBailianAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      apiKey: "test-key",
      timeoutMs: 1234,
      baseUrl: "https://dashscope.example/v1/",
      model: " ",
      language: " zh ",
      mime: "audio/wav",
      headers: { "X-Custom": "1" },
      query: {
        enable_itn: false,
      },
      fetchFn,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.model).toBe("qwen3-asr-flash");
    expect(result.text).toBe("ni hao");
    expect(seenUrl).toBe("https://dashscope.example/v1/chat/completions");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-custom")).toBe("1");

    expect(typeof seenInit?.body).toBe("string");
    const body = JSON.parse(seenInit?.body as string) as {
      model: string;
      stream: boolean;
      asr_options?: Record<string, string | boolean>;
      messages: Array<{
        content: Array<{
          type: string;
          input_audio: {
            data: string;
          };
        }>;
      }>;
    };
    expect(body.model).toBe("qwen3-asr-flash");
    expect(body.stream).toBe(false);
    expect(body.asr_options).toEqual({ language: "zh", enable_itn: false });
    expect(body.messages[0]?.content[0]?.type).toBe("input_audio");
    expect(body.messages[0]?.content[0]?.input_audio.data).toBe(
      `data:audio/wav;base64,${Buffer.from("audio-bytes").toString("base64")}`,
    );
  });

  it("supports structured content arrays in the provider response", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({
      choices: [
        {
          message: {
            content: [{ text: "hello" }, { text: "world" }],
          },
        },
      ],
    });

    const result = await transcribeBailianAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "key",
      timeoutMs: 1000,
      fetchFn,
    });

    expect(result.text).toBe("hello\nworld");
  });

  it("throws when the provider response omits transcript", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({
      choices: [{ message: {} }],
    });

    await expect(
      transcribeBailianAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn,
      }),
    ).rejects.toThrow("Audio transcription response missing text");
  });

  it("rejects audio payloads that exceed the compatible-mode size limit", async () => {
    await expect(
      transcribeBailianAudio({
        buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 1),
        fileName: "voice.wav",
        apiKey: "test-key",
        timeoutMs: 1234,
        fetchFn: async () => {
          throw new Error("fetch should not be called");
        },
      }),
    ).rejects.toThrow("Bailian audio input exceeds the 10MB compatible-mode limit");
  });
});
