import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig, TtsConfig } from "../config/types.js";
import { resolveStatusTtsSnapshot } from "./status-config.js";

const tempDirs = createTempDirTracker();
let home: string;

afterAll(tempDirs.cleanup);

beforeEach(() => {
  home = tempDirs.make("openclaw-tts-status-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("OPENCLAW_HOME", undefined);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
});

afterEach(() => vi.unstubAllEnvs());

function writePrefs(tts: Record<string, unknown>, stateDir = path.join(home, ".openclaw")) {
  const prefsPath = path.join(stateDir, "settings", "tts.json");
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify({ tts }));
  return prefsPath;
}

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

describe("resolveStatusTtsSnapshot", () => {
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
        displayName: "NeuTTS local",
        baseUrl: "http://username@127.0.0.1:18801/v1?token=hidden#fragment",
        model: "neutts-nano",
        voice: "clara",
      },
      {
        displayName: "NeuTTS local",
        model: "neutts-nano",
        voice: "clara",
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
    const prefsPath = writePrefs({ auto: "always", provider: "edge" });
    expectStatus(
      {
        auto: undefined,
        provider: "openai",
        prefsPath,
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
