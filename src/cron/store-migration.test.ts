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

  it("does not report legacyPayloadKind when payload kind is already normalized (#44005)", () => {
    const jobs = [
      {
        id: "already-normalized",
        name: "test job",
        schedule: { kind: "every", everyMs: 60_000 },
        enabled: true,
        wakeMode: "now",
        state: {},
        sessionTarget: "isolated",
        delivery: { mode: "announce" },
        payload: { kind: "agentTurn", message: "hello" },
      },
      {
        id: "already-normalized-system",
        name: "test system job",
        schedule: { kind: "every", everyMs: 60_000 },
        enabled: true,
        wakeMode: "now",
        state: {},
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "ping" },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    // The key assertion: payload kind normalization should NOT be reported
    expect(result.issues.legacyPayloadKind).toBeUndefined();
  });

  it("normalizes lowercase payload kind variants", () => {
    const jobs = [
      {
        id: "needs-normalization",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentturn", message: "hello" },
      },
      {
        id: "needs-normalization-system",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "SYSTEMEVENT", text: "ping" },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadKind).toBe(2);
    expect((jobs[0]?.payload as Record<string, unknown>)?.kind).toBe("agentTurn");
    expect((jobs[1]?.payload as Record<string, unknown>)?.kind).toBe("systemEvent");
  });
});
