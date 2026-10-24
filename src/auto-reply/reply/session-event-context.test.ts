import { expect, it } from "vitest";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../../cron/scheduled-occurrence.test-support.js";
import { projectChatDisplayMessages } from "../../gateway/chat-display-projection.js";
import { buildSessionEventContext } from "./session-event-context.js";

it("keeps scheduled conversation prompts attributable through chat history projection", () => {
  const sessionKey = "agent:main:scheduled-review";
  const job = makeCronJob({
    sessionTarget: `session:${sessionKey}`,
    state: { runningAtMs: 1_000 },
  });
  const text = "Check the review and continue the authorized task.";
  const ctx = buildSessionEventContext({
    cfg: {},
    agentId: "main",
    sessionKey,
    text,
    options: {
      source: "cron",
      scheduledAutomation: {
        job,
        occurrence: TEST_SCHEDULED_OCCURRENCE,
        admissionSource: "operator-schedule",
        assertCurrent() {},
      },
    },
    occurrenceId: "scheduled-occurrence",
    target: { sessionId: "existing-session", generation: "current" },
    assertCurrent() {},
  });
  const [message] = projectChatDisplayMessages(
    [{ role: "user", content: ctx.Body, provenance: ctx.InputProvenance }],
    { resolveCronJobName: () => "Review watcher" },
  );
  expect(message).toMatchObject({
    role: "assistant",
    content: text,
    provenance: {
      kind: "internal_system",
      sourceTool: "cron",
      jobId: job.id,
      runId: "cron:job-1:1000",
      sourceSessionKey: sessionKey,
    },
    senderSession: { sessionKey, agentId: "main", label: "Review watcher" },
    __openclaw: { turnBoundary: true },
  });
  expect(ctx.BodyForAgent).toBe(text);
});
