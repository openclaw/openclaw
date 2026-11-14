import { expect, it } from "vitest";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../../cron/scheduled-occurrence.test-support.js";
import { projectChatDisplayMessages } from "../../gateway/chat-display-projection.js";
import { buildSessionEventContext } from "./session-event-context.js";

it.each(["", " Background exec processes were stopped; rerun them if still needed."])(
  "keeps restart recovery intact for the agent and out of chat display: %s",
  (background) => {
    const text =
      "The Gateway restarted while you were working. Resume your work: inspect saved child work before repeating effects. Workspace and publication ownership do not transfer." +
      background;
    const ctx = buildSessionEventContext({
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:repair",
      text,
      options: { source: "restart" },
      occurrenceId: "restart-occurrence",
      target: { sessionId: "existing", generation: "current" },
      assertCurrent() {},
    });
    expect(ctx.Body).toBe(text);
    expect(ctx.BodyForAgent).toBe(text);
    const displayed = projectChatDisplayMessages([
      { role: "user", content: ctx.BodyForAgent, provenance: ctx.InputProvenance },
    ]);
    expect(displayed).toEqual([]);
    expect(JSON.stringify(displayed)).not.toContain("publication ownership");
  },
);

it("retains scheduled execution provenance without projecting the prompt as a result", () => {
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
  const messages = projectChatDisplayMessages(
    [{ role: "user", content: ctx.Body, provenance: ctx.InputProvenance }],
    { resolveCronJobName: () => "Review watcher" },
  );
  expect(messages).toEqual([]);
  expect(ctx.InputProvenance).toEqual({
    kind: "internal_system",
    sourceTool: "cron_execution",
    jobId: job.id,
    runId: "cron:job-1:1000",
    sourceSessionKey: sessionKey,
  });
  expect(ctx.BodyForAgent).toBe(text);
});

it.for([
  { route: "the session's own WebChat route", to: "agent:main:webchat-owner", chatType: "direct" },
  { route: "another session's WebChat route", to: "agent:main:other", chatType: undefined },
])("keeps the session chat type only for $route", ({ to, chatType }) => {
  const ctx = buildSessionEventContext({
    cfg: {},
    agentId: "main",
    sessionKey: "agent:main:webchat-owner",
    text: "Exec completed.",
    options: { source: "exec" },
    occurrenceId: "exec-occurrence",
    deliveryContext: { channel: "webchat", to },
    target: { sessionId: "existing-session", generation: "current", chatType: "direct" },
    assertCurrent() {},
  });
  expect(ctx.ChatType).toBe(chatType);
});
