import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { recordChannelFeedbackEvent } from "./feedback-reflection.js";

it("persists channel feedback through its real entry without caller-thread SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const scope = {
      agentId: "main",
      sessionId: "feedback-session",
      sessionKey: "agent:main:feedback",
      env,
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const storePath = openOpenClawAgentDatabase(scope).path;
    const event = { type: "feedback", id: "feedback", value: "negative" };
    const sql = observeHostDataSql();
    try {
      await expect(
        recordChannelFeedbackEvent({
          cfg: { session: { store: storePath } },
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          event,
        }),
      ).resolves.toBe(true);
      const executions = sql.calls.slice(1).reduce((sum, call) => sum + call.mock.calls.length, 0);
      expect(sql.queries, `MAIN feedback: ${executions} SQL executions`).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(loadTranscriptEventsSync({ ...scope, storePath })).toContainEqual(event);
    await expect(
      recordChannelFeedbackEvent({
        cfg: { session: { store: storePath } },
        agentId: scope.agentId,
        sessionKey: "agent:main:missing-feedback-session",
        event,
      }),
    ).resolves.toBe(false);
    expect(loadTranscriptEventsSync({ ...scope, storePath })).toEqual([event]);
  });
});
