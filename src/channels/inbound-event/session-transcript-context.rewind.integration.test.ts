// Turn-level proof of the rewind/branch cache prune against the real session
// store: Telegram ingress is seeded into the transcript, a rewind cuts a turn
// pair, and the prepared channel turn must assemble the next model input
// without the discarded cached entries. Only the record/dispatch edges are
// mocked; the merge owner and both transcript reads run for real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
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
const sessionKey = "agent:main:telegram:dm:chat-1";

function telegramContext(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "fresh follow-up",
    RawBody: "fresh follow-up",
    CommandBody: "fresh follow-up",
    From: "telegram:chat-1",
    To: "chat-1",
    SessionKey: sessionKey,
    AgentId: agentId,
    Provider: "telegram",
    Timestamp: 5_000,
    CommandAuthorized: false,
    SessionTranscriptContext: { historyLimit: 10 },
    ...overrides,
  };
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

    const ctx = telegramContext({
      ChannelStructuredContext: [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          payload: {
            order: "chronological",
            relation: "selected_for_current_message",
            messages: [
              { message_id: "101", sender: "Pat", body: "retained question", timestamp_ms: 1_000 },
              { message_id: "102", sender: "Pat", body: "discarded question", timestamp_ms: 2_000 },
              {
                message_id: "103",
                sender: "Bot",
                body: "discarded reply",
                timestamp_ms: 3_000,
                session_transcript_id: "assistant-2",
              },
            ],
          },
        },
      ],
    });
    const conversationRef = conversationIdentityFromMsgContext({ ctx })?.conversationRef;
    expect(conversationRef).toBeTruthy();

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
        __openclaw: { transport: { channel: "telegram", conversationRef, messageId: "101" } },
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
        __openclaw: { transport: { channel: "telegram", conversationRef, messageId: "102" } },
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
