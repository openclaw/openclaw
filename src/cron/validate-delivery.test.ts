import { describe, expect, it } from "vitest";
import type { CronJob } from "./types.js";
import { validateCronDelivery } from "./validate-delivery.js";

function makeJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "test",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
    ...overrides,
  };
}

describe("validateCronDelivery", () => {
  it("allows no delivery config", () => {
    const result = validateCronDelivery(makeJob({ delivery: undefined }));
    expect(result).toBeUndefined();
  });

  it("allows delivery.mode=none without target", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: { mode: "none" },
      }),
    );
    expect(result).toBeUndefined();
  });

  it("allows delivery.mode=webhook with URL", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: { mode: "webhook", to: "https://example.com/webhook" },
      }),
    );
    expect(result).toBeUndefined();
  });

  it("rejects delivery.mode=webhook without URL", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: { mode: "webhook" },
      }),
    );
    expect(result).toBeDefined();
    expect(result?.code).toBe("webhook_without_url");
  });

  it("rejects delivery.mode=webhook with empty URL", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: { mode: "webhook", to: "   " },
      }),
    );
    expect(result).toBeDefined();
    expect(result?.code).toBe("webhook_without_url");
  });

  it("allows delivery.mode=announce with channel", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      }),
    );
    expect(result).toBeUndefined();
  });

  it("allows delivery.mode=announce with delivery.to", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: { mode: "announce", to: "user:123" },
      }),
    );
    expect(result).toBeUndefined();
  });

  it("rejects delivery.mode=announce without any target", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: { mode: "announce" },
      }),
    );
    expect(result).toBeDefined();
    expect(result?.code).toBe("announce_without_target");
  });

  it("allows default announce mode with payload channel", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: {},
        payload: { kind: "agentTurn", message: "hello", channel: "telegram" },
      }),
    );
    expect(result).toBeUndefined();
  });

  it("allows default announce mode with delivery channel", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: { channel: "telegram", to: "123" },
      }),
    );
    expect(result).toBeUndefined();
  });

  it("rejects default announce mode without any target", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: {},
        payload: { kind: "agentTurn", message: "hello" },
      }),
    );
    expect(result).toBeDefined();
    expect(result?.code).toBe("announce_without_target");
  });

  it("rejects conflicting delivery.to vs payload.to", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: { mode: "announce", to: "telegram:123" },
        payload: { kind: "agentTurn", message: "hello", to: "signal:456" },
      }),
    );
    expect(result).toBeDefined();
    expect(result?.code).toBe("conflicting_targets");
    expect(result?.message).toContain("delivery.channel/to");
    expect(result?.message).toContain("payload.channel/to");
  });

  it("allows matching delivery and payload targets", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: { to: "telegram:123" },
        payload: { kind: "agentTurn", message: "hello", to: "telegram:123" },
      }),
    );
    expect(result).toBeUndefined();
  });

  it("rejects conflicting channels", () => {
    const result = validateCronDelivery(
      makeJob({
        delivery: { channel: "telegram" },
        payload: { kind: "agentTurn", message: "hello", channel: "signal" },
      }),
    );
    expect(result).toBeDefined();
    expect(result?.code).toBe("conflicting_targets");
  });
});
