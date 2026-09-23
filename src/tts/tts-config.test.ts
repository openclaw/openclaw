// TTS config tests cover text-to-speech config loading and overrides.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import {
  resolveConfiguredTtsMode,
  resolveEffectiveTtsConfig,
  shouldAttemptTtsPayload,
} from "./tts-config.js";
import { TTS_PREFS_MAX_BYTES, readBoundedTtsPrefsTextSync } from "./tts-prefs-read.js";
import { readTtsPrefs, resolveTtsSettingsSnapshot } from "./tts-settings.js";

describe("shouldAttemptTtsPayload", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let root = "";
  let dir: string;
  let prefsPath: string;
  let caseId = 0;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "openclaw-tts-config-"));
  });

  afterAll(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_TTS_PREFS"]);
    dir = path.join(root, `case-${caseId++}`);
    mkdirSync(dir, { recursive: true });
    prefsPath = path.join(dir, "tts.json");
    process.env.OPENCLAW_TTS_PREFS = prefsPath;
  });

  afterEach(() => {
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  it("skips TTS when config, prefs, and session state leave auto mode off", () => {
    expect(shouldAttemptTtsPayload({ cfg: {} as OpenClawConfig })).toBe(false);
  });

  it("does not infer automatic TTS from a dashboard text turn without opt-in state", () => {
    expect(
      shouldAttemptTtsPayload({
        cfg: {} as OpenClawConfig,
        agentId: "main",
        channelId: "webchat",
        accountId: "dashboard",
      }),
    ).toBe(false);
  });

  it("honors session auto state before prefs and config", () => {
    writeFileSync(prefsPath, JSON.stringify({ tts: { auto: "off" } }));
    const cfg = { tts: { auto: "off" } } as OpenClawConfig;

    expect(shouldAttemptTtsPayload({ cfg, ttsAuto: "always" })).toBe(true);
    expect(shouldAttemptTtsPayload({ cfg, ttsAuto: "off" })).toBe(false);
  });

  it("uses local prefs before config auto mode", () => {
    const cfg = { tts: { auto: "off" } } as OpenClawConfig;

    writeFileSync(prefsPath, JSON.stringify({ tts: { enabled: true } }));
    expect(shouldAttemptTtsPayload({ cfg })).toBe(true);

    writeFileSync(prefsPath, JSON.stringify({ tts: { auto: "off" } }));
    expect(shouldAttemptTtsPayload({ cfg: { tts: { enabled: true } } as OpenClawConfig })).toBe(
      false,
    );
  });

  it("records the selected provider preference source", () => {
    const cfg = {
      tts: {
        provider: "openai",
        persona: "reader",
        personas: {
          reader: { provider: "google" },
        },
      },
    } as OpenClawConfig;

    expect(resolveTtsSettingsSnapshot({ cfg }).providerPreference).toEqual({
      provider: "google",
      source: "persona",
    });

    writeFileSync(prefsPath, JSON.stringify({ tts: { provider: "edge" } }));
    expect(resolveTtsSettingsSnapshot({ cfg }).providerPreference).toEqual({
      provider: "microsoft",
      source: "prefs",
    });

    writeFileSync(prefsPath, "{}");
    expect(
      resolveTtsSettingsSnapshot({ cfg: { tts: { provider: "openai" } } }).providerPreference,
    ).toEqual({ provider: "openai", source: "config" });
  });

  it("uses per-agent TTS auto and mode overrides", () => {
    const cfg = {
      tts: {
        auto: "off",
        mode: "final",
      },
      agents: {
        list: [
          {
            id: "voice",
            tts: {
              auto: "always",
              mode: "all",
            },
          },
        ],
      },
    } as OpenClawConfig;

    expect(shouldAttemptTtsPayload({ cfg, agentId: "voice" })).toBe(true);
    expect(resolveConfiguredTtsMode(cfg, "voice")).toBe("all");
    expect(shouldAttemptTtsPayload({ cfg, agentId: "main" })).toBe(false);
    expect(resolveConfiguredTtsMode(cfg, "main")).toBe("final");
  });

  it("uses a per-agent preference path before the global environment path", () => {
    const voicePrefsPath = path.join(dir, "voice-tts.json");
    writeFileSync(prefsPath, JSON.stringify({ tts: { auto: "off" } }));
    writeFileSync(voicePrefsPath, JSON.stringify({ tts: { auto: "always" } }));
    const cfg = {
      agents: {
        list: [{ id: "voice", tts: { prefsPath: voicePrefsPath } }],
      },
    } as OpenClawConfig;

    expect(shouldAttemptTtsPayload({ cfg, agentId: "voice" })).toBe(true);
    expect(shouldAttemptTtsPayload({ cfg, agentId: "main" })).toBe(false);
  });

  it("merges channel and account TTS overrides after agent overrides", () => {
    const cfg = {
      tts: {
        auto: "off",
        mode: "final",
        provider: "openai",
        providers: {
          openai: {
            model: "gpt-4o-mini-tts",
            voice: "alloy",
          },
        },
      },
      agents: {
        list: [
          {
            id: "reader",
            tts: {
              providers: {
                openai: {
                  voice: "nova",
                },
              },
            },
          },
        ],
      },
      channels: {
        feishu: {
          tts: {
            auto: "always",
          },
          accounts: {
            EnglishBot: {
              tts: {
                mode: "all",
                providers: {
                  openai: {
                    voice: "shimmer",
                  },
                },
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

    expect(resolved.auto).toBe("always");
    expect(resolved.mode).toBe("all");
    expect(resolved.provider).toBe("openai");
    expect(resolved.providers?.openai?.model).toBe("gpt-4o-mini-tts");
    expect(resolved.providers?.openai?.voice).toBe("shimmer");
  });

  it("preserves null and array override semantics while blocking prototype keys", () => {
    const agentTts = JSON.parse(
      '{"providers":{"custom":{"nullable":null,"voices":["override"],"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}}}',
    );
    const cfg = {
      tts: {
        providers: {
          custom: {
            model: "base",
            nullable: "base",
            voices: ["base"],
          },
        },
      },
      agents: { list: [{ id: "reader", tts: agentTts }] },
    } as OpenClawConfig;

    expect(resolveEffectiveTtsConfig(cfg, "reader").providers?.custom).toEqual({
      model: "base",
      nullable: null,
      voices: ["override"],
    });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("TTS prefs reads are bounded", () => {
  let root = "";
  let prefsPath = "";

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "openclaw-tts-prefs-bound-"));
  });

  afterAll(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    prefsPath = path.join(root, `prefs-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  it("readBoundedTtsPrefsTextSync returns the text for a normal-sized file", () => {
    writeFileSync(prefsPath, '{"tts":{"auto":"always"}}', "utf8");

    expect(readBoundedTtsPrefsTextSync(prefsPath)).toBe('{"tts":{"auto":"always"}}');
  });

  it("readBoundedTtsPrefsTextSync accepts a file of exactly the bound", () => {
    // A file that fills the window exactly is not oversized; the one-byte probe
    // past the window must not reject it.
    const exactly = "x".repeat(TTS_PREFS_MAX_BYTES);
    writeFileSync(prefsPath, exactly, "utf8");

    expect(readBoundedTtsPrefsTextSync(prefsPath)).toBe(exactly);
  });

  it("readBoundedTtsPrefsTextSync rejects a file larger than the bound", () => {
    // One byte past the limit is enough to reject; the old readFileSync path read
    // the whole document into memory first.
    writeFileSync(prefsPath, "x".repeat(TTS_PREFS_MAX_BYTES + 1), "utf8");

    expect(readBoundedTtsPrefsTextSync(prefsPath)).toBeUndefined();
  });

  it("readTtsPrefs falls back to defaults for an oversized prefs file", () => {
    // Pre-fix this parsed the oversized document and returned its contents.
    writeFileSync(
      prefsPath,
      `{"tts":{"auto":"always","summarize":false},"pad":"${"x".repeat(TTS_PREFS_MAX_BYTES)}"}`,
      "utf8",
    );

    expect(readTtsPrefs(prefsPath)).toEqual({});
  });

  it("readTtsPrefs still reads a normal prefs file", () => {
    writeFileSync(prefsPath, '{"tts":{"auto":"always","summarize":false}}', "utf8");

    expect(readTtsPrefs(prefsPath)).toEqual({ tts: { auto: "always", summarize: false } });
  });

  it("shouldAttemptTtsPayload uses the prefs auto mode for a normal file", () => {
    writeFileSync(prefsPath, '{"tts":{"auto":"always"}}', "utf8");
    const envSnapshot = captureEnv(["OPENCLAW_TTS_PREFS"]);
    process.env.OPENCLAW_TTS_PREFS = prefsPath;
    try {
      expect(shouldAttemptTtsPayload({ cfg: {} as OpenClawConfig })).toBe(true);
    } finally {
      envSnapshot.restore();
    }
  });

  it("shouldAttemptTtsPayload ignores an oversized prefs file named by OPENCLAW_TTS_PREFS", () => {
    writeFileSync(
      prefsPath,
      `{"tts":{"auto":"always"},"pad":"${"x".repeat(TTS_PREFS_MAX_BYTES)}"}`,
      "utf8",
    );
    const envSnapshot = captureEnv(["OPENCLAW_TTS_PREFS"]);
    process.env.OPENCLAW_TTS_PREFS = prefsPath;
    try {
      // Pre-fix the unbounded read parsed the oversized document and honored
      // `auto: "always"`; now the oversized file is ignored.
      expect(shouldAttemptTtsPayload({ cfg: {} as OpenClawConfig })).toBe(false);
    } finally {
      envSnapshot.restore();
    }
  });
});
