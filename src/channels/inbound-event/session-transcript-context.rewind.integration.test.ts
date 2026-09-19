// Turn-level proof of the rewind/branch cache prune against the real session
// store: Telegram ingress is seeded into the transcript, a rewind cuts a turn
// pair, and the prepared channel turn must assemble the next model input
// without the discarded cached entries. Only the record/dispatch edges are
// mocked; the merge owner and both transcript reads run for real.
//
// The chat window is seeded from extensions/telegram/src/__fixtures__/telegram-rewind-chat-window.json
// because core test graphs may not include extension files. The extension-side
// test bot-message-context.rewind-window-fixture.test.ts rebuilds the same
// window through the real Telegram context pipeline and pins it to that
// fixture, so this seed cannot drift from what ingress actually assembles.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildChannelSourceTurnId } from "../../auto-reply/reply/source-turn-id.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { conversationIdentityFromMsgContext } from "../../config/sessions/conversation-identity.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  rewindSessionToMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../../config/sessions/session-transcript-reconcile.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { runPreparedChannelTurn } from "../turn/execution.js";

const agentId = "main";
const sessionKey = "agent:main:telegram:dm:1001";

function telegramContext(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "fresh follow-up",
    RawBody: "fresh follow-up",
    CommandBody: "fresh follow-up",
    From: "telegram:1001",
    To: "1001",
    SessionKey: sessionKey,
    AgentId: agentId,
    Provider: "telegram",
    Timestamp: 5_000,
    CommandAuthorized: false,
    SessionTranscriptContext: { historyLimit: 10 },
    ...overrides,
  };
}

function loadTelegramRewindWindow(): FinalizedMsgContext["ChannelStructuredContext"] {
  const fixtureUrl = new URL(
    "../../../extensions/telegram/src/__fixtures__/telegram-rewind-chat-window.json",
    import.meta.url,
  );
  return JSON.parse(readFileSync(fixtureUrl, "utf8"));
}

describe("prepared channel turn after a transcript rewind", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("drops the rewound-away cached turns from the next model input", async () => {
    const stateDir = tempDirs.make("openclaw-rewind-turn-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const storePath = resolveDefaultSessionStorePath(agentId);

    const windowEntries = loadTelegramRewindWindow();
    const seededWindow = windowEntries?.[0];
    const seededMessages = (
      seededWindow?.payload && typeof seededWindow.payload === "object"
        ? (seededWindow.payload as Record<string, unknown>).messages
        : undefined
    ) as Array<Record<string, unknown>> | undefined;
    // The seed must carry all three cached turns, with the assistant reply
    // tied to transcript turn assistant-2; without that shape the prune
    // assertions below would prove nothing.
    expect(seededMessages?.map((message) => message.message_id)).toEqual(["101", "102", "103"]);
    expect(seededMessages?.[2]?.session_transcript_id).toBe("assistant-2");

    const ctx = telegramContext({ ChannelStructuredContext: windowEntries });
    const conversationIdentity = conversationIdentityFromMsgContext({ ctx });
    expect(conversationIdentity?.conversationRef).toBeTruthy();
    const transportTurnId = (messageId: string) => {
      const key = buildChannelSourceTurnId({
        provider: conversationIdentity?.channel,
        accountId: conversationIdentity?.accountId,
        conversationId: conversationIdentity?.deliveryTarget,
        messageId,
      });
      if (!key) {
        throw new Error("test context must resolve a source-turn id");
      }
      return key;
    };

    const scope = { agentId, env, sessionId: "rewind-source", sessionKey };
    await upsertSessionEntryCore(scope, { sessionId: "rewind-source", updatedAt: 1_000 });
    await appendTranscriptEvent(scope, {
      type: "session",
      id: "rewind-source",
      version: 3,
      timestamp: "2026-07-18T00:00:00.000Z",
    });
    const appendTurn = (
      eventId: string,
      parentId: string | null,
      message: Record<string, unknown>,
      timestamp: string,
    ) =>
      appendTranscriptMessage(scope, {
        eventId,
        message: message as never,
        now: Date.parse(timestamp),
        parentId,
      });
    await appendTurn(
      "user-1",
      null,
      {
        role: "user",
        content: "retained question",
        idempotencyKey: transportTurnId("101"),
        __openclaw: {
          transport: {
            channel: "telegram",
            conversationRef: conversationIdentity?.conversationRef,
            messageId: "101",
          },
        },
      },
      "2026-07-18T00:00:01.000Z",
    );
    await appendTurn(
      "assistant-1",
      "user-1",
      { role: "assistant", content: "retained answer" },
      "2026-07-18T00:00:02.000Z",
    );
    await appendTurn(
      "user-2",
      "assistant-1",
      {
        role: "user",
        content: "discarded question",
        idempotencyKey: transportTurnId("102"),
        __openclaw: {
          transport: {
            channel: "telegram",
            conversationRef: conversationIdentity?.conversationRef,
            messageId: "102",
          },
        },
      },
      "2026-07-18T00:00:03.000Z",
    );
    await appendTurn(
      "assistant-2",
      "user-2",
      { role: "assistant", content: "discarded reply" },
      "2026-07-18T00:00:04.000Z",
    );
    await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
    const rewind = await rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey });
    expect(rewind.status).toBe("created");

    const recordInboundSession = vi.fn(async () => undefined);
    const runDispatch = vi.fn(async () => ({ queuedFinal: false }));
    await runPreparedChannelTurn({
      channel: "telegram",
      routeSessionKey: sessionKey,
      storePath,
      ctxPayload: ctx,
      recordInboundSession,
      runDispatch,
    });

    const windowEntry = ctx.ChannelStructuredContext?.[0];
    const payload = (windowEntry?.payload ?? {}) as Record<string, unknown>;
    const messages = (payload.messages ?? []) as Array<Record<string, unknown>>;
    const rendered = messages.map(
      (message) => `${String(message.message_id)}:${String(message.body)}`,
    );
    // Discarded cached entries are gone from the next model input: the cut
    // transport message, the cut transcript id, and neither discarded text.
    expect(rendered.join("\n")).not.toContain("discarded");
    expect(messages.some((message) => message.message_id === "102")).toBe(false);
    expect(messages.some((message) => message.session_transcript_id === "assistant-2")).toBe(false);
    // The retained cache entry and the active transcript turns remain.
    expect(rendered.join("\n")).toContain("retained question");
    expect(rendered.join("\n")).toContain("retained answer");
    expect(recordInboundSession).toHaveBeenCalledOnce();
    expect(runDispatch).toHaveBeenCalledOnce();
  });
});
