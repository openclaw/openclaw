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

  it("does not report legacyPayloadKind issue when payload kind is already correctly cased", () => {
    const jobs = [
      {
        id: "correctly-cased-job",
        name: "Test Job",
        schedule: { kind: "cron", expr: "0 * * * *" },
        payload: {
          kind: "agentTurn",
          message: "already correct",
        },
      },
      {
        id: "correctly-cased-system-event",
        name: "System Event Job",
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
    const payload0 = jobs[0]?.payload as Record<string, unknown> | undefined;
    const payload1 = jobs[1]?.payload as Record<string, unknown> | undefined;
    expect(payload0).toMatchObject({
      kind: "agentTurn",
      message: "already correct",
    });
    expect(payload1).toMatchObject({
      kind: "systemEvent",
      text: "system message",
    });
  });

  it("normalizes incorrectly cased payload kind", () => {
    const jobs = [
      {
        id: "lowercase-agentturn",
        name: "Uppercase AgentTurn",
        schedule: { kind: "cron", expr: "0 * * * *" },
        payload: {
          kind: "AGENTTURN",
          message: "uppercase",
        },
      },
      {
        id: "mixed-case-systemevent",
        name: "Mixed Case SystemEvent",
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
    const payload0 = jobs[0]?.payload as Record<string, unknown> | undefined;
    const payload1 = jobs[1]?.payload as Record<string, unknown> | undefined;
    expect(payload0).toMatchObject({
      kind: "agentTurn",
      message: "uppercase",
    });
    expect(payload1).toMatchObject({
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

  it("does not report legacyPayloadKind for already-normalized payload kinds", () => {
    const jobs = [
      {
        id: "normalized-agent-turn",
        name: "normalized",
        enabled: true,
        wakeMode: "now",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: "agentTurn", message: "ping" },
        sessionTarget: "isolated",
        delivery: { mode: "announce" },
        state: {},
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(false);
    expect(result.issues.legacyPayloadKind).toBeUndefined();
  });

  it("normalizes whitespace-padded and non-canonical payload kinds", () => {
    const jobs = [
      {
        id: "spaced-agent-turn",
        name: "normalized",
        enabled: true,
        wakeMode: "now",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: " agentTurn ", message: "ping" },
        sessionTarget: "isolated",
        delivery: { mode: "announce" },
        state: {},
      },
      {
        id: "upper-system-event",
        name: "normalized",
        enabled: true,
        wakeMode: "now",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: "SYSTEMEVENT", text: "pong" },
        sessionTarget: "main",
        delivery: { mode: "announce" },
        state: {},
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadKind).toBe(2);
    expect(jobs[0]?.payload).toMatchObject({ kind: "agentTurn", message: "ping" });
    expect(jobs[1]?.payload).toMatchObject({ kind: "systemEvent", text: "pong" });
  });
});
