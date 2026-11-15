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

function speaker(provider: string, key: string, value: string) {
  return providerTts(provider, { [key]: value });
}

function voiceCall(config: Record<string, unknown>) {
  return { entries: { "voice-call": { config } } };
}

function migrateAtPaths(cases: Array<[string, unknown, unknown]>) {
  const config = {};
  for (const [path, value] of cases) {
    setConfigValueAtPath(config, path.split("."), structuredClone(value));
  }
  const result = migrateLegacyConfig(config);
  for (const [path, , expected] of cases) {
    expect(result.config).toHaveProperty(path === "messages.tts" ? "tts" : path, expected);
  }
  expect(migrateLegacyConfig(result.config)).toEqual({ config: null, changes: [] });
  return result;
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
    const legacy = {
      provider: "edge",
      enabled: true,
      providers: {
        edge: { voice: "en-US-AvaNeural", rate: "+8%" },
        microsoft: { lang: "en-US", rate: "+4%" },
      },
    };
    const expected = {
      provider: "microsoft",
      auto: "always",
      providers: {
        microsoft: { lang: "en-US", rate: "+4%", speakerVoice: "en-US-AvaNeural" },
      },
    };
    const blocked = {
      constructor: { tts: legacy },
      slack: { accounts: { prototype: { tts: legacy } } },
    };
    migrateAtPaths([
      ["messages.tts", legacy, expected],
      ["plugins.entries.voice-call.config.tts", legacy, expected],
      ["channels", blocked, blocked],
      ["plugins.entries.custom.config.tts", legacy, legacy],
    ]);
  });

  it("moves speaker selection fields only in supported TTS locations", () => {
    const agentTts = providerTts("openai", { voice: "cedar", speakerVoice: "marin" });
    const discord = "channels.discord";
    const account = `${discord}.accounts.primary`;
    const pinned = providerTts("gradium", { voiceId: "v", speakerVoiceId: "current" });
    const legacyVoice = speaker("openai", "voice", "v");
    const voice = speaker("openai", "speakerVoice", "v");
    const legacyId = speaker("openai", "voiceId", "v");
    const id = speaker("openai", "speakerVoiceId", "v");
    const ava = speaker("microsoft", "voice", "Ava");
    migrateAtPaths([
      [
        "messages.tts",
        {
          provider: "openai",
          openai: { voice: "alloy", voiceName: "cedar" },
          providers: { elevenlabs: { voiceId: "voice-1", speakerVoiceId: "canonical-voice" } },
          personas: { narrator: providerTts("google", { voiceName: "Kore" }) },
        },
        {
          provider: "openai",
          providers: {
            elevenlabs: { speakerVoiceId: "canonical-voice" },
            openai: { speakerVoice: "alloy" },
          },
          personas: { narrator: providerTts("google", { speakerVoice: "Kore" }) },
        },
      ],
      ["agents.defaults.tts", agentTts, agentTts],
      [
        "agents.list",
        [{ id: "a", tts: agentTts }],
        [{ id: "a", tts: speaker("openai", "speakerVoice", "marin") }],
      ],
      [`${discord}.tts`, ava, ava],
      [`${discord}.voice.tts`, legacyVoice, voice],
      [`${account}.tts`, pinned, pinned],
      [`${account}.voice.tts`, legacyId, id],
      [
        "plugins.entries.voice-call.config.tts",
        speaker("xai", "voiceId", "eve"),
        speaker("xai", "speakerVoiceId", "eve"),
      ],
    ]);
  });

  it("moves enabled toggles only in supported TTS locations and preserves explicit auto", () => {
    migrateAtPaths([
      ["messages.tts", { enabled: true }, { auto: "always" }],
      ["agents.defaults.tts", { enabled: false }, { enabled: false }],
      [
        "agents.list",
        [{ id: "voice-agent", tts: { enabled: true, auto: "tagged" } }],
        [{ id: "voice-agent", tts: { auto: "tagged" } }],
      ],
      ["channels.discord.tts", { enabled: true }, { enabled: true }],
      ["channels.discord.voice.tts", { enabled: false }, { auto: "off" }],
      ["channels.discord.accounts.primary.tts", { enabled: false }, { enabled: false }],
      ["channels.discord.accounts.primary.voice.tts", { enabled: true }, { auto: "always" }],
      ["channels.feishu.tts", { enabled: true }, { auto: "always" }],
      ["channels.feishu.accounts.english.tts", { enabled: false }, { auto: "off" }],
      ["plugins", voiceCall({ tts: { enabled: true } }), voiceCall({ tts: { auto: "always" } })],
    ]);
  });
});
