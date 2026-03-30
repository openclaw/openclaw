import { beforeEach, describe, expect, it, vi } from "vitest";

const ttsMocks = vi.hoisted(() => ({
  getResolvedSpeechProviderConfig: vi.fn(),
  getLastTtsAttempt: vi.fn(),
  getTtsMaxLength: vi.fn(),
  getTtsProvider: vi.fn(),
  isSummarizationEnabled: vi.fn(),
  isTtsEnabled: vi.fn(),
  isTtsProviderConfigured: vi.fn(),
  resolveTtsConfig: vi.fn(),
  resolveTtsPrefsPath: vi.fn(),
  setLastTtsAttempt: vi.fn(),
  setSummarizationEnabled: vi.fn(),
  setTtsEnabled: vi.fn(),
  setTtsMaxLength: vi.fn(),
  setTtsProvider: vi.fn(),
  textToSpeech: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: vi.fn((provider: string) => provider),
  getSpeechProvider: vi.fn(() => null),
  listSpeechProviders: vi.fn(() => []),
}));

vi.mock("../../tts/tts.js", () => ttsMocks);

const { handleTtsCommands } = await import("./commands-tts.js");

function buildTtsParams(commandBodyNormalized: string): Parameters<typeof handleTtsCommands>[0] {
  return {
    cfg: {},
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderId: "owner",
      channel: "telegram",
    },
  } as unknown as Parameters<typeof handleTtsCommands>[0];
}

describe("handleTtsCommands status fallback reporting", () => {
  beforeEach(() => {
    ttsMocks.resolveTtsConfig.mockReturnValue({});
    ttsMocks.resolveTtsPrefsPath.mockReturnValue("/tmp/tts-prefs.json");
    ttsMocks.isTtsEnabled.mockReturnValue(true);
    ttsMocks.getTtsProvider.mockReturnValue("elevenlabs");
    ttsMocks.isTtsProviderConfigured.mockReturnValue(true);
    ttsMocks.getTtsMaxLength.mockReturnValue(1500);
    ttsMocks.isSummarizationEnabled.mockReturnValue(true);
    ttsMocks.getLastTtsAttempt.mockReturnValue(undefined);
  });

  it("shows fallback provider details for successful attempts", async () => {
    ttsMocks.getLastTtsAttempt.mockReturnValue({
      timestamp: Date.now() - 1_000,
      success: true,
      textLength: 128,
      summarized: false,
      provider: "microsoft",
      fallbackFrom: "elevenlabs",
      attemptedProviders: ["elevenlabs", "microsoft"],
      latencyMs: 420,
    });

    const result = await handleTtsCommands(buildTtsParams("/tts status"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Fallback: elevenlabs → microsoft");
    expect(result?.reply?.text).toContain("Attempts: elevenlabs -> microsoft");
  });

  it("shows attempted provider chain for failed attempts", async () => {
    ttsMocks.getLastTtsAttempt.mockReturnValue({
      timestamp: Date.now() - 1_000,
      success: false,
      textLength: 128,
      summarized: false,
      error: "TTS conversion failed",
      attemptedProviders: ["elevenlabs", "microsoft"],
      latencyMs: 420,
    });

    const result = await handleTtsCommands(buildTtsParams("/tts status"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Error: TTS conversion failed");
    expect(result?.reply?.text).toContain("Attempts: elevenlabs -> microsoft");
  });
});
