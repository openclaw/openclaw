import path from "node:path";
import { expect, it } from "vitest";
import {
  appendTranscriptMessages,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { buildCronFailureRepairBrief } from "../cron/service/failure-repair-brief.js";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.message.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import { projectPendingInputMessage } from "./server-methods/chat-pending-inputs.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

it("keeps scheduler repair inputs in the model transcript, not pending, live, or reloaded chat", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const entry = { sessionId: "automation-repair", updatedAt: 1 };
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:automation-repair",
      sessionId: entry.sessionId,
      storePath: path.join(state.sessionsDir("main"), "sessions.json"),
    };
    await replaceSessionEntry(scope, entry);
    const brief = buildCronFailureRepairBrief({
      job: makeCronJob({ id: "queue-check" }),
      consecutiveErrors: 2,
      error: "The queue helper is unavailable.",
    });
    const repair = buildPersistedUserTurnMessage({
      text: brief,
      timestamp: 2,
      provenance: {
        kind: "internal_system",
        sourceTool: "cron_failure_repair",
        jobId: "queue-check",
      },
    });
    const human = { role: "user", content: "Keep checking the queue.", timestamp: 1 };
    const answer = {
      role: "assistant",
      content: "Updated the queue helper path.",
      timestamp: 3,
      __openclaw: { runId: "cron-failure-repair:repair-1" },
    };
    const quote = { ...human, content: brief, timestamp: 4 };
    await appendTranscriptMessages(scope, {
      messages: [human, repair, answer, quote].map((message, index) => ({
        eventId: `message-${index}`,
        message,
        now: index + 1,
      })),
    });
    const history = await readChatHistoryPage({
      ...scope,
      entry,
      provider: undefined,
      sessionAgentId: scope.agentId,
      canonicalKey: scope.sessionKey,
      max: 20,
      maxHistoryBytes: 100_000,
      effectiveMaxChars: 20_000,
      offset: undefined,
      messageId: undefined,
    });
    expect(history.messages).toMatchObject([human, answer, quote]);
    const live = (message: unknown) =>
      projectSessionMessagePayload({ message, sessionKey: scope.sessionKey }).payload;
    expect(live(repair)).toBeUndefined();
    expect(live(answer)?.message).toMatchObject(answer);
    const pending = projectPendingInputMessage(
      {
        id: "repair-1",
        runId: "cron-failure-repair:repair-1",
        message: repair,
        acceptedAt: 2,
        state: "queued",
      },
      20_000,
    );
    expect(pending).toBeUndefined();
    expect(await loadTranscriptEvents(scope)).toContainEqual(
      expect.objectContaining({ type: "message", message: expect.objectContaining(repair) }),
    );
    expect(repair).not.toHaveProperty("display");
  });
});
