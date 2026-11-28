import { expect, it } from "vitest";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../../cron/scheduled-occurrence.test-support.js";
import { projectChatDisplayMessages } from "../../gateway/chat-display-projection.js";
import { buildGatewayRestartResumeText } from "../../gateway/session-restart-resume-prompt.js";
import { buildSessionEventContext } from "./session-event-context.js";

it.each([false, true])(
  "keeps restart input small and hidden from chat (unresolved shell: %s)",
  (unresolvedShell) => {
    const sourceRunId = "r".repeat(128);
    const text = buildGatewayRestartResumeText(sourceRunId, unresolvedShell);
    const ctx = buildSessionEventContext({
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:repair",
      text,
      options: { source: "restart", sourceRunId },
      occurrenceId: "restart-occurrence",
      target: { sessionId: "existing", generation: "current" },
      assertCurrent() {},
    });
    expect(ctx.Body).toBe(text);
    expect(ctx.BodyForAgent).toBe(text);
    expect(text).toContain(sourceRunId);
    expect(text).not.toMatch(/read[- ]only/i);
    // Even with the longest run ID, stay below the 719-byte pre-#206900 prompt without an ID.
    expect(Buffer.byteLength(text)).toBeLessThan(719);
    const displayed = projectChatDisplayMessages([
      { role: "user", content: ctx.BodyForAgent, provenance: ctx.InputProvenance },
    ]);
    expect(displayed).toEqual([]);
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

it.each([undefined, { version: 1 }, { version: 1, snapshot: null }])(
  "refuses new-session context for an undecodable scheduled authority: %j",
  (source) => {
    expect(() =>
      buildSessionEventContext({
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:scheduled",
        text: "work",
        options: {
          source: "cron",
          scheduledAutomation: {
            job: {
              ...makeCronJob({}),
              operatorSource: { executionRevision: "invalid", source } as never,
            },
            occurrence: TEST_SCHEDULED_OCCURRENCE,
            admissionSource: "operator-schedule",
            assertCurrent() {},
          },
        },
        occurrenceId: "invalid-occurrence",
        target: { sessionId: "", generation: "current" },
        assertCurrent() {},
      }),
    ).toThrow("Restart recovery operator source");
  },
);
