// Interruption mapping must never downgrade settled or intentionally-unrequested delivery.
import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { resolveInterruptedRunProgress } from "./timer-job-runner.interruption.js";

type InterruptionParams = Parameters<typeof resolveInterruptedRunProgress>[0];
type Progress = InterruptionParams["progress"];
type Outcome = NonNullable<Progress["completedCoreResult"]>;

const webhookJob = {
  id: "job-1",
  name: "webhook job",
  enabled: true,
  schedule: { kind: "cron", expr: "* * * * *" },
  sessionTarget: "isolated",
  payload: { kind: "command", argv: ["sh", "-lc", "echo hi"] },
  delivery: { mode: "webhook", to: "https://example.invalid/hook" },
  state: {},
} as unknown as CronJob;

const outcome = (overrides: Partial<Outcome>): Outcome =>
  ({ status: "ok", summary: "payload", ...overrides }) as Outcome;

describe("resolveInterruptedRunProgress", () => {
  it("returns the settled delivery result untouched", () => {
    const settled = outcome({ delivered: true });
    const resolved = resolveInterruptedRunProgress({
      progress: { settledDeliveryResult: settled, completedCoreResult: outcome({}) },
      job: webhookJob,
      error: "cron webhook delivery cancelled: operator",
    });
    expect(resolved).toBe(settled);
  });

  it("keeps an unfired trigger's intentional non-delivery on interruption", () => {
    const unfired = outcome({ triggerEval: { fired: false } } as Partial<Outcome>);
    const resolved = resolveInterruptedRunProgress({
      progress: { completedCoreResult: unfired },
      job: webhookJob,
      error: "cron webhook delivery cancelled: operator",
    });
    expect(resolved).toBe(unfired);
    expect(resolved?.delivered).toBeUndefined();
    expect(resolved?.deliveryError).toBeUndefined();
  });

  it.each([
    { webhookDelivery: undefined, delivered: false, status: "not-delivered" },
    {
      webhookDelivery: { status: "unknown", error: "request timed out" },
      delivered: undefined,
      status: "unknown",
    },
    {
      webhookDelivery: { status: "not-delivered", error: "getaddrinfo ENOTFOUND" },
      delivered: false,
      status: "not-delivered",
    },
  ] as const)(
    "preserves interruption context with delivery $status",
    ({ webhookDelivery, delivered, status }) => {
      const resolved = resolveInterruptedRunProgress({
        progress: { completedCoreResult: outcome({}), webhookDelivery },
        job: webhookJob,
        error: "cron webhook delivery cancelled: operator",
      });
      expect(resolved).toMatchObject({
        status: "ok",
        summary: "payload",
        delivered,
        deliveryState: { status },
      });
      expect(resolved?.deliveryError).toContain("cron webhook delivery cancelled: operator");
      if (webhookDelivery?.error) {
        expect(resolved?.deliveryError).toContain(webhookDelivery.error);
      }
      expect(resolved?.error).toBeUndefined();
    },
  );

  it("returns undefined when no core result completed", () => {
    const resolved = resolveInterruptedRunProgress({
      progress: {},
      job: webhookJob,
      error: "cron webhook delivery cancelled: operator",
    });
    expect(resolved).toBeUndefined();
  });
});
