import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import type { ResolvedTtsConfig } from "./tts-config.js";
import {
  resolveExtensionHostTtsProvider,
  resolveExtensionHostTtsRequestSetup,
} from "./tts-runtime-setup.js";

const tempDirs: string[] = [];

function createPrefsPath(contents: object): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-tts-setup-"));
  tempDirs.push(tempDir);
  const prefsPath = path.join(tempDir, "tts.json");
  writeFileSync(prefsPath, JSON.stringify(contents), "utf8");
  return prefsPath;
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

describe("tts-runtime-setup", () => {
  it("prefers the stored provider over config and environment", () => {
    const prefsPath = createPrefsPath({ tts: { provider: "elevenlabs" } });
    const config = createResolvedConfig({
      provider: "openai",
      providerSource: "config",
      openai: {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        apiKey: "config-openai-key",
      },
    });

    withEnv({ OPENAI_API_KEY: "env-openai-key", ELEVENLABS_API_KEY: undefined }, () => {
      expect(resolveExtensionHostTtsProvider(config, prefsPath)).toBe("elevenlabs");
    });
  });

  it("returns a validation error when text exceeds the configured hard limit", () => {
    const config = createResolvedConfig({ maxTextLength: 5 });
    const prefsPath = createPrefsPath({});

    expect(
      resolveExtensionHostTtsRequestSetup({
        text: "too-long",
        config,
        prefsPath,
      }),
    ).toEqual({
      error: "Text too long (8 chars, max 5)",
    });
  });

  it("uses the override provider to build the host-owned fallback order", () => {
    const config = createResolvedConfig({
      provider: "edge",
      providerSource: "config",
    });
    const prefsPath = createPrefsPath({});

    expect(
      resolveExtensionHostTtsRequestSetup({
        text: "hello world",
        config,
        prefsPath,
        providerOverride: "elevenlabs",
      }),
    ).toEqual({
      config,
      providers: ["elevenlabs", "openai", "edge"],
    });
  });
});
