import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { createConfigIO } from "./io.js";
import { buildTalkConfigResponse, normalizeTalkSection } from "./talk.js";

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

  describe("talk.tts field", () => {
    it("preserves talk.tts with edge provider through normalization", () => {
      const normalized = normalizeTalkSection({
        tts: {
          provider: "edge",
          edge: { voice: "de-DE-KatjaNeural" },
        },
        interruptOnSpeech: true,
      });

      expect(normalized?.tts).toEqual({
        provider: "edge",
        edge: { voice: "de-DE-KatjaNeural" },
      });
      expect(normalized?.interruptOnSpeech).toBe(true);
    });

    it("preserves talk.tts with openai provider through normalization", () => {
      const normalized = normalizeTalkSection({
        tts: {
          provider: "openai",
          openai: { voice: "nova", model: "gpt-4o-mini-tts" },
        },
      });

      expect(normalized?.tts).toEqual({
        provider: "openai",
        openai: { voice: "nova", model: "gpt-4o-mini-tts" },
      });
    });

    it("allows talk.tts to coexist with legacy provider fields", () => {
      const normalized = normalizeTalkSection({
        voiceId: "voice-123",
        modelId: "eleven_v3",
        tts: {
          provider: "edge",
          edge: { voice: "en-US-MichelleNeural" },
        },
      });

      expect(normalized?.tts?.provider).toBe("edge");
      expect(normalized?.tts?.edge?.voice).toBe("en-US-MichelleNeural");
      expect(normalized?.voiceId).toBe("voice-123");
    });

    it("includes talk.tts in buildTalkConfigResponse", () => {
      const response = buildTalkConfigResponse({
        tts: {
          provider: "edge",
          edge: { voice: "en-US-MichelleNeural" },
        },
        interruptOnSpeech: false,
      });

      expect(response?.tts).toEqual({
        provider: "edge",
        edge: { voice: "en-US-MichelleNeural" },
      });
      expect(response?.interruptOnSpeech).toBe(false);
    });

    it("preserves talk.tts with elevenlabs provider config", () => {
      const normalized = normalizeTalkSection({
        tts: {
          provider: "elevenlabs",
          elevenlabs: {
            voiceId: "pMsXgVXv3BLzUgSXRplE",
            modelId: "eleven_multilingual_v2",
          },
        },
      });

      expect(normalized?.tts?.provider).toBe("elevenlabs");
      expect(normalized?.tts?.elevenlabs?.voiceId).toBe("pMsXgVXv3BLzUgSXRplE");
    });

    it("validates talk.tts via config schema", async () => {
      await withTempConfig(
        {
          talk: {
            tts: {
              provider: "edge",
              edge: { voice: "de-DE-KatjaNeural", lang: "de-DE" },
            },
          },
        },
        async (configPath) => {
          const io = createConfigIO({ configPath });
          const snapshot = await io.readConfigFileSnapshot();
          expect(snapshot.config.talk?.tts?.provider).toBe("edge");
          expect(snapshot.config.talk?.tts?.edge?.voice).toBe("de-DE-KatjaNeural");
        },
      );
    });
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
});
