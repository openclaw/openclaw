import { describe, expect, it } from "vitest";
import { mistralMediaUnderstandingProvider } from "../../extensions/mistral/media-understanding-provider.js";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "./audio.test-helpers.js";

installPinnedHostnameTestHooks();

describe("mistralMediaUnderstandingProvider", () => {
  it("has expected provider metadata", () => {
    expect(mistralMediaUnderstandingProvider.id).toBe("mistral");
    expect(mistralMediaUnderstandingProvider.capabilities).toEqual(["audio"]);
    expect(mistralMediaUnderstandingProvider.transcribeAudio).toBeDefined();
  });

  it("uses Mistral base URL by default", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "bonjour" });

    const result = await mistralMediaUnderstandingProvider.transcribeAudio!({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.ogg",
      apiKey: "test-mistral-key", // pragma: allowlist secret
      timeoutMs: 5000,
      fetchFn,
    });

    expect(getRequest().url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
    expect(result.text).toBe("bonjour");
  });

  it("allows overriding baseUrl", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await mistralMediaUnderstandingProvider.transcribeAudio!({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "key", // pragma: allowlist secret
      timeoutMs: 1000,
      baseUrl: "https://custom.mistral.example/v1",
      fetchFn,
    });

    expect(getRequest().url).toBe("https://custom.mistral.example/v1/audio/transcriptions");
  });
});
