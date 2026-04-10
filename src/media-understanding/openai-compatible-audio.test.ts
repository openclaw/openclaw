import { describe, expect, it } from "vitest";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "./audio.test-helpers.js";
import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";

function decodeBody(body: BodyInit | null | undefined): string {
  if (!body) {
    return "";
  }
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    return Buffer.from(body).toString("utf8");
  }
  if (typeof body === "string") {
    return body;
  }
  // FormData, Blob, URLSearchParams, ReadableStream — not expected in these tests
  return "[non-string body]";
}

installPinnedHostnameTestHooks();

describe("transcribeOpenAiCompatibleAudio", () => {
  it("adds hidden attribution headers on the native OpenAI audio host", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn,
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-transcribe",
    });

    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("originator")).toBe("openclaw");
    expect(headers.get("version")).toBeTruthy();
    expect(headers.get("user-agent")).toMatch(/^openclaw\//);
  });

  it("does not add hidden attribution headers on custom OpenAI-compatible hosts", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn,
      provider: "openai",
      baseUrl: "https://proxy.example.com/v1",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-transcribe",
    });

    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("originator")).toBeNull();
    expect(headers.get("version")).toBeNull();
    expect(headers.get("user-agent")).toBeNull();
  });

  describe("multipart body construction", () => {
    it("sends a Buffer body with explicit multipart/form-data Content-Type", async () => {
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

      await transcribeOpenAiCompatibleAudio({
        buffer: Buffer.from("audio-bytes"),
        fileName: "clip.ogg",
        mime: "audio/ogg",
        apiKey: "k",
        timeoutMs: 1000,
        fetchFn,
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-transcribe",
        model: "whisper-1",
      });

      const { init } = getRequest();
      const headers = new Headers(init?.headers);
      const ct = headers.get("content-type") ?? "";
      expect(ct).toMatch(/^multipart\/form-data; boundary=/);
      // Body must be a Buffer, not a FormData instance
      expect(Buffer.isBuffer(init?.body)).toBe(true);
    });

    it("encodes the file, model, language, and prompt fields correctly", async () => {
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });
      const audioBytes = Buffer.from("raw-audio");

      await transcribeOpenAiCompatibleAudio({
        buffer: audioBytes,
        fileName: "voice.ogg",
        mime: "audio/ogg; codecs=opus",
        apiKey: "k",
        timeoutMs: 1000,
        fetchFn,
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-transcribe",
        model: "whisper-1",
        language: "en",
        prompt: "test prompt",
      });

      const { init } = getRequest();
      const bodyStr = decodeBody(init?.body);

      expect(bodyStr).toContain('name="file"');
      expect(bodyStr).toContain('filename="voice.ogg"');
      expect(bodyStr).toContain("Content-Type: audio/ogg; codecs=opus");
      expect(bodyStr).toContain(audioBytes.toString("binary"));
      expect(bodyStr).toContain('name="model"');
      expect(bodyStr).toContain("whisper-1");
      expect(bodyStr).toContain('name="language"');
      expect(bodyStr).toContain("en");
      expect(bodyStr).toContain('name="prompt"');
      expect(bodyStr).toContain("test prompt");
    });

    it("sanitizes quotes and CRLF in the filename", async () => {
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

      await transcribeOpenAiCompatibleAudio({
        buffer: Buffer.from("audio"),
        fileName: 'bad"name\r\nInjected: header',
        apiKey: "k",
        timeoutMs: 1000,
        fetchFn,
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-transcribe",
      });

      const bodyStr = decodeBody(getRequest().init?.body);
      expect(bodyStr).toContain('filename="bad%22nameInjected: header"');
    });

    it("strips CR/LF from mime type", async () => {
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

      await transcribeOpenAiCompatibleAudio({
        buffer: Buffer.from("audio"),
        fileName: "clip.ogg",
        mime: "audio/ogg\r\nInjected: header",
        apiKey: "k",
        timeoutMs: 1000,
        fetchFn,
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-transcribe",
      });

      const bodyStr = decodeBody(getRequest().init?.body);
      expect(bodyStr).toContain("Content-Type: audio/oggInjected: header");
      expect(bodyStr).not.toContain("\r\nInjected:");
    });

    it("falls back to application/octet-stream when mime is empty after sanitization", async () => {
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

      await transcribeOpenAiCompatibleAudio({
        buffer: Buffer.from("audio"),
        fileName: "clip.ogg",
        mime: "\r\n",
        apiKey: "k",
        timeoutMs: 1000,
        fetchFn,
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-transcribe",
      });

      const bodyStr = decodeBody(getRequest().init?.body);
      expect(bodyStr).toContain("Content-Type: application/octet-stream");
    });

    it("omits language and prompt fields when not provided", async () => {
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

      await transcribeOpenAiCompatibleAudio({
        buffer: Buffer.from("audio"),
        fileName: "note.mp3",
        apiKey: "k",
        timeoutMs: 1000,
        fetchFn,
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-transcribe",
      });

      const bodyStr = decodeBody(getRequest().init?.body);
      expect(bodyStr).not.toContain('name="language"');
      expect(bodyStr).not.toContain('name="prompt"');
    });
  });
});
