import { describe, expect, it } from "vitest";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
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

  it("does not send authorization for the synthetic local auth marker", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      timeoutMs: 1000,
      fetchFn,
      provider: "openai",
      baseUrl: "http://127.0.0.1:8000/v1",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-transcribe",
      request: {
        allowPrivateNetwork: true,
      },
    });

    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("lets explicit request auth override the synthetic local auth marker", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      timeoutMs: 1000,
      fetchFn,
      provider: "openai",
      baseUrl: "http://127.0.0.1:8000/v1",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-transcribe",
      request: {
        allowPrivateNetwork: true,
        auth: {
          mode: "authorization-bearer",
          token: "proxy-token",
        },
      },
    });

    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("authorization")).toBe("Bearer proxy-token");
  });

  it("remaps AAC uploads to an M4A filename before submitting the form", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "voice-note.aac",
      mime: "audio/aac",
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn,
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-transcribe",
    });

    const form = getRequest().init?.body;
    expect(form).toBeInstanceOf(FormData);
    const file = (form as FormData).get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("voice-note.m4a");
  });
});
