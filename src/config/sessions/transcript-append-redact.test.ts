import { describe, expect, it } from "vitest";
import {
  onInternalSessionTranscriptUpdate,
  onSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { loadTranscriptEvents, replaceSessionEntry } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { createExactAssistantMessage } from "./transcript-message.test-support.js";
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

describe("appendExactAssistantMessageToSessionTranscript - source fidelity", () => {
  const fixture = useTempSessionsFixture("exact-assistant-redact-test-");

  async function seedSessionEntry() {
    const scope = {
      sessionId: "test-session",
      sessionKey: "test-channel:test-user",
      storePath: fixture.storePath(),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    return scope;
  }

  it("retains validated opaque provider replay state exactly", async () => {
    const { sessionId, sessionKey, storePath } = await seedSessionEntry();
    const publicUpdates: Array<{ message?: unknown }> = [];
    const internalUpdates: Array<{ message?: unknown }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => publicUpdates.push(update));
    const unsubscribeInternal = onInternalSessionTranscriptUpdate((update) =>
      internalUpdates.push(update),
    );
    const message: Parameters<typeof appendExactAssistantMessageToSessionTranscript>[0]["message"] =
      {
        ...createExactAssistantMessage({}),
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

  it("preserves secret-shaped text in exact assistant transcript appends", async () => {
    const scope = await seedSessionEntry();
    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const signature = JSON.stringify({
      id: "A".repeat(416),
      type: "reasoning",
      summary: [],
      encrypted_content: "Q".repeat(32) + "/LTAI" + "B".repeat(20) + "/" + "C".repeat(6),
    });
    const updates: Array<{ message?: unknown }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const result = await appendExactAssistantMessageToSessionTranscript({
        ...scope,
        config: {},
        message: createExactAssistantMessage({
          content: [
            { type: "text", text: `Here is your key: ${fakeApiKey}` },
            { type: "thinking", thinking: "", thinkingSignature: signature },
          ],
          provider: "github-copilot",
          model: "test-model",
        }),
      });
      expect(result.ok).toBe(true);
      const stored = await readStoredMessages(scope);
      expect(stored).toHaveLength(1);
      const [diskMessage] = stored;
      expect(diskMessage).toMatchObject({
        content: [{ type: "text" }, { thinkingSignature: signature }],
      });
      expect(JSON.stringify(diskMessage)).toContain(fakeApiKey);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message).toEqual(diskMessage);
      expect(JSON.stringify(updates[0]?.message)).toContain(fakeApiKey);
    } finally {
      unsubscribe();
    }
  });

  it.each([false, true])("dedupes persisted secret-shaped text (legacy=%s)", async (legacy) => {
    const scope = await seedSessionEntry();
    const fakeApiKey = legacy
      ? "sk-proj-OLDERUNREDACTEDTRANSCRIPT1234567890"
      : "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const text = `Here is your key: ${fakeApiKey}`;
    const params = { ...scope, config: {}, text };
    const first = legacy
      ? await appendExactAssistantMessageToSessionTranscript({
          ...params,
          message: createExactAssistantMessage({
            text,
            provider: "openclaw",
            model: "legacy-assistant",
          }),
        })
      : await appendAssistantMessageToSessionTranscript(params);
    const second = await appendAssistantMessageToSessionTranscript(params);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error("expected successful transcript appends");
    }
    expect(second.messageId).toBe(first.messageId);
    const events = await loadTranscriptEvents(scope);
    expect(JSON.stringify(events)).toContain(fakeApiKey);
    expect(events.filter((event) => (event as { type?: unknown }).type === "message")).toHaveLength(
      1,
    );
  });
});
