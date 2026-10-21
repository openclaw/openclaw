import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  readTtsPrefs,
  resolveConfiguredTtsMode,
  resolveEffectiveTtsConfig,
  shouldAttemptTtsPayload,
} from "./tts-config.js";
import { setTtsMaxLength } from "./tts-settings-writes.js";

describe("shouldAttemptTtsPayload", () => {
  let prefsPath: string;
  const tempDirs = createTempDirTracker();
  afterAll(tempDirs.cleanup);

  beforeEach(() => {
    prefsPath = path.join(tempDirs.make("openclaw-tts-config-"), "tts.json");
    vi.stubEnv("OPENCLAW_TTS_PREFS", prefsPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const attempt = (
    params: Omit<Parameters<typeof shouldAttemptTtsPayload>[0], "preparedTtsPreferences">,
  ) => shouldAttemptTtsPayload({ preparedTtsPreferences: {}, ...params });
  const writePrefs = (tts: Record<string, unknown>) =>
    writeFileSync(prefsPath, JSON.stringify({ tts }));

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

  it("refuses a preference update without overwriting unread existing settings", () => {
    const malformed = '{"tts":{"provider":"custom",';
    writeFileSync(prefsPath, malformed);

    expect(() => setTtsMaxLength(prefsPath, 2000)).toThrow("Repair the file or its permissions");
    expect(readFileSync(prefsPath, "utf8")).toBe(malformed);
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

  it("does not infer automatic TTS from a dashboard text turn without opt-in state", () => {
    expect(
      attempt({
        cfg: {} as OpenClawConfig,
        agentId: "main",
        channelId: "webchat",
        accountId: "dashboard",
      }),
    ).toBe(false);
  });

  it("honors session auto state before prefs and config", () => {
    writePrefs({ auto: "off" });
    const cfg = { tts: { auto: "off" } } as OpenClawConfig;

    expect(attempt({ cfg, ttsAuto: "always" })).toBe(true);
    expect(attempt({ cfg, ttsAuto: "off" })).toBe(false);
  });

  it("uses local prefs before config auto mode", () => {
    const cfg = { tts: { auto: "off" } } as OpenClawConfig;

    writePrefs({ enabled: true });
    expect(attempt({ cfg })).toBe(true);

    writePrefs({ auto: "off" });
    expect(attempt({ cfg: { tts: { enabled: true } } })).toBe(false);
  });

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
    const cfg = {
      tts: {
        auto: "off",
        mode: "final",
        provider: "openai",
        providers: { openai: { model: "gpt-4o-mini-tts", voice: "alloy" } },
      },
      agents: { entries: { reader: { tts: { providers: { openai: { voice: "nova" } } } } } },
      channels: {
        feishu: {
          tts: { auto: "always" },
          accounts: {
            EnglishBot: {
              tts: {
                mode: "all",
                providers: { openai: { voice: "shimmer" } },
              },
            },
          },
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
