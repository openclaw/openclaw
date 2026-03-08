import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { createConfigIO } from "./io.js";
import { normalizeTalkSection } from "./talk.js";

const envVar = (...parts: string[]) => parts.join("_");
const elevenLabsApiKeyEnv = ["ELEVENLABS_API", "KEY"].join("_");

async function withTempConfig(
  config: unknown,
  run: (configPath: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-talk-"));
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  try {
    await run(configPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("talk normalization", () => {
  it("maps legacy ElevenLabs fields into provider/providers", () => {
    const normalized = normalizeTalkSection({
      voiceId: "voice-123",
      voiceAliases: { Clawd: "EXAVITQu4vr4xnSDxMaL" }, // pragma: allowlist secret
      modelId: "eleven_v3",
      outputFormat: "pcm_44100",
      apiKey: "secret-key", // pragma: allowlist secret
      interruptOnSpeech: false,
    });

    expect(normalized).toEqual({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          voiceId: "voice-123",
          voiceAliases: { Clawd: "EXAVITQu4vr4xnSDxMaL" },
          modelId: "eleven_v3",
          outputFormat: "pcm_44100",
          apiKey: "secret-key", // pragma: allowlist secret
        },
      },
      voiceId: "voice-123",
      voiceAliases: { Clawd: "EXAVITQu4vr4xnSDxMaL" },
      modelId: "eleven_v3",
      outputFormat: "pcm_44100",
      apiKey: "secret-key", // pragma: allowlist secret
      interruptOnSpeech: false,
    });
  });

  it("uses new provider/providers shape directly when present", () => {
    const normalized = normalizeTalkSection({
      provider: "acme",
      providers: {
        acme: {
          voiceId: "acme-voice",
          custom: true,
        },
      },
      voiceId: "legacy-voice",
      interruptOnSpeech: true,
    });

    expect(normalized).toEqual({
      provider: "acme",
      providers: {
        acme: {
          voiceId: "acme-voice",
          custom: true,
        },
      },
      voiceId: "legacy-voice",
      interruptOnSpeech: true,
    });
  });

  it("preserves SecretRef apiKey values during normalization", () => {
    const normalized = normalizeTalkSection({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
        },
      },
    });

    expect(normalized).toEqual({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
        },
      },
    });
  });

  it("merges ELEVENLABS_API_KEY into normalized defaults for legacy configs", async () => {
    // pragma: allowlist secret
    const elevenLabsApiKey = "env-eleven-key"; // pragma: allowlist secret
    await withEnvAsync({ [elevenLabsApiKeyEnv]: elevenLabsApiKey }, async () => {
      await withTempConfig(
        {
          talk: {
            voiceId: "voice-123",
          },
        },
        async (configPath) => {
          const io = createConfigIO({ configPath });
          const snapshot = await io.readConfigFileSnapshot();
          expect(snapshot.config.talk?.provider).toBe("elevenlabs");
          expect(snapshot.config.talk?.providers?.elevenlabs?.voiceId).toBe("voice-123");
          expect(snapshot.config.talk?.providers?.elevenlabs?.apiKey).toBe(elevenLabsApiKey);
          expect(snapshot.config.talk?.apiKey).toBe(elevenLabsApiKey);
        },
      );
    });
  });

  it("preserves baseUrl in provider config", () => {
    const normalized = normalizeTalkSection({
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          voiceId: "voice-123",
          baseUrl: "https://custom.tts.example.com",
        },
      },
    });

    expect(normalized?.providers?.elevenlabs?.baseUrl).toBe("https://custom.tts.example.com");
  });

  it("trims and normalizes baseUrl as a string field", () => {
    const normalized = normalizeTalkSection({
      providers: {
        elevenlabs: {
          baseUrl: "  http://localhost:8880  ",
        },
      },
    });

    expect(normalized?.providers?.elevenlabs?.baseUrl).toBe("http://localhost:8880");
  });

  it("does not apply ELEVENLABS_API_KEY when active provider is not elevenlabs", async () => {
    const elevenLabsApiKey = "env-eleven-key"; // pragma: allowlist secret
    await withEnvAsync({ [elevenLabsApiKeyEnv]: elevenLabsApiKey }, async () => {
      await withTempConfig(
        {
          talk: {
            provider: "acme",
            providers: {
              acme: {
                voiceId: "acme-voice",
              },
            },
          },
        },
        async (configPath) => {
          const io = createConfigIO({ configPath });
          const snapshot = await io.readConfigFileSnapshot();
          expect(snapshot.config.talk?.provider).toBe("acme");
          expect(snapshot.config.talk?.providers?.acme?.voiceId).toBe("acme-voice");
          expect(snapshot.config.talk?.providers?.acme?.apiKey).toBeUndefined();
          expect(snapshot.config.talk?.apiKey).toBeUndefined();
        },
      );
    });
  });

  it("does not inject ELEVENLABS_API_KEY fallback when talk.apiKey is SecretRef", async () => {
    await withEnvAsync({ [envVar("ELEVENLABS", "API", "KEY")]: "env-eleven-key" }, async () => {
      await withTempConfig(
        {
          talk: {
            provider: "elevenlabs",
            apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
            providers: {
              elevenlabs: {
                voiceId: "voice-123",
              },
            },
          },
        },
        async (configPath) => {
          const io = createConfigIO({ configPath });
          const snapshot = await io.readConfigFileSnapshot();
          expect(snapshot.config.talk?.apiKey).toEqual({
            source: "env",
            provider: "default",
            id: "ELEVENLABS_API_KEY",
          });
          expect(snapshot.config.talk?.providers?.elevenlabs?.apiKey).toBeUndefined();
        },
      );
    });
  });

  it("merges talk.elevenlabs shortcut into providers.elevenlabs", () => {
    const normalized = normalizeTalkSection({
      elevenlabs: {
        baseUrl: "http://local:8880",
        voiceId: "rick",
        seed: 42,
      },
    });

    expect(normalized?.provider).toBe("elevenlabs");
    expect(normalized?.providers?.elevenlabs?.baseUrl).toBe("http://local:8880");
    expect(normalized?.providers?.elevenlabs?.voiceId).toBe("rick");
    expect(normalized?.providers?.elevenlabs?.seed).toBe(42);
  });

  it("merges talk.openai shortcut into providers.openai", () => {
    const normalized = normalizeTalkSection({
      provider: "openai",
      openai: {
        voice: "nova",
        model: "gpt-4o-mini-tts",
      },
    });

    expect(normalized?.provider).toBe("openai");
    expect(normalized?.providers?.openai?.voice).toBe("nova");
    expect(normalized?.providers?.openai?.model).toBe("gpt-4o-mini-tts");
  });

  it("infers provider from lone talk.openai shortcut", () => {
    const normalized = normalizeTalkSection({
      openai: {
        voice: "nova",
      },
    });

    expect(normalized?.provider).toBe("openai");
    expect(normalized?.providers?.openai?.voice).toBe("nova");
  });

  it("typed shortcut overrides existing providers entry", () => {
    const normalized = normalizeTalkSection({
      providers: {
        elevenlabs: {
          voiceId: "old-voice",
          modelId: "eleven_v2",
        },
      },
      elevenlabs: {
        voiceId: "new-voice",
        baseUrl: "http://custom:8880",
      },
    });

    expect(normalized?.providers?.elevenlabs?.voiceId).toBe("new-voice");
    expect(normalized?.providers?.elevenlabs?.baseUrl).toBe("http://custom:8880");
    // modelId from existing providers entry is preserved
    expect(normalized?.providers?.elevenlabs?.modelId).toBe("eleven_v2");
  });

  it("passes voiceSettings through normalization", () => {
    const normalized = normalizeTalkSection({
      elevenlabs: {
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          speed: 1.2,
        },
      },
    });

    const settings = normalized?.providers?.elevenlabs?.voiceSettings;
    expect(settings).toBeDefined();
    expect((settings as Record<string, unknown>)?.stability).toBe(0.5);
    expect((settings as Record<string, unknown>)?.similarityBoost).toBe(0.75);
    expect((settings as Record<string, unknown>)?.speed).toBe(1.2);
  });
});
