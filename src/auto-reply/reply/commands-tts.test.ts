// Tests text-to-speech command configuration, preference persistence, and summaries.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessageSync,
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { setTtsMaxLength as persistTtsMaxLength } from "../../tts/tts-settings-writes.js";

const ttsMocks = vi.hoisted(() => ({
  getResolvedSpeechProviderConfig: vi.fn(),
  getLastTtsAttempt: vi.fn(),
  getTtsMaxLength: vi.fn(),
  getTtsPersona: vi.fn(),
  getTtsProviderAsync: vi.fn(),
  isSummarizationEnabled: vi.fn(),
  isTtsEnabled: vi.fn(),
  isTtsProviderConfiguredAsync: vi.fn(),
  listTtsPersonas: vi.fn(),
  resolveTtsConfig: vi.fn(),
  resolveTtsPrefsPathAsync: vi.fn(),
  setLastTtsAttempt: vi.fn(),
  setSummarizationEnabled: vi.fn(),
  setTtsEnabled: vi.fn(),
  setTtsMaxLength: vi.fn(),
  setTtsPersona: vi.fn(),
  setTtsProvider: vi.fn(),
  textToSpeech: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: vi.fn((provider: string) => provider),
  getSpeechProvider: vi.fn(() => null),
  listSpeechProviders: vi.fn(() => []),
}));

vi.mock("../../tts/tts.js", () => ttsMocks);

const { handleTtsCommands } = await import("./commands-tts.js");
const PRIMARY_TTS_PROVIDER = "acme-speech";
const FALLBACK_TTS_PROVIDER = "backup-speech";
type TtsCommandResult = Awaited<ReturnType<typeof handleTtsCommands>>;

afterEach(() => memorySessionActorOwners.reset());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function buildTtsParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig = {},
  agentId?: string,
  overrides: Partial<Parameters<typeof handleTtsCommands>[0]> = {},
): Parameters<typeof handleTtsCommands>[0] {
  return {
    cfg,
    agentId,
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderId: "owner",
      channel: "forum",
    },
    sessionKey: "session-key",
    ...overrides,
  } as unknown as Parameters<typeof handleTtsCommands>[0];
}

function expectHandled(result: TtsCommandResult): NonNullable<TtsCommandResult> {
  if (!result) {
    throw new Error("Expected TTS command to be handled");
  }
  expect(result.shouldContinue).toBe(false);
  return result;
}

function expectReply(
  result: TtsCommandResult,
): NonNullable<NonNullable<TtsCommandResult>["reply"]> {
  const handled = expectHandled(result);
  if (!handled.reply) {
    throw new Error("Expected TTS command to return a reply");
  }
  return handled.reply;
}

async function reply(...args: Parameters<typeof buildTtsParams>) {
  return expectReply(await handleTtsCommands(buildTtsParams(...args), true));
}

function mockAudio(audioPath: string, extra: Record<string, unknown> = {}) {
  ttsMocks.textToSpeech.mockResolvedValue({
    success: true,
    audioPath,
    provider: PRIMARY_TTS_PROVIDER,
    voiceCompatible: true,
    ...extra,
  });
}

async function transcriptFixture(agentId = "main", sessionKey = "session-key", sessionId = "s1") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tts-latest-"));
  const storePath = path.join(tempDir, "sessions.json");
  const sessionEntry: SessionEntry = { sessionId, updatedAt: 1 };
  const scope = {
    agentId,
    sessionId,
    sessionKey,
    storePath: resolveSessionStorePathForScope({ agentId, sessionKey, storePath }),
  };
  await replaceSessionEntry(scope, sessionEntry);
  return {
    scope,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    storePath,
  };
}

function transcriptText(text: string, phase: "commentary" | "final_answer") {
  return {
    type: "text" as const,
    text,
    textSignature: JSON.stringify({
      v: 1,
      id: phase === "commentary" ? "item_commentary" : "item_final",
      phase,
    }),
  };
}

describe("handleTtsCommands status fallback reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ttsMocks.resolveTtsConfig.mockReturnValue({});
    ttsMocks.resolveTtsPrefsPathAsync.mockResolvedValue("/tmp/tts-prefs.json");
    ttsMocks.isTtsEnabled.mockReturnValue(true);
    ttsMocks.getTtsProviderAsync.mockReturnValue(PRIMARY_TTS_PROVIDER);
    ttsMocks.getTtsPersona.mockReturnValue(undefined);
    ttsMocks.isTtsProviderConfiguredAsync.mockReturnValue(true);
    ttsMocks.getTtsMaxLength.mockReturnValue(1500);
    ttsMocks.isSummarizationEnabled.mockReturnValue(true);
    ttsMocks.getLastTtsAttempt.mockReturnValue(undefined);
    ttsMocks.listTtsPersonas.mockReturnValue([]);
  });

  it("does not coerce partial TTS limit values", async () => {
    expect((await reply("/tts limit 2000chars")).text).toBe(
      "❌ Limit must be between 100 and 4096 characters.",
    );
    expect(ttsMocks.setTtsMaxLength).not.toHaveBeenCalled();
  });

  it("replies with repair guidance without overwriting malformed preferences", async () => {
    const prefsPath = path.join(tempDirs.make("openclaw-tts-command-prefs-"), "tts.json");
    const malformed = '{"tts":{"provider":"custom",';
    fs.writeFileSync(prefsPath, malformed);
    ttsMocks.resolveTtsPrefsPathAsync.mockResolvedValue(prefsPath);
    ttsMocks.setTtsMaxLength.mockImplementationOnce(persistTtsMaxLength);

    const result = await handleTtsCommands(buildTtsParams("/tts limit 2000"), true);

    expect(expectReply(result).text).toContain("Repair the preference file or its permissions");
    expect(fs.readFileSync(prefsPath, "utf8")).toBe(malformed);
  });

  it("shows attempted provider chain for failed attempts", async () => {
    ttsMocks.getLastTtsAttempt.mockReturnValue({
      timestamp: Date.now() - 1_000,
      success: false,
      textLength: 128,
      summarized: false,
      error: "TTS conversion failed",
      attemptedProviders: [PRIMARY_TTS_PROVIDER, FALLBACK_TTS_PROVIDER],
      attempts: [
        {
          provider: PRIMARY_TTS_PROVIDER,
          outcome: "failed",
          reasonCode: "timeout",
          latencyMs: 999,
        },
      ],
      latencyMs: 420,
    });

    const status = await reply("/tts status");
    expect(status.text).toContain("Error: TTS conversion failed");
    expect(status.text).toContain(`Attempts: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`);
    expect(status.text).toContain(`Attempt details: ${PRIMARY_TTS_PROVIDER}:failed(timeout) 999ms`);
  });

  it("persists fallback metadata from /tts audio and renders it in /tts status", async () => {
    let lastAttempt: Record<string, unknown> | undefined;
    ttsMocks.getLastTtsAttempt.mockImplementation(() => lastAttempt);
    ttsMocks.setLastTtsAttempt.mockImplementation((next: Record<string, unknown>) => {
      lastAttempt = next;
    });
    mockAudio("/tmp/fallback.ogg", {
      provider: FALLBACK_TTS_PROVIDER,
      fallbackFrom: PRIMARY_TTS_PROVIDER,
      attemptedProviders: [PRIMARY_TTS_PROVIDER, FALLBACK_TTS_PROVIDER],
      attempts: [
        {
          provider: PRIMARY_TTS_PROVIDER,
          outcome: "failed",
          reasonCode: "provider_error",
          latencyMs: 65,
        },
        {
          provider: FALLBACK_TTS_PROVIDER,
          outcome: "success",
          reasonCode: "success",
          latencyMs: 175,
        },
      ],
      latencyMs: 175,
    });

    const audioReply = await reply("/tts audio hello world");
    expect(audioReply.mediaUrl).toBe("/tmp/fallback.ogg");

    const statusReply = await reply("/tts status");
    expect(statusReply.text).toContain(`Provider: ${FALLBACK_TTS_PROVIDER}`);
    expect(statusReply.text).toContain(
      `Fallback: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(statusReply.text).toContain(
      `Attempts: ${PRIMARY_TTS_PROVIDER} -> ${FALLBACK_TTS_PROVIDER}`,
    );
    expect(statusReply.text).toContain(
      `Attempt details: ${PRIMARY_TTS_PROVIDER}:failed(provider_error) 65ms, ${FALLBACK_TTS_PROVIDER}:success(ok) 175ms`,
    );
  });

  it("keeps base status fields in display order", async () => {
    expect((await reply("/tts")).text).toBe(
      [
        "📊 TTS status",
        "State: ✅ enabled",
        "Chat override: default",
        `Provider: ${PRIMARY_TTS_PROVIDER} (✅ configured)`,
        "Persona: none",
        "Text limit: 1500 chars",
        "Auto-summary: on",
      ].join("\n"),
    );
  });

  it("passes the active agent and account ids to /tts audio synthesis", async () => {
    mockAudio("/tmp/reader.ogg");
    const cfg = {
      agents: { entries: { reader: { tts: { provider: PRIMARY_TTS_PROVIDER } } } },
    } as OpenClawConfig;

    const result = await handleTtsCommands(
      buildTtsParams("/tts audio hello", cfg, "reader", {
        ctx: { AccountId: "feishu-main" },
      }),
      true,
    );

    expectHandled(result);
    const speechCall = ttsMocks.textToSpeech.mock.lastCall?.[0];
    expect(speechCall).toMatchObject({
      text: "hello",
      agentId: "reader",
      accountId: "feishu-main",
    });
    expect(speechCall?.cfg).toBe(cfg);
  });

  it("lists and sets configured TTS personas", async () => {
    ttsMocks.listTtsPersonas.mockReturnValue([
      {
        id: "alfred",
        label: "Alfred",
        provider: "google",
      },
    ]);

    const listReply = await reply("/tts persona");
    expect(listReply.text).toContain("alfred (Alfred) provider=google");

    const setResult = await handleTtsCommands(buildTtsParams("/tts persona alfred"), true);
    expectHandled(setResult);
    expect(ttsMocks.setTtsPersona).toHaveBeenCalledWith("/tmp/tts-prefs.json", "alfred");
  });

  it.each([
    { command: "/tts latest", audioAsVoice: true },
    { command: "/tts read latest", audioAsVoice: false },
  ])(
    "reads the latest assistant reply via $command with voice delivery $audioAsVoice",
    async ({ command, audioAsVoice }) => {
      const { scope, ...fixture } = await transcriptFixture("other", "agent:other:tts-latest");
      const { sessionEntry } = fixture;
      appendTranscriptMessageSync(scope, {
        message: { role: "assistant", content: [{ type: "text", text: "older reply" }] },
      });
      Object.assign(sessionEntry, loadSessionEntry(scope));
      appendTranscriptMessageSync(scope, {
        message: {
          role: "assistant",
          content: [
            transcriptText("internal note", "commentary"),
            transcriptText("latest visible reply", "final_answer"),
          ],
        },
      });
      mockAudio("/tmp/latest.ogg", { audioAsVoice });
      const beforeTtsRead = Date.now();
      const initialSessionEntry = structuredClone(sessionEntry);
      const audio = await reply(command, {}, "main", {
        ...fixture,
        initialSessionEntry,
      });
      expect(audio).toMatchObject({
        mediaUrl: "/tmp/latest.ogg",
        audioAsVoice,
        spokenText: "latest visible reply",
      });
      expect(ttsMocks.textToSpeech.mock.lastCall?.[0]?.text).toBe("latest visible reply");
      expect(sessionEntry.lastTtsReadLatestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(sessionEntry.lastTtsReadLatestAt).toBeGreaterThanOrEqual(beforeTtsRead);
    },
  );

  it("reads the latest assistant reply from the incognito transcript store", async () => {
    const { scope, ...fixture } = await transcriptFixture(
      "main",
      "agent:main:dashboard:incognito-tts-latest",
      "incognito-session",
    );
    await appendTranscriptMessage(scope, {
      message: { role: "assistant", content: "incognito latest reply" },
    });
    mockAudio("/tmp/incognito-latest.ogg");

    const audio = await reply("/tts latest", {}, "main", {
      ...fixture,
      initialSessionEntry: structuredClone(fixture.sessionEntry),
    });
    expect(audio.spokenText).toBe("incognito latest reply");
  });

  it("does not resend /tts latest for the same assistant reply", async () => {
    const { scope, ...fixture } = await transcriptFixture();
    const { sessionEntry } = fixture;
    appendTranscriptMessageSync(scope, {
      message: { role: "assistant", content: [{ type: "text", text: "read me once" }] },
    });
    Object.assign(sessionEntry, loadSessionEntry(scope));
    const initialSessionEntry = structuredClone(sessionEntry);
    mockAudio("/tmp/latest.ogg");
    const params = buildTtsParams("/tts latest", {}, "main", {
      ...fixture,
      initialSessionEntry,
    });

    expect(expectReply(await handleTtsCommands(params, true)).mediaUrl).toBe("/tmp/latest.ogg");
    ttsMocks.textToSpeech.mockClear();

    expect(expectReply(await handleTtsCommands(params, true)).text).toContain("already sent");
    expect(ttsMocks.textToSpeech).not.toHaveBeenCalled();
  });

  it("stores chat-scoped TTS overrides on the session entry", async () => {
    const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
    const sessionStore = { "session-key": sessionEntry };
    const chat = (action: string) =>
      reply(`/tts chat ${action}`, {}, undefined, { sessionEntry, sessionStore });

    expect((await chat("on")).text).toContain("enabled for this chat");
    expect(sessionEntry.ttsAuto).toBe("always");

    expect((await chat("off")).text).toContain("disabled for this chat");
    expect(sessionEntry.ttsAuto).toBe("off");

    expect((await chat("default")).text).toContain("override cleared");
    expect(sessionEntry.ttsAuto).toBeUndefined();
  });
});
