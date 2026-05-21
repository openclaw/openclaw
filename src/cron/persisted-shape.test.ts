import { describe, expect, it } from "vitest";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";

describe("getInvalidPersistedCronJobReason", () => {
  const validSchedule = { kind: "cron", expr: "0 9 * * *" };

  it("accepts systemEvent with text", () => {
    expect(
      getInvalidPersistedCronJobReason({
        id: "job-1",
        schedule: validSchedule,
        payload: { kind: "systemEvent", text: "hello" },
      }),
    ).toBeNull();
  });

  it("accepts agentTurn with message", () => {
    expect(
      getInvalidPersistedCronJobReason({
        id: "job-2",
        schedule: validSchedule,
        payload: { kind: "agentTurn", message: "run task" },
      }),
    ).toBeNull();
  });

  it("rejects systemEvent missing text", () => {
    expect(
      getInvalidPersistedCronJobReason({
        id: "job-3",
        schedule: validSchedule,
        payload: { kind: "systemEvent" },
      }),
    ).toBe("invalid-payload");
  });

  it("rejects agentTurn with empty message", () => {
    expect(
      getInvalidPersistedCronJobReason({
        id: "job-4",
        schedule: validSchedule,
        payload: { kind: "agentTurn", message: "   " },
      }),
    ).toBe("invalid-payload");
  });

  it("accepts legacy payload.kind 'command'", () => {
    expect(
      getInvalidPersistedCronJobReason({
        id: "legacy-command",
        schedule: validSchedule,
        payload: { kind: "command", text: "/usr/bin/run.sh" },
      }),
    ).toBeNull();
  });

  it("accepts legacy payload.kind 'agentmessage'", () => {
    expect(
      getInvalidPersistedCronJobReason({
        id: "legacy-agentmessage",
        schedule: validSchedule,
        payload: { kind: "agentmessage", message: "Daily standup" },
      }),
    ).toBeNull();
  });

  it("accepts arbitrary non-empty string payload.kind", () => {
    expect(
      getInvalidPersistedCronJobReason({
        id: "custom-kind",
        schedule: validSchedule,
        payload: { kind: "customWebhook", url: "https://example.com" },
      }),
    ).toBeNull();
  });

  it("rejects missing payload.kind", () => {
    expect(
      getInvalidPersistedCronJobReason({
        id: "job-5",
        schedule: validSchedule,
        payload: {},
      }),
    ).toBe("invalid-payload");
  });

  it("rejects empty string payload.kind", () => {
    expect(
      getInvalidPersistedCronJobReason({
        id: "job-6",
        schedule: validSchedule,
        payload: { kind: "" },
      }),
    ).toBe("invalid-payload");
  });

  it("rejects numeric payload.kind", () => {
    expect(
      getInvalidPersistedCronJobReason({
        id: "job-7",
        schedule: validSchedule,
        payload: { kind: 123 },
      }),
    ).toBe("invalid-payload");
  });
});
