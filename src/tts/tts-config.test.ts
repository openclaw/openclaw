import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig, TtsConfig } from "../config/types.js";
import { resolveStatusTtsSnapshot } from "./status-config.js";
import {
  readTtsPrefs,
  resolveConfiguredTtsMode,
  resolveEffectiveTtsConfig,
  shouldAttemptTtsPayload,
} from "./tts-config.js";
import { setTtsMaxLength } from "./tts-settings-writes.js";

const tempDirs = createTempDirTracker();
let home: string;
let prefsPath: string;
beforeEach(() => {
  home = tempDirs.make("openclaw-tts-config-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OPENCLAW_HOME", undefined);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
  vi.stubEnv("OPENCLAW_TTS_PREFS", undefined);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
  prefsPath = path.join(home, ".openclaw", "settings", "tts.json");
  mkdirSync(path.dirname(prefsPath), { recursive: true });
});
afterAll(tempDirs.cleanup);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function writePrefs(tts: Record<string, unknown>, stateDir = path.join(home, ".openclaw")) {
  const file = path.join(stateDir, "settings", "tts.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ tts }));
  return file;
}

describe("shouldAttemptTtsPayload", () => {
  const attempt = (
    params: Omit<Parameters<typeof shouldAttemptTtsPayload>[0], "preparedTtsPreferences">,
  ) => shouldAttemptTtsPayload({ preparedTtsPreferences: {}, ...params });

  it("warns for malformed optional preferences but keeps missing files quiet", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readTtsPrefs(prefsPath)).toEqual({});
    expect(warn).not.toHaveBeenCalled();

    writeFileSync(prefsPath, '{"tts":');
    expect(attempt({ cfg: { tts: { auto: "always" } } })).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(prefsPath);
    expect(warn.mock.calls[0]?.[0]).toContain("Repair the file or its permissions");
  });

  it("creates missing preferences and preserves settings during ordinary updates", () => {
    setTtsMaxLength(prefsPath, 1800);
    expect(JSON.parse(readFileSync(prefsPath, "utf8"))).toEqual({ tts: { maxLength: 1800 } });

    writePrefs({ provider: "custom", summarize: false });
    setTtsMaxLength(prefsPath, 2000);
    expect(JSON.parse(readFileSync(prefsPath, "utf8"))).toEqual({
      tts: { provider: "custom", summarize: false, maxLength: 2000 },
    });
  });

  it.each([
    [{ auto: "off" }, { auto: "off" }, "always", true],
    [{ auto: "off" }, { auto: "off" }, "off", false],
    [{ auto: "off" }, { enabled: true }, undefined, true],
    [{ enabled: true }, { auto: "off" }, undefined, false],
  ] satisfies Array<[TtsConfig, Record<string, unknown>, string | undefined, boolean]>)(
    "prioritizes session, preferences, then config: %j / %j / %s",
    (tts, prefs, ttsAuto, expected) => {
      writePrefs(prefs);
      expect(attempt({ cfg: { tts }, ttsAuto })).toBe(expected);
    },
  );

  it("uses per-agent TTS auto and mode overrides", () => {
    const cfg = {
      tts: { auto: "off", mode: "final" },
      agents: { entries: { voice: { tts: { auto: "always", mode: "all" } } } },
    } as OpenClawConfig;

    expect(attempt({ cfg, agentId: "voice" })).toBe(true);
    expect(resolveConfiguredTtsMode(cfg, "voice")).toBe("all");
    expect(attempt({ cfg, agentId: "main" })).toBe(false);
    expect(resolveConfiguredTtsMode(cfg, "main")).toBe("final");
  });

  it("merges channel and account TTS overrides after agent overrides", () => {
    const voice = (name: string) => ({ providers: { openai: { voice: name } } });
    const cfg = {
      tts: {
        auto: "off",
        mode: "final",
        provider: "openai",
        providers: { openai: { model: "gpt-4o-mini-tts", voice: "alloy" } },
      },
      agents: { entries: { reader: { tts: voice("nova") } } },
      channels: {
        feishu: {
          tts: { auto: "always" },
          accounts: { EnglishBot: { tts: { mode: "all", ...voice("shimmer") } } },
        },
      },
    } as OpenClawConfig;

    const resolved = resolveEffectiveTtsConfig(cfg, {
      agentId: "reader",
      channelId: "FEISHU",
      accountId: "englishbot",
    });

    expect(resolved).toMatchObject({
      auto: "always",
      mode: "all",
      provider: "openai",
      providers: { openai: { model: "gpt-4o-mini-tts", voice: "shimmer" } },
    });
  });

  it("preserves null and array override semantics while blocking prototype keys", () => {
    const agentTts = JSON.parse(
      '{"providers":{"custom":{"nullable":null,"voices":["override"],"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}}}',
    );
    const cfg = {
      tts: { providers: { custom: { model: "base", nullable: "base", voices: ["base"] } } },
      agents: { entries: { reader: { tts: agentTts } } },
    } as OpenClawConfig;

    expect(resolveEffectiveTtsConfig(cfg, "reader").providers?.custom).toEqual({
      model: "base",
      nullable: null,
      voices: ["override"],
    });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("resolveStatusTtsSnapshot", () => {
  function expectStatus(
    tts: TtsConfig,
    details: Partial<NonNullable<ReturnType<typeof resolveStatusTtsSnapshot>>>,
    agents?: OpenClawConfig["agents"],
  ) {
    expect(
      resolveStatusTtsSnapshot({
        cfg: { tts: { auto: "always", ...tts }, agents },
        agentId: agents ? "reader" : undefined,
      }),
    ).toEqual({
      autoMode: "always",
      maxLength: 1500,
      summarize: true,
      ...details,
    });
  }

  it("reports auto provider when tts is on without an explicit provider", () => {
    expectStatus({}, { provider: "auto" });
  });

  it("reports per-agent persona provider over global persona", () => {
    expectStatus(
      {
        persona: "alfred",
        personas: { alfred: { provider: "google" }, jarvis: { provider: "edge" } },
      },
      { provider: "microsoft", persona: "jarvis" },
      { entries: { reader: { tts: { persona: "jarvis" } } } },
    );
  });

  it.each([
    [
      "sanitized custom endpoint",
      "openai",
      {
        baseUrl: "http://username@127.0.0.1:18801/v1?token=hidden#fragment",
      },
      {
        baseUrl: "http://127.0.0.1:18801/v1",
        customBaseUrl: true,
      },
    ],
    [
      "UTF-16-safe truncation",
      "elevenlabs",
      {
        displayName: `${"d".repeat(92)}😀tail`,
        model: `${"m".repeat(92)}😀tail`,
        voice: `${"v".repeat(92)}😀tail`,
      },
      {
        displayName: `${"d".repeat(92)}...`,
        model: `${"m".repeat(92)}...`,
        voice: `${"v".repeat(92)}...`,
      },
    ],
    [
      "canonical speaker voice",
      "elevenlabs",
      { speakerVoiceId: "voice-123" },
      { voice: "voice-123" },
    ],
  ] as const)("reports %s", (_name, provider, config, expected) => {
    expectStatus({ provider, providers: { [provider]: config } }, { provider, ...expected });
  });

  it("uses provider metadata for local provider prefs overrides", () => {
    vi.stubEnv("OPENCLAW_TTS_PREFS", writePrefs({ auto: "always", provider: "edge" }));
    expectStatus(
      {
        auto: undefined,
        provider: "openai",
        providers: {
          microsoft: { voice: "en-US-AvaMultilingualNeural" },
          openai: { model: "gpt-4o-mini-tts", voice: "coral" },
        },
      },
      { provider: "microsoft", voice: "en-US-AvaMultilingualNeural" },
    );
  });

  it("derives the default prefs path from OPENCLAW_CONFIG_PATH when set", () => {
    const stateDir = path.join(home, ".openclaw-dev");
    writePrefs({ auto: "always", provider: "openai" }, stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    expectStatus({ auto: undefined }, { provider: "openai" });
  });
});
