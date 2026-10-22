import { describe, expect, it } from "vitest";
import { setConfigValueAtPath } from "../../../config/config-paths.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS } from "./legacy-config-migrations.runtime.tts.js";
import {
  LEGACY_TALK_VOICE_CALL_INHERITANCE,
  normalizeLegacyTalkConfig,
} from "./legacy-talk-config-normalizer.js";

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

function voiceCall(config: Record<string, unknown>) {
  return { entries: { "voice-call": { config } } };
}

function expectProperties(value: unknown, properties: Record<string, unknown>) {
  for (const [path, expected] of Object.entries(properties)) {
    expect(value).toHaveProperty(path, expected);
  }
}

function configAtPaths(properties: Record<string, unknown>) {
  const config = {};
  for (const [path, value] of Object.entries(properties)) {
    setConfigValueAtPath(config, path.split("."), value);
  }
  return config;
}

describe("legacy migrate provider-shaped config", () => {
  const inherited = { openai: { model: "inherited" } };
  const explicit = { openai: { model: "explicit" } };
  const google = { google: { model: "explicit" } };
  type InheritanceCase = [
    Record<string, unknown> | undefined,
    string | undefined,
    string,
    Record<string, unknown>,
  ];
  it.each<InheritanceCase>([
    [undefined, undefined, "openai", inherited],
    [undefined, "openai", "openai", inherited],
    [{ providers: google }, "openai", "google", { ...inherited, ...google }],
    [{ provider: "google", providers: explicit }, "openai", "google", explicit],
    [
      { provider: "openai", providers: { OpenAI: explicit.openai } },
      "openai",
      "openai",
      { OpenAI: explicit.openai },
    ],
  ])(
    "persists inherited Talk settings: %j, inherited=%s",
    (realtime, inheritedProvider, provider, providers) => {
      const raw: Record<string, unknown> = {
        ...(realtime ? { talk: { realtime: structuredClone(realtime) } } : {}),
        plugins: voiceCall({
          realtime: {
            provider: inheritedProvider,
            providers: structuredClone(inherited),
          },
        }),
      };
      const plugins = structuredClone(raw.plugins);
      const changes: string[] = [];
      LEGACY_TALK_VOICE_CALL_INHERITANCE.apply(raw, changes);
      expect(raw.talk).toEqual({ realtime: { provider, providers } });
      expect(raw.plugins).toEqual(plugins);
      const again: string[] = [];
      LEGACY_TALK_VOICE_CALL_INHERITANCE.apply(raw, again);
      expect(again).toEqual([]);
    },
  );

  const legacyTts = {
    provider: "edge",
    enabled: true,
    providers: { custom: { voice: "legacy" } },
  };
  const voiceAndEnabled = ["tts.speaker-selection-keys", "tts.enabled-auto-mode"];

  it.each<{ name: string; path: string; value: unknown; expected: string[] }>([
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
      value: voiceCall({ tts: legacyTts }).entries,
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

  it("does not copy plain Talk speech provider config into talk.realtime", () => {
    const changes: string[] = [];
    const talk = { provider: "elevenlabs", ...providerTts("elevenlabs", { voiceId: "voice-1" }) };
    const before = structuredClone(talk);
    const migrated = normalizeLegacyTalkConfig({ talk }, changes);
    expect(changes).toStrictEqual([]);
    expect(migrated.talk).toEqual(before);
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
    const agentTts = providerTts("openai", { voice: "cedar", speakerVoice: "marin" });
    const res = migrateLegacyConfig(
      configAtPaths({
        "messages.tts": {
          provider: "openai",
          openai: { voice: "alloy", voiceName: "cedar" },
          providers: { elevenlabs: { voiceId: "voice-1", speakerVoiceId: "canonical-voice" } },
          personas: { narrator: providerTts("google", { voiceName: "Kore" }) },
        },
        "agents.defaults.tts": agentTts,
        "agents.list": [{ id: "voice-agent", tts: structuredClone(agentTts) }],
        "channels.discord.tts": providerTts("microsoft", { voice: "en-US-AvaNeural" }),
        "channels.discord.voice.tts": providerTts("openai", { voice: "verse" }),
        "channels.discord.accounts.primary.tts": providerTts("gradium", {
          voiceId: "voice-2",
          speakerVoiceId: "voice-current",
        }),
        "channels.discord.accounts.primary.voice.tts": providerTts("openai", {
          voiceId: "nested-voice",
        }),
        plugins: voiceCall({ tts: providerTts("xai", { voiceId: "eve" }) }),
      }),
    );
    expectProperties(res.config, {
      tts: {
        provider: "openai",
        providers: {
          elevenlabs: { speakerVoiceId: "canonical-voice" },
          openai: { speakerVoice: "alloy" },
        },
        personas: { narrator: providerTts("google", { speakerVoice: "Kore" }) },
      },
      "agents.defaults.tts": providerTts("openai", { voice: "cedar", speakerVoice: "marin" }),
      "agents.list.0": { id: "voice-agent", tts: providerTts("openai", { speakerVoice: "marin" }) },
      "channels.discord.tts": providerTts("microsoft", { voice: "en-US-AvaNeural" }),
      "channels.discord.voice.tts": providerTts("openai", { speakerVoice: "verse" }),
      "channels.discord.accounts.primary.tts": providerTts("gradium", {
        voiceId: "voice-2",
        speakerVoiceId: "voice-current",
      }),
      "channels.discord.accounts.primary.voice.tts": providerTts("openai", {
        speakerVoiceId: "nested-voice",
      }),
      "plugins.entries.voice-call.config.tts": providerTts("xai", { speakerVoiceId: "eve" }),
    });
    expect(res.changes).toContain(
      "Removed tts.providers.openai.voiceName (tts.providers.openai.speakerVoice already set).",
    );
    expect(migrateLegacyConfig(res.config)).toEqual({ config: null, changes: [] });
  });

  it("moves enabled toggles only in supported TTS locations and preserves explicit auto", () => {
    const res = migrateLegacyConfig(
      configAtPaths({
        "messages.tts": { enabled: true },
        "agents.defaults.tts": { enabled: false },
        "agents.list": [{ id: "voice-agent", tts: { enabled: true, auto: "tagged" } }],
        "channels.discord.tts": { enabled: true },
        "channels.discord.voice.tts": { enabled: false },
        "channels.discord.accounts.primary.tts": { enabled: false },
        "channels.discord.accounts.primary.voice.tts": { enabled: true },
        "channels.feishu.tts": { enabled: true },
        "channels.feishu.accounts.english.tts": { enabled: false },
        plugins: voiceCall({ tts: { enabled: true } }),
      }),
    );
    expectProperties(res.config, {
      tts: { auto: "always" },
      "agents.defaults.tts": { enabled: false },
      "agents.list.0": { id: "voice-agent", tts: { auto: "tagged" } },
      "channels.discord.tts": { enabled: true },
      "channels.discord.voice.tts": { auto: "off" },
      "channels.discord.accounts.primary.tts": { enabled: false },
      "channels.discord.accounts.primary.voice.tts": { auto: "always" },
      "channels.feishu.tts": { auto: "always" },
      "channels.feishu.accounts.english.tts": { auto: "off" },
      "plugins.entries.voice-call.config.tts": { auto: "always" },
    });
  });
});
