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

  it("does not report legacyPayloadKind issue for already normalized values", () => {
    // Regression test: already-normalized payload.kind values should not trigger
    // false positive "legacyPayloadKind" issues when doctor runs again after --fix
    const jobs = [
      {
        id: "already-normalized-agentTurn",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        payload: {
          kind: "agentTurn", // Already in canonical form
          message: "morning greeting",
        },
      },
      {
        id: "already-normalized-systemEvent",
        schedule: { kind: "cron", expr: "0 18 * * *" },
        payload: {
          kind: "systemEvent", // Already in canonical form
          text: "evening status",
        },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    // Should NOT report any legacyPayloadKind issues
    expect(result.issues.legacyPayloadKind).toBeUndefined();
    // Should NOT mutate anything for these jobs
    expect(result.mutated).toBe(false);
    // payload.kind should remain unchanged
    expect(jobs[0]?.payload?.kind).toBe("agentTurn");
    expect(jobs[1]?.payload?.kind).toBe("systemEvent");
  });

  it("normalizes whitespace-padded payload kind values", () => {
    // Regression test: handles edge case from Codex review
    // Values like " agentTurn " should be canonicalized, not skipped
    const jobs = [
      {
        id: "whitespace-agentTurn",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        payload: {
          kind: " agentTurn ", // Whitespace-padded canonical form
          message: "morning greeting",
        },
      },
      {
        id: "whitespace-systemEvent",
        schedule: { kind: "cron", expr: "0 18 * * *" },
        payload: {
          kind: "  systemEvent  ", // Whitespace-padded canonical form
          text: "evening status",
        },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    // Should report legacyPayloadKind issues for whitespace variants
    expect(result.issues.legacyPayloadKind).toBe(2);
    // Should mutate to canonical form
    expect(result.mutated).toBe(true);
    // payload.kind should be canonicalized (trimmed)
    expect(jobs[0]?.payload?.kind).toBe("agentTurn");
    expect(jobs[1]?.payload?.kind).toBe("systemEvent");
  });
});
