import { describe, expect, it } from "vitest";
import { resolveOpenAiAudioAuthEndpointTrust } from "./openai-audio-api.js";

describe("resolveOpenAiAudioAuthEndpointTrust", () => {
  it.each([
    undefined,
    "https://api.openai.com",
    "https://api.openai.com/v1",
    "https://api.openai.com/v1/",
    "https://us.api.openai.com/v1",
    "https://eu.api.openai.com/v1/",
  ])("trusts native OpenAI audio endpoint %s", (baseUrl) => {
    expect(
      resolveOpenAiAudioAuthEndpointTrust({
        capability: "audio",
        providerId: "openai",
        baseUrl,
      }),
    ).toBe("native-openai");
  });

  it.each([
    "https://openai-compatible.example.test/v1",
    "https://api.openai.com.attacker.example/v1",
    "https://attackerapi.openai.com/v1",
    "http://api.openai.com/v1",
    "https://api.openai.com/proxy/v1",
  ])("treats custom audio endpoint %s as OpenAI-compatible", (baseUrl) => {
    expect(
      resolveOpenAiAudioAuthEndpointTrust({
        capability: "audio",
        providerId: "openai",
        baseUrl,
      }),
    ).toBe("custom-openai-compatible");
  });

  it("leaves non-OpenAI audio providers outside the OpenAI audio auth contract", () => {
    expect(
      resolveOpenAiAudioAuthEndpointTrust({
        capability: "audio",
        providerId: "mistral",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toBeUndefined();
  });
});
