import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../audio.test-helpers.js";
import { transcribeAzureAudio } from "./audio.js";

installPinnedHostnameTestHooks();

describe("transcribeAzureAudio", () => {
  it("uses api-key auth for Azure OpenAI cognitiveservices endpoints", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    const result = await transcribeAzureAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.ogg",
      mime: "audio/ogg",
      apiKey: "test-key",
      model: "whisper",
      baseUrl: "https://oc-01-resource.cognitiveservices.azure.com/openai/deployments/whisper",
      timeoutMs: 5000,
      fetchFn,
    });

    expect(result.text).toBe("ok");
    expect(result.model).toBe("whisper");

    const { url: seenUrl, init: seenInit } = getRequest();
    expect(seenUrl).toBe(
      "https://oc-01-resource.cognitiveservices.azure.com/openai/deployments/whisper/audio/transcriptions?api-version=2025-04-01-preview",
    );

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("api-key")).toBe("test-key");
    expect(headers.get("ocp-apim-subscription-key")).toBeNull();
  });

  it("uses AZURE_OPENAI_API_VERSION when api-version query is not provided", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });
    await withEnvAsync(
      {
        AZURE_FOUNDRY_API_VERSION: undefined,
        AZURE_OPENAI_API_VERSION: "2024-06-01",
      },
      async () => {
        await transcribeAzureAudio({
          buffer: Buffer.from("audio-bytes"),
          fileName: "voice.ogg",
          mime: "audio/ogg",
          apiKey: "test-key",
          model: "whisper",
          baseUrl: "https://oc-01-resource.cognitiveservices.azure.com/openai/deployments/whisper",
          timeoutMs: 5000,
          fetchFn,
        });
      },
    );
    expect(getRequest().url).toBe(
      "https://oc-01-resource.cognitiveservices.azure.com/openai/deployments/whisper/audio/transcriptions?api-version=2024-06-01",
    );
  });

  it("keeps explicit api-version query overrides", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeAzureAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.ogg",
      mime: "audio/ogg",
      apiKey: "test-key",
      model: "whisper",
      baseUrl: "https://oc-01-resource.cognitiveservices.azure.com/openai/deployments/whisper",
      query: { "api-version": "2024-06-01" },
      timeoutMs: 5000,
      fetchFn,
    });

    expect(getRequest().url).toBe(
      "https://oc-01-resource.cognitiveservices.azure.com/openai/deployments/whisper/audio/transcriptions?api-version=2024-06-01",
    );
  });

  it("builds deployment transcription URL from bare endpoint", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeAzureAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.wav",
      mime: "audio/wav",
      apiKey: "test-key",
      model: "gpt-4o-mini-transcribe",
      baseUrl: "https://oc-01-resource.services.ai.azure.com",
      timeoutMs: 5000,
      fetchFn,
    });

    expect(getRequest().url).toBe(
      "https://oc-01-resource.services.ai.azure.com/openai/deployments/gpt-4o-mini-transcribe/audio/transcriptions?api-version=2025-04-01-preview",
    );
  });
});
