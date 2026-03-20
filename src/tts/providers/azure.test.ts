import { afterEach, describe, expect, it, vi } from "vitest";
import { listAzureVoices } from "./azure.js";

describe("listAzureVoices", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps Azure voice metadata into speech voice options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            Name: "Microsoft Server Speech Text to Speech Voice (zh-HK, HiuMaanNeural)",
            DisplayName: "HiuMaan Neural (zh-HK)",
            LocalName: "HiuMaan",
            ShortName: "zh-HK-HiuMaanNeural",
            Gender: "Female",
            Locale: "zh-HK",
            VoiceType: "Neural",
            Status: "Available",
          },
          {
            Name: "Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)",
            DisplayName: "Xiaoxiao Neural (zh-CN)",
            ShortName: "zh-CN-XiaoxiaoNeural",
            Gender: "Female",
            Locale: "zh-CN",
            VoiceType: "Neural",
            Status: "Available",
          },
        ]),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const voices = await listAzureVoices({
      apiKey: "test-key",
      region: "eastus",
    });

    expect(voices).toEqual([
      {
        id: "zh-HK-HiuMaanNeural",
        name: "HiuMaan Neural (zh-HK)",
        category: "Neural",
        locale: "zh-HK",
        gender: "Female",
      },
      {
        id: "zh-CN-XiaoxiaoNeural",
        name: "Xiaoxiao Neural (zh-CN)",
        category: "Neural",
        locale: "zh-CN",
        gender: "Female",
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Ocp-Apim-Subscription-Key": "test-key",
        }),
      }),
    );
  });

  it("filters out deprecated voices", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            ShortName: "zh-HK-HiuMaanNeural",
            Gender: "Female",
            Locale: "zh-HK",
            Status: "Available",
          },
          {
            ShortName: "zh-HK-OldVoice",
            Gender: "Male",
            Locale: "zh-HK",
            Status: "Deprecated",
          },
        ]),
        { status: 200 },
      ),
    ) as typeof globalThis.fetch;

    const voices = await listAzureVoices({
      apiKey: "test-key",
    });

    expect(voices).toHaveLength(1);
    expect(voices[0].id).toBe("zh-HK-HiuMaanNeural");
  });

  it("throws on Azure voice list failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 503 })) as typeof globalThis.fetch;

    await expect(
      listAzureVoices({ apiKey: "test-key", region: "eastus" }),
    ).rejects.toThrow("Azure voices API error (503)");
  });

  it("uses custom baseUrl when provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    ) as typeof globalThis.fetch;

    await listAzureVoices({
      apiKey: "test-key",
      baseUrl: "https://custom.region.tts.speech.microsoft.com",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://custom.region.tts.speech.microsoft.com/cognitiveservices/voices/list",
      expect.any(Object),
    );
  });
});
