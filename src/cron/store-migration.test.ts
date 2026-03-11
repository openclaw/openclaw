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

  it("does not report already-canonical payload kinds as legacy kind migrations", () => {
    const jobs = [
      {
        id: "canonical-agent-turn",
        schedule: { kind: "every", everyMs: 60_000 },
        state: {},
        payload: {
          kind: "agentTurn",
          message: "ping",
        },
      },
      {
        id: "canonical-system-event",
        schedule: { kind: "every", everyMs: 60_000 },
        state: {},
        payload: {
          kind: "systemEvent",
          text: "ping",
        },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.issues.legacyPayloadKind).toBeUndefined();
    expect(jobs[0]?.payload).toMatchObject({
      kind: "agentTurn",
      message: "ping",
    });
    expect(jobs[1]?.payload).toMatchObject({
      kind: "systemEvent",
      text: "ping",
    });
  });

  it("migrates legacy lowercase payload kinds to canonical form", () => {
    const jobs = [
      {
        id: "legacy-lowercase-agent-turn",
        schedule: { kind: "every", everyMs: 60_000 },
        state: {},
        payload: {
          kind: "agentturn",
          message: "ping",
        },
      },
      {
        id: "legacy-lowercase-system-event",
        schedule: { kind: "every", everyMs: 60_000 },
        state: {},
        payload: {
          kind: "systemevent",
          text: "ping",
        },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.issues.legacyPayloadKind).toBe(2);
    expect((jobs[0]?.payload as Record<string, unknown> | undefined)?.kind).toBe("agentTurn");
    expect((jobs[1]?.payload as Record<string, unknown> | undefined)?.kind).toBe("systemEvent");
  });

  it("trims unknown payload kinds without lowercasing them", () => {
    const jobs = [
      {
        id: "trim-unknown-kind",
        name: "Trim unknown kind",
        schedule: { kind: "every", everyMs: 60_000 },
        state: {},
        enabled: true,
        wakeMode: "now",
        sessionTarget: "main",
        payload: {
          kind: " customEvent ",
          text: "ping",
        },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadKind).toBe(1);
    expect((jobs[0]?.payload as Record<string, unknown> | undefined)?.kind).toBe("customEvent");
  });
});
