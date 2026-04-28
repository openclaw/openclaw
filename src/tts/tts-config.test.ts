import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { shouldAttemptTtsPayload } from "./tts-config.js";

describe("shouldAttemptTtsPayload", () => {
  let originalPrefsPath: string | undefined;
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
    originalPrefsPath = process.env.OPENCLAW_TTS_PREFS;
    dir = path.join(root, `case-${caseId++}`);
    mkdirSync(dir, { recursive: true });
    prefsPath = path.join(dir, "tts.json");
    process.env.OPENCLAW_TTS_PREFS = prefsPath;
  });

  afterEach(() => {
    if (originalPrefsPath === undefined) {
      delete process.env.OPENCLAW_TTS_PREFS;
    } else {
      process.env.OPENCLAW_TTS_PREFS = originalPrefsPath;
    }
  });

  it("skips TTS when config, prefs, and session state leave auto mode off", () => {
    expect(shouldAttemptTtsPayload({ cfg: {} as OpenClawConfig })).toBe(false);
  });

  it("honors session auto state before prefs and config", () => {
    writeFileSync(prefsPath, JSON.stringify({ tts: { auto: "off" } }));
    const cfg = { messages: { tts: { auto: "off" } } } as OpenClawConfig;

    expect(shouldAttemptTtsPayload({ cfg, ttsAuto: "always" })).toBe(true);
    expect(shouldAttemptTtsPayload({ cfg, ttsAuto: "off" })).toBe(false);
  });

  it("uses local prefs before config auto mode", () => {
    const cfg = { messages: { tts: { auto: "off" } } } as OpenClawConfig;

    writeFileSync(prefsPath, JSON.stringify({ tts: { enabled: true } }));
    expect(shouldAttemptTtsPayload({ cfg })).toBe(true);

    writeFileSync(prefsPath, JSON.stringify({ tts: { auto: "off" } }));
    expect(
      shouldAttemptTtsPayload({ cfg: { messages: { tts: { enabled: true } } } as OpenClawConfig }),
    ).toBe(false);
  });
});
