import { describe, expect, it } from "vitest";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "./audio.test-helpers.js";
import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";

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

  it("replaces mismatched upload extensions from the audio MIME type", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: " voice-note.aac ",
      mime: "audio/x-m4a",
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn,
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-mini-transcribe",
    });

    const form = getRequest().init?.body;
    expect(form).toBeInstanceOf(FormData);
    const file = (form as FormData).get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("voice-note.m4a");
  });

  it("falls back to an audio filename when the caller only provides whitespace", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "   ",
      mime: "audio/x-m4a",
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn,
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-mini-transcribe",
    });

    const file = ((getRequest().init?.body as FormData).get("file") as File | null)?.name;
    expect(file).toBe("audio.m4a");
  });
});
