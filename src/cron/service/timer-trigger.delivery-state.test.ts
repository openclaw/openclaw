// Delivery-state projection for jobs the runner does not deliver for.
import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { resolveDeliveryState } from "./timer-trigger.js";

function makeJob(delivery: CronJob["delivery"]): CronJob {
  return {
    id: "job-1",
    name: "job-1",
    enabled: true,
    schedule: { kind: "cron", expression: "0 * * * *" },
    payload: { kind: "agentTurn", message: "run" },
    sessionTarget: "isolated",
    createdAtMs: 0,
    updatedAtMs: 0,
    state: {},
    ...(delivery ? { delivery } : {}),
  } as unknown as CronJob;
}

describe("resolveDeliveryState for delivery.mode none", () => {
  const none = makeJob({ mode: "none", channel: "messagechat", to: "test-target" });

  // For `none`, `delivered` is the verified message-tool delivery (delivery-dispatch.ts
  // sets `delivered = verifiedMessageToolDelivery`), so a true value is proof the agent's
  // own send reached the intended target.
  it("reports a verified agent send as delivered", () => {
    expect(resolveDeliveryState({ job: none, runStatus: "ok", delivered: true })).toMatchObject({
      delivered: true,
      status: "delivered",
    });
  });

  // A job that never sent genuinely did not request delivery. This must keep reading as
  // "not-requested" so ordinary tool-only cron jobs are not reported as failed.
  it("still reports not-requested when nothing was delivered", () => {
    expect(resolveDeliveryState({ job: none, runStatus: "ok", delivered: false })).toMatchObject({
      status: "not-requested",
    });
  });

  it("leaves announce jobs to the requested-delivery path", () => {
    const announce = makeJob({ mode: "announce", channel: "messagechat", to: "test-target" });
    expect(resolveDeliveryState({ job: announce, runStatus: "ok", delivered: true })).toMatchObject(
      { status: "delivered" },
    );
  });

  it("leaves webhook jobs on their own carve-out", () => {
    const webhook = makeJob({ mode: "webhook", to: "https://example.test/hook" });
    expect(
      resolveDeliveryState({
        job: webhook,
        runStatus: "ok",
        delivered: false,
        deliveryAttempted: true,
        error: "hook returned 500",
      }),
    ).toMatchObject({ delivered: false, status: "not-delivered", error: "hook returned 500" });
  });
});
