import { expect, test, vi } from "vitest";
import { loadSessionEntry, recordInboundSessionMeta } from "../config/sessions/session-accessor.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { setupPersistentSessionListTestHarness } from "./server.sessions.list-changed.fixture.test-support.js";
import { onceMessage, rpcReq, writeSessionStore } from "./test-helpers.js";
import { seedSessionTranscript, sessionStoreEntry } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupPersistentSessionListTestHarness();

// A quiet Telegram service update has no new turn/transcript event to refresh the UI.
test("publishes committed private topic titles to a connected session-list subscriber", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:telegram:direct:42001:thread:42001:77";
  const updatedAt = 123;
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("private-topic-after-reply", {
        updatedAt,
        chatType: "direct",
        displayName: "New Chat",
        topicName: "Before reply",
        modelProvider: "openai",
        model: "synthetic-test-model",
        totalTokens: 17,
      }),
    },
  });
  await seedSessionTranscript({
    storePath,
    sessionKey,
    sessionId: "private-topic-after-reply",
    messages: [{ role: "assistant", content: "Synthetic completed reply" }],
  });
  const ctx = {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    From: "telegram:direct:42001",
    To: "telegram:42001",
    AccountId: "default",
    MessageThreadId: "77",
    ConversationLabel: "Synthetic Sender",
    ThreadLabel: "After reply",
    SessionKey: sessionKey,
  };
  await recordInboundSessionMeta({
    storePath,
    sessionKey,
    ctx: { ...ctx, ThreadLabel: "Before reply" },
    createIfMissing: false,
  });
  const { ws } = await openClient();
  try {
    expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
    // Prime the resident row, as an already-open GUI does before the rename.
    const listed = await rpcReq<{ sessions: Array<{ key: string; displayName?: string }> }>(
      ws,
      "sessions.list",
      {},
    );
    expect(listed.ok).toBe(true);
    expect(listed.payload?.sessions.find((row) => row.key === sessionKey)?.displayName).toBe(
      "Before reply",
    );
    const notices = vi.fn();
    const stop = onSessionLifecycleEvent(notices);
    try {
      const missingKey = "agent:main:telegram:direct:42001:thread:42001:78";
      expect(
        await recordInboundSessionMeta({
          storePath,
          sessionKey: missingKey,
          ctx: { ...ctx, SessionKey: missingKey, MessageThreadId: "78" },
          createIfMissing: false,
        }),
      ).toBeNull();
      expect(loadSessionEntry({ storePath, sessionKey: missingKey })).toBeUndefined();
      expect(notices).not.toHaveBeenCalled();
    } finally {
      stop();
    }
    const changed = onceMessage(
      ws,
      (event) =>
        event.type === "event" &&
        event.event === "sessions.changed" &&
        event.payload?.sessionKey === sessionKey &&
        event.payload?.reason === "metadata",
    );
    await recordInboundSessionMeta({ storePath, sessionKey, ctx, createIfMissing: false });
    expect((await changed).payload?.session).toMatchObject({
      key: sessionKey,
      sessionId: "private-topic-after-reply",
      displayName: "After reply",
      updatedAt,
    });
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      sessionId: "private-topic-after-reply",
      topicName: "After reply",
      updatedAt,
      totalTokens: 17,
    });
  } finally {
    ws.close();
  }
});
