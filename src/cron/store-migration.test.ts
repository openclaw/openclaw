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

  it("does not flag canonical payload kinds as legacy normalization issues", () => {
    const jobs = [
      {
        id: "canonical-agent-turn",
        name: "Canonical agent turn",
        enabled: true,
        wakeMode: "now",
        sessionTarget: "isolated",
        schedule: {
          kind: "every",
          everyMs: 60_000,
          anchorMs: Date.parse("2026-03-13T00:00:00.000Z"),
        },
        payload: {
          kind: "agentTurn",
          message: "ping",
        },
        delivery: {
          mode: "announce",
        },
        state: {},
      },
      {
        id: "canonical-system-event",
        name: "Canonical system event",
        enabled: true,
        wakeMode: "now",
        sessionTarget: "main",
        schedule: {
          kind: "every",
          everyMs: 60_000,
          anchorMs: Date.parse("2026-03-13T00:00:00.000Z"),
        },
        payload: {
          kind: "systemEvent",
          text: "tick",
        },
        state: {},
      },
    ] as Array<Record<string, unknown>>;
    const before = structuredClone(jobs);

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(false);
    expect(result.issues.legacyPayloadKind).toBeUndefined();
    expect(jobs).toEqual(before);
  });
});
