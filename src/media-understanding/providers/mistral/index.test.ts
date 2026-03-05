import { describe, expect, it } from "vitest";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../audio.test-helpers.js";
import { mistralProvider } from "./index.js";

installPinnedHostnameTestHooks();

describe("mistralProvider", () => {
  it("has expected provider metadata", () => {
    expect(mistralProvider.id).toBe("mistral");
    expect(mistralProvider.capabilities).toEqual(["audio"]);
    expect(mistralProvider.transcribeAudio).toBeDefined();
  });

  it("uses Mistral base URL by default", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "bonjour" });

    const result = await mistralProvider.transcribeAudio!({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.ogg",
      apiKey: "test-mistral-key",
      timeoutMs: 5000,
      fetchFn,
    });

    expect(getRequest().url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
    expect(result.text).toBe("bonjour");
  });

  it("allows overriding baseUrl", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await mistralProvider.transcribeAudio!({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "key",
      timeoutMs: 1000,
      baseUrl: "https://custom.mistral.example/v1",
      fetchFn,
    });

    expect(getRequest().url).toBe("https://custom.mistral.example/v1/audio/transcriptions");
  });
});
