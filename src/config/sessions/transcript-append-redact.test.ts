// Transcript append redaction tests cover secret scrubbing when appending transcript entries.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { loadTranscriptEvents, replaceSessionEntry } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "./transcript.js";

const OPAQUE_COMPACTION =
  "gAAAAABpQnQrXzzZqcAfo3unbAY-ku84xgsvB0fpLkbDvSh3WS5qzfSCmcgwr8_abcdefghijvK2RyV2GQ4ohzcfYwhRwTvY76TvR7Tvr_";

async function readStoredMessages(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
}) {
  return (await loadTranscriptEvents(params))
    .map((event) => event as { type?: string; message?: unknown })
    .filter((record) => record.type === "message")
    .map((record) => record.message);
}

describe("appendExactAssistantMessageToSessionTranscript - redaction", () => {
  const fixture = useTempSessionsFixture("exact-assistant-redact-test-");

  async function seedSessionEntry(params: {
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) {
    await replaceSessionEntry(
      { sessionKey: params.sessionKey, storePath: params.storePath },
      { sessionId: params.sessionId, updatedAt: Date.now() },
    );
  }

  it("retains validated opaque provider replay state exactly", async () => {
    const sessionsDir = fixture.sessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "test-session-provider-replay";
    const sessionKey = "test-channel:test-provider-replay";
    await seedSessionEntry({ sessionId, sessionKey, storePath });

    const publicUpdates: Array<{ message?: unknown }> = [];
    const internalUpdates: Array<{ message?: unknown }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => publicUpdates.push(update));
    const unsubscribeInternal = onInternalSessionTranscriptUpdate((update) =>
      internalUpdates.push(update),
    );
    const message: Parameters<typeof appendExactAssistantMessageToSessionTranscript>[0]["message"] =
      {
        role: "assistant",
        content: [{ type: "text", text: "visible" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-luna",
        providerReplay: {
          v: 1,
          type: "openai-responses-compaction",
          id: "cmp_persisted",
          data: OPAQUE_COMPACTION,
          replayIndex: 0,
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.6-luna",
          baseUrlHash: "ozhevd1smnk8s",
          sessionHash: "171dzdv17gum5g",
          authProfileHash: "oe8bkr3r8947",
        },
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
    let result: Awaited<ReturnType<typeof appendExactAssistantMessageToSessionTranscript>>;
    try {
      result = await appendExactAssistantMessageToSessionTranscript({
        sessionKey,
        storePath,
        config: {},
        message,
      });
    } finally {
      unsubscribe();
      unsubscribeInternal();
    }

    expect(result.ok).toBe(true);
    const [stored] = (await readStoredMessages({ sessionId, sessionKey, storePath })) as Array<{
      providerReplay?: { data?: string; sessionHash?: string; authProfileHash?: string };
    }>;
    expect(stored?.providerReplay).toMatchObject({
      data: OPAQUE_COMPACTION,
      sessionHash: "171dzdv17gum5g",
      authProfileHash: "oe8bkr3r8947",
    });
    expect(publicUpdates).toHaveLength(1);
    expect(publicUpdates[0]?.message).not.toHaveProperty("providerReplay");
    expect(internalUpdates).toHaveLength(1);
    expect(internalUpdates[0]?.message).toEqual(stored);
    expect(internalUpdates[0]?.message).toHaveProperty("providerReplay.data", OPAQUE_COMPACTION);
  });

  it("always redacts exact assistant transcript appends", async () => {
    const sessionsDir = fixture.sessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "test-session-redact-off";
    const sessionKey = "test-channel:test-user";
    await seedSessionEntry({ sessionId, sessionKey, storePath });

    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const config: OpenClawConfig = {};
    const signature = JSON.stringify({
      id: "A".repeat(416),
      type: "reasoning",
      summary: [],
      encrypted_content: "Q".repeat(32) + "/LTAI" + "B".repeat(20) + "/" + "C".repeat(6),
    });

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath,
      config,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `Here is your key: ${fakeApiKey}` },
          { type: "thinking", thinking: "", thinkingSignature: signature },
        ],
        api: "openai-responses",
        provider: "github-copilot",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const stored = await readStoredMessages({ sessionId, sessionKey, storePath });
    expect(stored).toMatchObject([
      { content: [{ type: "text" }, { thinkingSignature: signature }] },
    ]);
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain(fakeApiKey);
  });

  it("emits the redacted assistant message for inline transcript updates", async () => {
    const sessionsDir = fixture.sessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "test-session-redact-event";
    const sessionKey = "test-channel:test-redact-event";
    await seedSessionEntry({ sessionId, sessionKey, storePath });

    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const config: OpenClawConfig = {};
    const updates: Array<{ message?: unknown }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    try {
      const result = await appendExactAssistantMessageToSessionTranscript({
        sessionKey,
        storePath,
        config,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Here is your key: ${fakeApiKey}` }],
          api: "openai-responses",
          provider: "openclaw",
          model: "test-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const [diskMessage] = await readStoredMessages({ sessionId, sessionKey, storePath });
      expect(JSON.stringify(diskMessage)).not.toContain(fakeApiKey);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message).toEqual(diskMessage);
      expect(JSON.stringify(updates[0]?.message)).not.toContain(fakeApiKey);
    } finally {
      unsubscribe();
    }
  });

  it("dedupes delivery mirrors against the redacted persisted text", async () => {
    const sessionsDir = fixture.sessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "test-session-redact-dedupe";
    const sessionKey = "test-channel:test-redact-dedupe";
    await seedSessionEntry({ sessionId, sessionKey, storePath });

    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const config: OpenClawConfig = {};

    const first = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      storePath,
      config,
      text: `Here is your key: ${fakeApiKey}`,
    });
    const second = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      storePath,
      config,
      text: `Here is your key: ${fakeApiKey}`,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(second.messageId).toBe(first.messageId);

    const events = await loadTranscriptEvents({ sessionId, sessionKey, storePath });
    expect(JSON.stringify(events)).not.toContain(fakeApiKey);
    expect(events.filter((event) => (event as { type?: unknown }).type === "message")).toHaveLength(
      1,
    );
  });

  it("dedupes delivery mirrors against existing assistant entries", async () => {
    const sessionsDir = fixture.sessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "test-session-redact-upgrade-dedupe";
    const sessionKey = "test-channel:test-redact-upgrade-dedupe";
    await seedSessionEntry({ sessionId, sessionKey, storePath });

    const fakeApiKey = "sk-proj-OLDERUNREDACTEDTRANSCRIPT1234567890";
    const unredacted = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath,
      config: {},
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Here is your key: ${fakeApiKey}` }],
        api: "openai-responses",
        provider: "openclaw",
        model: "legacy-assistant",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });
    const deduped = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      storePath,
      config: {},
      text: `Here is your key: ${fakeApiKey}`,
    });

    expect(unredacted.ok).toBe(true);
    expect(deduped.ok).toBe(true);
    if (!unredacted.ok || !deduped.ok) {
      return;
    }
    expect(deduped.messageId).toBe(unredacted.messageId);

    const events = await loadTranscriptEvents({ sessionId, sessionKey, storePath });
    expect(JSON.stringify(events)).not.toContain(fakeApiKey);
    expect(events.filter((event) => (event as { type?: unknown }).type === "message")).toHaveLength(
      1,
    );
  });
});
