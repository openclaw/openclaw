// TTS status config tests cover status file path and config resolution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { captureEnv } from "../test-utils/env.js";
import { resolveStatusTtsSnapshot } from "./status-config.js";

let fixtureRoot = "";
let fixtureId = 0;
let home: string;
let envSnapshot: ReturnType<typeof captureEnv>;

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tts-status-"));
});

afterAll(() => {
  if (fixtureRoot) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

beforeEach(() => {
  home = path.join(fixtureRoot, `case-${fixtureId++}`);
  fs.mkdirSync(home, { recursive: true });
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
  cfg: OpenClawConfig,
  details: Partial<NonNullable<ReturnType<typeof resolveStatusTtsSnapshot>>>,
  agentId?: string,
) {
  expect(resolveStatusTtsSnapshot({ cfg, agentId })).toEqual({
    autoMode: "always",
    maxLength: 1500,
    summarize: true,
    ...details,
  });
}

describe("resolveStatusTtsSnapshot", () => {
  it("treats null prefs as empty settings", () => {
    const prefsPath = writePrefs(null);
    expectStatus({ tts: { auto: "always", provider: "edge", prefsPath } } as OpenClawConfig, {
      provider: "microsoft",
    });
  });

  it("uses prefs overrides without loading speech providers", () => {
    const prefsPath = writePrefs({
      auto: "always",
      provider: "edge",
      maxLength: 2048,
      summarize: false,
    });
    expectStatus({ tts: { prefsPath } } as OpenClawConfig, {
      provider: "microsoft",
      maxLength: 2048,
      summarize: false,
    });
  });

  it("reports auto provider when tts is on without an explicit provider", () => {
    expectStatus({ tts: { auto: "always" } }, { provider: "auto" });
  });

  it("reports per-agent TTS overrides", () => {
    expectStatus(
      {
        tts: { auto: "off", provider: "openai" },
        agents: { list: [{ id: "reader", tts: { auto: "always", provider: "elevenlabs" } }] },
      },
      { provider: "elevenlabs" },
      "reader",
    );
  });

  it("reports per-agent persona provider over global persona", () => {
    expectStatus(
      {
        tts: {
          auto: "always",
          persona: "alfred",
          personas: { alfred: { provider: "google" }, jarvis: { provider: "edge" } },
        },
        agents: { list: [{ id: "reader", tts: { persona: "jarvis" } }] },
      },
      { provider: "microsoft", persona: "jarvis" },
      "reader",
    );
  });

  it("reports configured OpenAI TTS model, voice, and sanitized custom endpoint", () => {
    expectStatus(
      {
        tts: {
          auto: "always",
          provider: "openai",
          providers: {
            openai: {
              displayName: "NeuTTS local",
              baseUrl: "http://username@127.0.0.1:18801/v1?token=hidden#fragment",
              model: "neutts-nano",
              voice: "clara",
            },
          },
        },
      },
      {
        provider: "openai",
        displayName: "NeuTTS local",
        model: "neutts-nano",
        voice: "clara",
        baseUrl: "http://127.0.0.1:18801/v1",
        customBaseUrl: true,
      },
    );
  });

  it("keeps truncated status detail fields well-formed at UTF-16 boundaries", () => {
    const snapshot = resolveStatusTtsSnapshot({
      cfg: {
        tts: {
          auto: "always",
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              displayName: `${"d".repeat(92)}😀tail`,
              model: `${"m".repeat(92)}😀tail`,
              voice: `${"v".repeat(92)}😀tail`,
            },
          },
        },
      },
    });

    expect(snapshot?.displayName).toBe(`${"d".repeat(92)}...`);
    expect(snapshot?.model).toBe(`${"m".repeat(92)}...`);
    expect(snapshot?.voice).toBe(`${"v".repeat(92)}...`);
  });

  it("omits default OpenAI endpoint details from status", () => {
    expectStatus(
      {
        tts: {
          auto: "always",
          provider: "openai",
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1/",
              model: "gpt-4o-mini-tts",
              voice: "coral",
            },
          },
        },
      },
      { provider: "openai", model: "gpt-4o-mini-tts", voice: "coral" },
    );
  });

  it("reports migrated canonical speaker voice fields", () => {
    expectStatus(
      {
        tts: {
          auto: "always",
          provider: "elevenlabs",
          providers: { elevenlabs: { speakerVoiceId: "voice-123" } },
        },
      },
      { provider: "elevenlabs", voice: "voice-123" },
    );
  });

  it("reports merged per-agent provider metadata", () => {
    expectStatus(
      {
        tts: {
          auto: "off",
          provider: "openai",
          providers: { openai: { model: "gpt-4o-mini-tts", voice: "coral" } },
        },
        agents: {
          list: [
            { id: "reader", tts: { auto: "always", providers: { openai: { voice: "nova" } } } },
          ],
        },
      },
      { provider: "openai", model: "gpt-4o-mini-tts", voice: "nova" },
      "reader",
    );
  });

  it("uses provider metadata for local provider prefs overrides", () => {
    const prefsPath = writePrefs({ auto: "always", provider: "edge" });
    expectStatus(
      {
        tts: {
          provider: "openai",
          prefsPath,
          providers: {
            microsoft: { voice: "en-US-AvaMultilingualNeural" },
            openai: { model: "gpt-4o-mini-tts", voice: "coral" },
          },
        },
      } as OpenClawConfig,
      { provider: "microsoft", voice: "en-US-AvaMultilingualNeural" },
    );
  });

  it("derives the default prefs path from OPENCLAW_CONFIG_PATH when set", () => {
    const stateDir = path.join(home, ".openclaw-dev");
    writePrefs({ auto: "always", provider: "openai" }, stateDir);
    delete process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
    expectStatus({ tts: {} }, { provider: "openai" });
  });
});
