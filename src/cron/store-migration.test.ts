import { describe, expect, it } from "vitest";
import { normalizeStoredCronJobs } from "./store-migration.js";

describe("normalizeStoredCronJobs", () => {
  it("normalizes legacy cron fields and reports migration issues", () => {
    const jobs = [
      {
        jobId: "legacy-job",
        schedule: { kind: "cron", cron: "*/5 * * * *", tz: "UTC" },
        message: "say hi",
        model: "openai/gpt-4.1",
        deliver: true,
        provider: " TeLeGrAm ",
        to: "12345",
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues).toMatchObject({
      jobId: 1,
      legacyScheduleCron: 1,
      legacyTopLevelPayloadFields: 1,
      legacyTopLevelDeliveryFields: 1,
    });

    const [job] = jobs;
    expect(job?.jobId).toBeUndefined();
    expect(job?.id).toBe("legacy-job");
    expect(job?.schedule).toMatchObject({
      kind: "cron",
      expr: "*/5 * * * *",
      tz: "UTC",
    });
    expect(job?.message).toBeUndefined();
    expect(job?.provider).toBeUndefined();
    expect(job?.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "12345",
    });
    expect(job?.payload).toMatchObject({
      kind: "agentTurn",
      message: "say hi",
      model: "openai/gpt-4.1",
    });
  });

  it("does not report mutation when payload kind is already correctly cased", () => {
    const jobs = [
      {
        id: "correctly-cased-job",
        schedule: { kind: "cron", expr: "0 * * * *" },
        payload: {
          kind: "agentTurn",
          message: "already correct",
        },
      },
      {
        id: "correctly-cased-system-event",
        schedule: { kind: "cron", expr: "0 * * * *" },
        payload: {
          kind: "systemEvent",
          text: "system message",
        },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    // Should not report legacyPayloadKind issue when kind is already correct
    expect(result.issues.legacyPayloadKind).toBeUndefined();
    expect(jobs[0]?.payload).toMatchObject({
      kind: "agentTurn",
      message: "already correct",
    });
    expect(jobs[1]?.payload).toMatchObject({
      kind: "systemEvent",
      text: "system message",
    });
  });

  it("normalizes incorrectly cased payload kind", () => {
    const jobs = [
      {
        id: "lowercase-agentturn",
        schedule: { kind: "cron", expr: "0 * * * *" },
        payload: {
          kind: "AGENTTURN",
          message: "uppercase",
        },
      },
      {
        id: "mixed-case-systemevent",
        schedule: { kind: "cron", expr: "0 * * * *" },
        payload: {
          kind: "SystemEvent",
          text: "mixed case",
        },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadKind).toBe(2);
    expect(jobs[0]?.payload).toMatchObject({
      kind: "agentTurn",
      message: "uppercase",
    });
    expect(jobs[1]?.payload).toMatchObject({
      kind: "systemEvent",
      text: "mixed case",
    });
  });

  it("normalizes payload provider alias into channel", () => {
    const jobs = [
      {
        id: "legacy-provider",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          provider: " Slack ",
        },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadProvider).toBe(1);
    expect(jobs[0]?.payload).toMatchObject({
      kind: "agentTurn",
      message: "ping",
    });
    const payload = jobs[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.provider).toBeUndefined();
    expect(jobs[0]?.delivery).toMatchObject({
      mode: "announce",
      channel: "slack",
    });
  });
});
