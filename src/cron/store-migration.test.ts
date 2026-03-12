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

  it("does not flag canonical payload kinds as needing normalization", () => {
    const jobs = [
      {
        id: "canonical-agent",
        name: "agent job",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "ping" },
        sessionTarget: "isolated",
        enabled: true,
        wakeMode: "now",
        state: {},
      },
      {
        id: "canonical-system",
        name: "system job",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "systemEvent", text: "heartbeat" },
        sessionTarget: "main",
        enabled: true,
        wakeMode: "now",
        state: {},
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    // legacyPayloadKind must not be incremented for already-canonical kinds.
    expect(result.issues.legacyPayloadKind ?? 0).toBe(0);
    // Payload kinds must remain unchanged.
    expect((jobs[0]?.payload as Record<string, unknown>)?.kind).toBe("agentTurn");
    expect((jobs[1]?.payload as Record<string, unknown>)?.kind).toBe("systemEvent");
  });

  it("normalizes non-canonical payload kind casing to the canonical form", () => {
    const jobs = [
      {
        id: "uppercase-kind",
        name: "uppercase job",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "AGENTTURN", message: "ping" },
        sessionTarget: "isolated",
        enabled: true,
        wakeMode: "now",
        state: {},
      },
      {
        id: "mixed-kind",
        name: "mixed job",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "SystemEvent", text: "heartbeat" },
        sessionTarget: "main",
        enabled: true,
        wakeMode: "now",
        state: {},
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadKind).toBe(2);
    expect((jobs[0]?.payload as Record<string, unknown>)?.kind).toBe("agentTurn");
    expect((jobs[1]?.payload as Record<string, unknown>)?.kind).toBe("systemEvent");
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
