import { expect, it } from "vitest";
import { applyPersonalReminderDefaults } from "./cron-tool-personal-reminder.js";

const origin = {
  profileId: "alice",
  agentId: "main",
  sessionKey: "agent:main:telegram:group:group-1:topic:one",
  sessionId: "session",
  accountId: "default",
  to: "group-1",
  threadId: "one",
};

it("keeps the requested tool cap on a recurring caller-owned automation", () => {
  const job: Record<string, unknown> = {
    schedule: { kind: "every", everyMs: 60000 },
    payload: { kind: "agentTurn", message: "Read my workspace", toolsAllow: ["read"] },
  };
  applyPersonalReminderDefaults(job, { ...job }, origin);
  expect(job.payload).toMatchObject({ toolsAllow: ["read"] });
  expect(job).toMatchObject({
    agentId: "main",
    sessionKey: origin.sessionKey,
    sessionTarget: "current",
    delivery: { to: "group-1", threadId: "one" },
  });
  expect(job.deleteAfterRun).not.toBe(true);
});

it("keeps one-shot reminder cleanup and an explicitly isolated run", () => {
  const job: Record<string, unknown> = {
    schedule: { kind: "at", at: "2030-01-01T00:00:00Z" },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Check my task", toolsAllow: ["read"] },
    delivery: { mode: "none" },
  };
  applyPersonalReminderDefaults(job, { ...job }, origin);
  expect(job).toMatchObject({
    sessionTarget: "isolated",
    deleteAfterRun: true,
    delivery: { mode: "none" },
  });
});

it.each([
  { agentId: "another" },
  { sessionKey: "agent:main:other" },
  { payload: { kind: "command", argv: ["fixture"] } },
  { schedule: { kind: "on-exit", commandId: "foreign" } },
])("does not move a caller automation outside its admitted scope: %j", (outside) => {
  const job = {
    schedule: { kind: "every", everyMs: 60000 },
    payload: { kind: "agentTurn", message: "Check", toolsAllow: ["read"] },
    ...outside,
  };
  expect(() => applyPersonalReminderDefaults(job, { ...job }, origin)).toThrow();
});
