import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig, TtsConfig } from "../config/types.js";
import { captureEnv } from "../test-utils/env.js";
import { resolveStatusTtsSnapshot } from "./status-config.js";

const tempDirs = createTempDirTracker();
let home: string;
let envSnapshot: ReturnType<typeof captureEnv>;

afterAll(tempDirs.cleanup);

beforeEach(() => {
  home = tempDirs.make("openclaw-tts-status-");
  envSnapshot = captureEnv([
    "HOME",
    "USERPROFILE",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
  ]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
});

afterEach(() => envSnapshot.restore());

function writePrefs(
  settings: Record<string, unknown> | null,
  stateDir = path.join(home, ".openclaw"),
) {
  const prefsPath = path.join(stateDir, "settings", "tts.json");
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(settings === null ? null : { tts: settings }));
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

function expectProvider(
  provider: string,
  config: Record<string, unknown>,
  details: Partial<NonNullable<ReturnType<typeof resolveStatusTtsSnapshot>>>,
) {
  expectStatus({ provider, providers: { [provider]: config } }, { provider, ...details });
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

  it("reports configured OpenAI TTS model, voice, and sanitized custom endpoint", () => {
    expectProvider(
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
    );
  });

  it("keeps truncated status detail fields well-formed at UTF-16 boundaries", () => {
    expectProvider(
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
    );
  });

  it("reports migrated canonical speaker voice fields", () => {
    expectProvider("elevenlabs", { speakerVoiceId: "voice-123" }, { voice: "voice-123" });
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
    delete process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
    expectStatus({ auto: undefined }, { provider: "openai" });
  });
});
