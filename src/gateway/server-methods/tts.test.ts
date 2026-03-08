import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadConfig = vi.hoisted(() => vi.fn(() => ({}) as OpenClawConfig));
const resolveSessionAgentIds = vi.hoisted(() =>
  vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
);

const mocks = vi.hoisted(() => ({
  resolveTtsConfig: vi.fn(() => ({ kind: "tts-config" })),
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts.json"),
  getTtsProvider: vi.fn(() => "edge"),
  isTtsEnabled: vi.fn(() => true),
  resolveTtsAutoMode: vi.fn(() => "always"),
  resolveTtsProviderOrder: vi.fn(() => ["edge", "openai"]),
  isTtsProviderConfigured: vi.fn((_config, provider: string) => provider === "edge"),
  resolveTtsApiKey: vi.fn(() => undefined),
  setTtsEnabled: vi.fn(),
  setTtsProvider: vi.fn(),
  textToSpeech: vi.fn(async () => ({
    success: true,
    audioPath: "/tmp/audio.mp3",
    provider: "edge",
    outputFormat: "mp3",
    voiceCompatible: true,
  })),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentIds,
}));

vi.mock("../../tts/tts.js", () => ({
  OPENAI_TTS_MODELS: ["gpt-4o-mini-tts"],
  OPENAI_TTS_VOICES: ["alloy"],
  getTtsProvider: mocks.getTtsProvider,
  isTtsEnabled: mocks.isTtsEnabled,
  isTtsProviderConfigured: mocks.isTtsProviderConfigured,
  resolveTtsAutoMode: mocks.resolveTtsAutoMode,
  resolveTtsApiKey: mocks.resolveTtsApiKey,
  resolveTtsConfig: mocks.resolveTtsConfig,
  resolveTtsPrefsPath: mocks.resolveTtsPrefsPath,
  resolveTtsProviderOrder: mocks.resolveTtsProviderOrder,
  setTtsEnabled: mocks.setTtsEnabled,
  setTtsProvider: mocks.setTtsProvider,
  textToSpeech: mocks.textToSpeech,
}));

import { ttsHandlers } from "./tts.js";

async function invoke(
  method: keyof typeof ttsHandlers,
  params: Record<string, unknown> = {},
  respond = vi.fn(),
) {
  await ttsHandlers[method]({
    req: { type: "req", id: "1", method } as never,
    params: params as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("gateway tts handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({} as OpenClawConfig);
    resolveSessionAgentIds.mockReturnValue({ defaultAgentId: "main", sessionAgentId: "main" });
    mocks.resolveTtsConfig.mockReturnValue({ kind: "tts-config" });
    mocks.resolveTtsPrefsPath.mockReturnValue("/tmp/tts.json");
    mocks.getTtsProvider.mockReturnValue("edge");
    mocks.isTtsEnabled.mockReturnValue(true);
    mocks.resolveTtsAutoMode.mockReturnValue("always");
    mocks.resolveTtsProviderOrder.mockReturnValue(["edge", "openai"]);
    mocks.isTtsProviderConfigured.mockImplementation(
      (_config, provider: string) => provider === "edge",
    );
    mocks.resolveTtsApiKey.mockReturnValue(undefined);
    mocks.textToSpeech.mockResolvedValue({
      success: true,
      audioPath: "/tmp/audio.mp3",
      provider: "edge",
      outputFormat: "mp3",
      voiceCompatible: true,
    });
  });

  it("uses explicit agentId for tts.enable prefs resolution", async () => {
    resolveSessionAgentIds.mockReturnValue({ defaultAgentId: "main", sessionAgentId: "ops" });

    await invoke("tts.enable", { agentId: "ops" });

    expect(resolveSessionAgentIds).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        config: expect.any(Object),
      }),
    );
    expect(mocks.resolveTtsConfig).toHaveBeenCalledWith(expect.any(Object), "ops");
    expect(mocks.resolveTtsPrefsPath).toHaveBeenCalledWith({ kind: "tts-config" }, "ops");
    expect(mocks.setTtsEnabled).toHaveBeenCalledWith("/tmp/tts.json", true);
  });

  it("falls back to sessionKey agent for tts.status", async () => {
    resolveSessionAgentIds.mockReturnValue({ defaultAgentId: "main", sessionAgentId: "work" });
    const respond = await invoke("tts.status", { sessionKey: "agent:work:main" });

    expect(resolveSessionAgentIds).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:work:main",
        config: expect.any(Object),
      }),
    );
    expect(mocks.resolveTtsConfig).toHaveBeenCalledWith(expect.any(Object), "work");
    expect(mocks.resolveTtsPrefsPath).toHaveBeenCalledWith({ kind: "tts-config" }, "work");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        enabled: true,
        provider: "edge",
        prefsPath: "/tmp/tts.json",
      }),
    );
  });

  it("passes the effective agentId through tts.convert", async () => {
    resolveSessionAgentIds.mockReturnValue({ defaultAgentId: "main", sessionAgentId: "voice" });

    await invoke("tts.convert", {
      text: "hello there",
      sessionKey: "agent:voice:main",
      channel: "discord",
    });

    expect(mocks.textToSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello there",
        channel: "discord",
        cfg: expect.any(Object),
        agentId: "voice",
      }),
    );
  });
});
