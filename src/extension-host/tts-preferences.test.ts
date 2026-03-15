import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import type { ResolvedTtsConfig } from "./tts-config.js";
import {
  getExtensionHostTtsMaxLength,
  isExtensionHostTtsEnabled,
  isExtensionHostTtsSummarizationEnabled,
  resolveExtensionHostTtsAutoMode,
  resolveExtensionHostTtsPrefsPath,
  setExtensionHostTtsAutoMode,
  setExtensionHostTtsMaxLength,
  setExtensionHostTtsSummarizationEnabled,
} from "./tts-preferences.js";

const tempDirs: string[] = [];

function createPrefsPath(): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-tts-prefs-"));
  tempDirs.push(tempDir);
  return path.join(tempDir, "tts.json");
}

function createResolvedConfig(overrides?: Partial<ResolvedTtsConfig>): ResolvedTtsConfig {
  return {
    auto: "off",
    mode: "final",
    provider: "edge",
    providerSource: "default",
    modelOverrides: {
      enabled: true,
      allowText: true,
      allowProvider: false,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    },
    elevenlabs: {
      baseUrl: "https://api.elevenlabs.io",
      voiceId: "voice-id",
      modelId: "eleven_multilingual_v2",
      voiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0,
        useSpeakerBoost: true,
        speed: 1,
      },
    },
    openai: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    },
    edge: {
      enabled: true,
      voice: "en-US-MichelleNeural",
      lang: "en-US",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      outputFormatConfigured: false,
      saveSubtitles: false,
    },
    maxTextLength: 4096,
    timeoutMs: 30_000,
    ...overrides,
  };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("tts-preferences", () => {
  it("prefers config prefsPath over env and default locations", () => {
    const config = createResolvedConfig({ prefsPath: "~/custom-tts.json" });

    withEnv({ OPENCLAW_TTS_PREFS: "/tmp/ignored-tts.json" }, () => {
      expect(resolveExtensionHostTtsPrefsPath(config)).toContain("custom-tts.json");
    });
  });

  it("resolves session, persisted, and config auto modes in precedence order", () => {
    const prefsPath = createPrefsPath();
    const config = createResolvedConfig({ auto: "inbound" });

    setExtensionHostTtsAutoMode(prefsPath, "tagged");

    expect(
      resolveExtensionHostTtsAutoMode({
        config,
        prefsPath,
        sessionAuto: "always",
      }),
    ).toBe("always");
    expect(resolveExtensionHostTtsAutoMode({ config, prefsPath })).toBe("tagged");

    const persisted = JSON.parse(readFileSync(prefsPath, "utf8")) as {
      tts?: { auto?: string; enabled?: boolean };
    };
    expect(persisted.tts?.auto).toBe("tagged");
    expect("enabled" in (persisted.tts ?? {})).toBe(false);
  });

  it("persists max-length and summarization preferences through the host helper", () => {
    const prefsPath = createPrefsPath();
    const config = createResolvedConfig({ auto: "always" });

    setExtensionHostTtsMaxLength(prefsPath, 900);
    setExtensionHostTtsSummarizationEnabled(prefsPath, false);

    expect(getExtensionHostTtsMaxLength(prefsPath)).toBe(900);
    expect(isExtensionHostTtsSummarizationEnabled(prefsPath)).toBe(false);
    expect(isExtensionHostTtsEnabled(config, prefsPath)).toBe(true);
  });
});
