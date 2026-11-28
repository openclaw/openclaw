// Local TTS provider selection validates registry membership before saving preferences.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateTtsPrefsAsync: vi.fn(),
  canonicalizeSpeechProviderId: vi.fn(
    (providerId: string | undefined) => providerId?.trim().toLowerCase() || undefined,
  ),
  getSpeechProvider: vi.fn(),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));

// mock-isolation: local provider selection uses fixture preferences and no synthesis runtime.
vi.mock("../../tts/tts.js", () => ({
  getTtsProviderAsync: vi.fn(),
  listTtsPersonas: vi.fn(() => []),
  listSpeechVoices: vi.fn(async () => []),
  resolveExplicitTtsOverridesAsync: vi.fn(),
  resolveTtsConfig: () => ({ providerConfigs: {} }),
  resolveTtsPrefsPathAsync: async () => "/tmp/tts.json",
  textToSpeech: vi.fn(),
}));

// mock-isolation: preference writes are asserted instead of touching machine state.
vi.mock("../../tts/tts-settings-write-worker.js", () => ({
  updateTtsPrefsAsync: mocks.updateTtsPrefsAsync,
}));

vi.mock("../../tts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tts/provider-registry.js")>()),
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
}));

import { runTtsStateMutation } from "./tts-runtime.js";

describe("local TTS provider selection", () => {
  it("rejects an unregistered provider id without saving it", async () => {
    mocks.getSpeechProvider.mockReturnValue(undefined);

    await expect(
      runTtsStateMutation({
        capability: "tts.set-provider",
        transport: "local",
        provider: "elevenlab",
      }),
    ).rejects.toThrow("Unknown speech provider: elevenlab");

    expect(mocks.updateTtsPrefsAsync).not.toHaveBeenCalled();
  });

  it("saves a registered provider without requiring synthesis credentials", async () => {
    mocks.getSpeechProvider.mockImplementation((providerId: string) =>
      providerId === "tts-local-cli" ? { id: providerId } : undefined,
    );

    await expect(
      runTtsStateMutation({
        capability: "tts.set-provider",
        transport: "local",
        provider: " TTS-Local-CLI ",
      }),
    ).resolves.toEqual({ provider: "tts-local-cli" });

    expect(mocks.updateTtsPrefsAsync).toHaveBeenCalledWith("/tmp/tts.json", {
      provider: "tts-local-cli",
    });
  });
});
