import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { openaiTTSStream } from "./tts-core.js";

describe("openaiTTSStream", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.OPENAI_TTS_BASE_URL = "http://localhost:8880/v1";
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    delete process.env.OPENAI_TTS_BASE_URL;
    fetchSpy.mockRestore();
  });

  function createReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(chunks[i]);
          i++;
        } else {
          controller.close();
        }
      },
    });
  }

  it("returns a readable stream from a successful response", async () => {
    const pcmData = Buffer.alloc(320);
    pcmData.writeInt16LE(1000, 0);
    pcmData.writeInt16LE(-1000, 2);

    fetchSpy.mockResolvedValueOnce(new Response(createReadableStream([pcmData]), { status: 200 }));

    const result = await openaiTTSStream({
      text: "hello",
      apiKey: "test-key",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      responseFormat: "pcm",
      timeoutMs: 5000,
    });

    expect(result.stream).toBeDefined();
    expect(typeof result.cleanup).toBe("function");

    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const combined = Buffer.concat(chunks);
    expect(combined.length).toBe(320);
    expect(combined.readInt16LE(0)).toBe(1000);
    expect(combined.readInt16LE(2)).toBe(-1000);
  });

  it("calls cleanup on stream end", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(createReadableStream([Buffer.alloc(10)]), { status: 200 }),
    );

    const result = await openaiTTSStream({
      text: "hello",
      apiKey: "test-key",
      model: "tts-1",
      voice: "alloy",
      responseFormat: "pcm",
      timeoutMs: 5000,
    });

    for await (const _chunk of result.stream) {
      // consume
    }

    // Cleanup should be idempotent
    result.cleanup();
  });

  it("throws on invalid model when not using custom endpoint", async () => {
    delete process.env.OPENAI_TTS_BASE_URL;
    await expect(
      openaiTTSStream({
        text: "hello",
        apiKey: "test-key",
        model: "invalid-model",
        voice: "alloy",
        responseFormat: "pcm",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("Invalid model: invalid-model");
  });

  it("throws on invalid voice when not using custom endpoint", async () => {
    delete process.env.OPENAI_TTS_BASE_URL;
    await expect(
      openaiTTSStream({
        text: "hello",
        apiKey: "test-key",
        model: "tts-1",
        voice: "invalid-voice",
        responseFormat: "pcm",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("Invalid voice: invalid-voice");
  });

  it("throws on HTTP error response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 429 }));

    await expect(
      openaiTTSStream({
        text: "hello",
        apiKey: "test-key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        responseFormat: "pcm",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("OpenAI TTS API error (429)");
  });

  it("throws when response body is missing", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      openaiTTSStream({
        text: "hello",
        apiKey: "test-key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        responseFormat: "pcm",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
  });

  it("does not abort stream when playback exceeds timeoutMs", async () => {
    const pcmData = Buffer.alloc(160);
    // Slow stream that takes longer than timeoutMs to deliver all chunks
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 60));
        controller.enqueue(pcmData);
        controller.close();
      },
    });

    fetchSpy.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const result = await openaiTTSStream({
      text: "hello",
      apiKey: "test-key",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      responseFormat: "pcm",
      timeoutMs: 30, // Very short timeout — only covers connection
    });

    // Stream should complete without abort since timeout is cleared after response
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).length).toBe(160);
  });
});
