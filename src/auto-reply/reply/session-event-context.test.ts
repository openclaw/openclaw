import { expect, it } from "vitest";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { TEST_SCHEDULED_OCCURRENCE } from "../../cron/scheduled-occurrence.test-support.js";
import { projectChatDisplayMessages } from "../../gateway/chat-display-projection.js";
import { buildSessionEventContext } from "./session-event-context.js";

it("carries the host-captured native conversation id into hook identity context", () => {
  const ctx = buildSessionEventContext({
    cfg: {},
    agentId: "main",
    sessionKey: "agent:main:cron:proof-job",
    text: "background completion turn",
    options: { source: "restart" },
    occurrenceId: "chatid-occurrence",
    deliveryContext: {
      channel: "discord",
      // Route addresses are prefixed ("channel:<id>"); they are not the
      // native conversation identity and must not leak into ChatId.
      to: "channel:123456789012345678",
      accountId: "acct-1",
    },
    target: {
      sessionId: "existing",
      generation: "current",
      settings: { nativeChannelId: "123456789012345678" },
    },
    assertCurrent() {},
  });
  // Session-event turns run through the same same-conversation authority
  // projection as inbound messages; it compares the host-captured native
  // conversation id exactly, so steering keeps matching the conversation.
  expect(ctx.ChatId).toBe("123456789012345678");
});

it("does not substitute the prefixed route address for the chat id", () => {
  const ctx = buildSessionEventContext({
    cfg: {},
    agentId: "main",
    sessionKey: "agent:main:cron:proof-job",
    text: "background completion turn",
    options: { source: "restart" },
    occurrenceId: "chatid-occurrence-no-native",
    deliveryContext: {
      channel: "discord",
      to: "channel:123456789012345678",
      accountId: "acct-1",
    },
    target: { sessionId: "existing", generation: "current" },
    assertCurrent() {},
  });
  expect(ctx.ChatId).toBeUndefined();
  expect(ctx.OriginatingTo).toBe("channel:123456789012345678");
});

it("keeps restart recovery intact for the agent and out of chat display", () => {
  const text =
    "The Gateway restarted while you were working. Resume your work: inspect saved child work before repeating effects. Workspace and publication ownership do not transfer.";
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
});

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

it("captures the native conversation id from a real-shaped session entry", async () => {
  const { resolveSessionEventDestinationSettings } = await import("./session-event-target.js");
  const entry = {
    permissionMode: undefined,
    toolOverrides: undefined,
    delivery: {
      kind: "external" as const,
      origin: {
        provider: "discord",
        nativeChannelId: "123456789012345678",
      },
    },
  } as never;
  const settings = resolveSessionEventDestinationSettings(entry);
  expect(settings?.nativeChannelId).toBe("123456789012345678");
  const ctx = buildSessionEventContext({
    cfg: {},
    agentId: "main",
    sessionKey: "agent:main:cron:proof-job",
    text: "background completion turn",
    options: { source: "restart" },
    occurrenceId: "chatid-capture-occurrence",
    deliveryContext: { channel: "discord", to: "channel:123456789012345678" },
    target: {
      sessionId: "existing",
      generation: "current",
      settings: { nativeChannelId: settings?.nativeChannelId },
    },
    assertCurrent() {},
  });
  expect(ctx.ChatId).toBe("123456789012345678");
});
