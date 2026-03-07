import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadConfig = vi.hoisted(() => vi.fn(() => ({}) as OpenClawConfig));
const resolveTtsConfig = vi.hoisted(() => vi.fn(() => ({}) as object));
const resolveTtsPrefsPath = vi.hoisted(() => vi.fn(() => "/tmp/tts-prefs.json"));
const getTtsProvider = vi.hoisted(() => vi.fn(() => "openai"));
const resolveTtsAutoMode = vi.hoisted(() => vi.fn(() => "off"));
const resolveTtsProviderOrder = vi.hoisted(() => vi.fn(() => ["openai", "edge"]));
const isTtsProviderConfigured = vi.hoisted(() => vi.fn(() => false));
const resolveTtsApiKey = vi.hoisted(() => vi.fn(() => undefined));
const setTtsProvider = vi.hoisted(() => vi.fn());
const setTtsEnabled = vi.hoisted(() => vi.fn());
const textToSpeech = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../../tts/tts.js", () => ({
  OPENAI_TTS_MODELS: ["gpt-4o-mini-tts"],
  OPENAI_TTS_VOICES: ["alloy"],
  getTtsProvider,
  isTtsEnabled: () => true,
  isTtsProviderConfigured,
  resolveTtsAutoMode,
  resolveTtsApiKey,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsProviderOrder,
  setTtsEnabled,
  setTtsProvider,
  textToSpeech,
}));

import { ttsHandlers } from "./tts.js";

async function invokeTtsHandler(
  method: keyof typeof ttsHandlers,
  params: Record<string, unknown>,
  respond: ReturnType<typeof vi.fn>,
) {
  await ttsHandlers[method]({
    req: {} as never,
    params: params as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
}

describe("gateway tts handlers", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveTtsConfig.mockClear();
    resolveTtsPrefsPath.mockClear();
    getTtsProvider.mockClear();
    resolveTtsAutoMode.mockClear();
    resolveTtsProviderOrder.mockClear();
    isTtsProviderConfigured.mockClear();
    resolveTtsApiKey.mockReset();
    setTtsProvider.mockReset();
    setTtsEnabled.mockReset();
    textToSpeech.mockReset();
  });

  it("accepts bailian in tts.setProvider", async () => {
    const respond = vi.fn();

    await invokeTtsHandler("tts.setProvider", { provider: "bailian" }, respond);

    expect(setTtsProvider).toHaveBeenCalledWith("/tmp/tts-prefs.json", "bailian");
    expect(respond).toHaveBeenCalledWith(true, { provider: "bailian" });
  });

  it("lists bailian in tts.providers and reports it as active", async () => {
    resolveTtsApiKey.mockImplementation((_config, provider: string) =>
      provider === "bailian" ? "dashscope-key" : undefined,
    );
    getTtsProvider.mockReturnValue("bailian");
    const respond = vi.fn();

    await invokeTtsHandler("tts.providers", {}, respond);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        active: "bailian",
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: "bailian",
            name: "Bailian",
            configured: true,
            models: ["qwen3-tts-flash"],
          }),
        ]),
      }),
    );
  });
});
