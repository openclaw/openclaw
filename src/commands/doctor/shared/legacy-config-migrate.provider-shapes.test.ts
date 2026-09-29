import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS } from "./legacy-config-migrations.runtime.tts.js";
import { normalizeLegacyTalkConfig } from "./legacy-talk-config-normalizer.js";

function migrateLegacyConfig(raw: Record<string, unknown> | null) {
  const changes: string[] = [];
  if (!raw) {
    return { config: null, changes };
  }
  const next = structuredClone(raw);
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS) {
    migration.apply(next, changes);
  }
  return { config: changes.length ? next : null, changes };
}

function providerTts(provider: string, config: Record<string, unknown>) {
  return { providers: { [provider]: config } };
}

describe("legacy migrate provider-shaped config", () => {
  const legacyTts = {
    provider: "edge",
    enabled: true,
    providers: { custom: { voice: "legacy" } },
  };
  const voiceAndEnabled = ["tts.speaker-selection-keys", "tts.enabled-auto-mode"];

  it.each<{ name: string; path: string; value: unknown; expected: string[] }>([
    {
      name: "root TTS",
      path: "tts",
      value: legacyTts,
      expected: ["tts.providers-generic-shape", ...voiceAndEnabled],
    },
    {
      name: "keyed agent entries",
      path: "agents",
      value: { entries: { main: { tts: legacyTts } } },
      expected: voiceAndEnabled,
    },
    {
      name: "channel accounts",
      path: "channels",
      value: { slack: { accounts: { work: { tts: legacyTts } } } },
      expected: voiceAndEnabled,
    },
    {
      name: "blocked channel and account keys",
      path: "channels",
      value: {
        constructor: { tts: legacyTts },
        slack: { accounts: { prototype: { tts: legacyTts } } },
      },
      expected: [],
    },
    {
      name: "voice-call plugin",
      path: "plugins.entries",
      value: { "voice-call": { config: { tts: legacyTts } } },
      expected: ["tts.providers-generic-shape", ...voiceAndEnabled],
    },
    {
      name: "other plugins",
      path: "plugins.entries",
      value: { custom: { config: { tts: legacyTts } } },
      expected: [],
    },
  ])("previews only supported migrations for $name", ({ path, value, expected }) => {
    expect(
      LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS.filter((migration) =>
        migration.legacyRules?.some(
          (rule) => rule.path.join(".") === path && rule.match?.(value, {}),
        ),
      ).map((migration) => migration.id),
    ).toEqual(expected);
  });

  it("moves legacy realtime Talk selectors without overwriting canonical realtime config", () => {
    const input = {
      talk: {
        provider: "openai",
        voiceId: "legacy-voice",
        providers: { openai: { apiKey: "test-key", custom: true } },
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        model: "gpt-realtime",
        voice: "alloy",
        unknown: "discarded",
      },
    };
    const migrated = normalizeLegacyTalkConfig(input, []);
    expect(migrated.talk).toEqual({
      provider: "openai",
      voiceId: "legacy-voice",
      providers: { openai: { apiKey: "test-key", custom: true } },
      realtime: {
        provider: "openai",
        providers: { openai: { apiKey: "test-key", custom: true } },
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        model: "gpt-realtime",
        speakerVoice: "alloy",
      },
    });
    const conflicting = {
      ...migrated,
      talk: { ...migrated.talk, model: "obsolete", voice: "obsolete" },
    };
    expect(normalizeLegacyTalkConfig(conflicting, [])).toEqual(migrated);
    expect(normalizeLegacyTalkConfig(migrated, [])).toBe(migrated);
  });

  it("does not copy plain Talk speech provider config into talk.realtime", () => {
    const changes: string[] = [];
    const migrated = normalizeLegacyTalkConfig(
      {
        talk: {
          provider: "elevenlabs",
          providers: { elevenlabs: { voiceId: "voice-1" } },
        },
      },
      changes,
    );
    expect(changes).toStrictEqual([]);
    expect(migrated.talk).toEqual({
      provider: "elevenlabs",
      providers: { elevenlabs: { voiceId: "voice-1" } },
    });
  });

  it.each([
    { existing: undefined, expected: "cedar" },
    { existing: "marin", expected: "marin" },
  ])("routes legacy realtime voice with existing speaker $existing", ({ existing, expected }) => {
    const res = migrateLegacyConfig({
      talk: existing ? { realtime: { speakerVoice: existing } } : undefined,
      messages: { tts: { provider: "openai", realtime: { voice: "cedar" } } },
    });
    expect(res.config).toHaveProperty("tts", { provider: "openai" });
    expect(res.config).toHaveProperty("talk.realtime.speakerVoice", expected);
  });

  it("keeps canonical top-level tts values while filling missing legacy settings", () => {
    const res = migrateLegacyConfig({
      tts: { provider: "openai", providers: { openai: { model: "canonical-model" } } },
      messages: {
        tts: {
          provider: "elevenlabs",
          auto: "always",
          providers: { openai: { speakerVoice: "coral" } },
        },
      },
    });
    expect(res.config).toEqual({
      tts: {
        provider: "openai",
        auto: "always",
        providers: { openai: { model: "canonical-model", speakerVoice: "coral" } },
      },
      messages: {},
    });
  });

  it("removes invalid messages.tts values", () => {
    const res = migrateLegacyConfig({ messages: { tts: true } });
    expect(res.config).toEqual({ messages: {} });
  });

  it("moves legacy edge provider aliases while preserving canonical settings", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          provider: "edge",
          providers: {
            edge: { voice: "en-US-AvaNeural", rate: "+8%" },
            microsoft: { lang: "en-US", rate: "+4%" },
          },
        },
      },
    });
    expect(res.config).toHaveProperty("tts", {
      provider: "microsoft",
      providers: {
        microsoft: { lang: "en-US", rate: "+4%", speakerVoice: "en-US-AvaNeural" },
      },
    });
  });

  it("moves speaker selection fields only in supported TTS locations", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          provider: "openai",
          openai: { voice: "alloy" },
          providers: { elevenlabs: { voiceId: "voice-1" } },
          personas: { narrator: providerTts("google", { voiceName: "Kore" }) },
        },
      },
      agents: {
        defaults: { tts: providerTts("openai", { voice: "cedar", speakerVoice: "marin" }) },
        list: [{ id: "voice-agent", tts: providerTts("openai", { voice: "cedar" }) }],
      },
      channels: {
        discord: {
          tts: providerTts("microsoft", { voice: "en-US-AvaNeural" }),
          voice: { tts: providerTts("openai", { voice: "verse" }) },
          accounts: {
            primary: {
              tts: providerTts("gradium", {
                voiceId: "voice-2",
                speakerVoiceId: "voice-current",
              }),
              voice: { tts: providerTts("openai", { voiceId: "nested-voice" }) },
            },
          },
        },
      },
      plugins: {
        entries: {
          "voice-call": { config: { tts: providerTts("xai", { voiceId: "eve" }) } },
        },
      },
    });
    expect(res.config).toHaveProperty("tts", {
      provider: "openai",
      providers: {
        elevenlabs: { speakerVoiceId: "voice-1" },
        openai: { speakerVoice: "alloy" },
      },
      personas: { narrator: { providers: { google: { speakerVoice: "Kore" } } } },
    });
    expect(res.config).toHaveProperty("agents.defaults.tts", {
      providers: { openai: { voice: "cedar", speakerVoice: "marin" } },
    });
    expect(res.config).toHaveProperty("agents.list.0", {
      id: "voice-agent",
      tts: { providers: { openai: { speakerVoice: "cedar" } } },
    });
    expect(res.config).toHaveProperty("channels.discord.tts", {
      providers: { microsoft: { voice: "en-US-AvaNeural" } },
    });
    expect(res.config).toHaveProperty("channels.discord.voice.tts", {
      providers: { openai: { speakerVoice: "verse" } },
    });
    expect(res.config).toHaveProperty("channels.discord.accounts.primary.tts", {
      providers: { gradium: { voiceId: "voice-2", speakerVoiceId: "voice-current" } },
    });
    expect(res.config).toHaveProperty("channels.discord.accounts.primary.voice.tts", {
      providers: { openai: { speakerVoiceId: "nested-voice" } },
    });
    expect(res.config).toHaveProperty("plugins.entries.voice-call.config.tts", {
      providers: { xai: { speakerVoiceId: "eve" } },
    });
    expect(migrateLegacyConfig(res.config)).toEqual({ config: null, changes: [] });
  });

  it("moves enabled toggles only in supported TTS locations and preserves explicit auto", () => {
    const res = migrateLegacyConfig({
      messages: { tts: { enabled: true } },
      agents: {
        defaults: { tts: { enabled: false } },
        list: [{ id: "voice-agent", tts: { enabled: true, auto: "tagged" } }],
      },
      channels: {
        discord: {
          tts: { enabled: true },
          voice: { tts: { enabled: false } },
          accounts: {
            primary: {
              tts: { enabled: false },
              voice: { tts: { enabled: true } },
            },
          },
        },
        feishu: {
          tts: { enabled: true },
          accounts: { english: { tts: { enabled: false } } },
        },
      },
      plugins: { entries: { "voice-call": { config: { tts: { enabled: true } } } } },
    });
    expect(res.config).toHaveProperty("tts", { auto: "always" });
    expect(res.config).toHaveProperty("agents.defaults.tts", { enabled: false });
    expect(res.config).toHaveProperty("agents.list.0", {
      id: "voice-agent",
      tts: { auto: "tagged" },
    });
    expect(res.config).toHaveProperty("channels.discord.tts", { enabled: true });
    expect(res.config).toHaveProperty("channels.discord.voice.tts", { auto: "off" });
    expect(res.config).toHaveProperty("channels.discord.accounts.primary.tts", { enabled: false });
    expect(res.config).toHaveProperty("channels.discord.accounts.primary.voice.tts", {
      auto: "always",
    });
    expect(res.config).toHaveProperty("channels.feishu.tts", { auto: "always" });
    expect(res.config).toHaveProperty("channels.feishu.accounts.english.tts", { auto: "off" });
    expect(res.config).toHaveProperty("plugins.entries.voice-call.config.tts", { auto: "always" });
  });
});
