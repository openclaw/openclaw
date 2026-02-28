import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "./io.js";
import { normalizeTalkSection } from "./talk.js";

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

async function withEnv(
  updates: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("talk normalization", () => {
  it("maps legacy ElevenLabs fields into provider/providers", () => {
    const normalized = normalizeTalkSection({
      voiceId: "voice-123",
      voiceAliases: { Clawd: "EXAVITQu4vr4xnSDxMaL" },
      modelId: "eleven_v3",
      outputFormat: "pcm_44100",
      apiKey: "secret-key",
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
          apiKey: "secret-key",
        },
      },
      voiceId: "voice-123",
      voiceAliases: { Clawd: "EXAVITQu4vr4xnSDxMaL" },
      modelId: "eleven_v3",
      outputFormat: "pcm_44100",
      apiKey: "secret-key",
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

  it("merges ELEVENLABS_API_KEY into normalized defaults for legacy configs", async () => {
    await withEnv({ ELEVENLABS_API_KEY: "env-eleven-key" }, async () => {
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
          expect(snapshot.config.talk?.providers?.elevenlabs?.apiKey).toBe("env-eleven-key");
          expect(snapshot.config.talk?.apiKey).toBe("env-eleven-key");
        },
      );
    });
  });

  it("does not apply ELEVENLABS_API_KEY when active provider is not elevenlabs", async () => {
    await withEnv({ ELEVENLABS_API_KEY: "env-eleven-key" }, async () => {
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
});
