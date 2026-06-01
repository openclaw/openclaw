import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { applyJobPatch } from "./jobs.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "test",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hello" },
    delivery: { mode: "announce", channel: "telegram", to: "-1001234567890" },
    state: {},
    ...overrides,
  };
}

describe("applyJobPatch delivery merge", () => {
  it("threads explicit delivery threadId patches into delivery", () => {
    const job = makeJob();
    const patch = { delivery: { threadId: "99" } } as Parameters<typeof applyJobPatch>[1];

    applyJobPatch(job, patch);

    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      threadId: "99",
    });
  });

  it("clears nullable delivery fields", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890",
        threadId: "99",
        accountId: "bot-a",
        failureDestination: {
          mode: "announce",
          channel: "slack",
          to: "C123",
          accountId: "bot-b",
        },
      },
    });
    const patch = {
      delivery: {
        channel: null,
        to: null,
        threadId: null,
        accountId: null,
        failureDestination: null,
      },
    } as Parameters<typeof applyJobPatch>[1];

    applyJobPatch(job, patch);

    expect(job.delivery).toEqual({ mode: "announce" });
  });

  it("clears nullable failure destination fields", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890",
        failureDestination: {
          mode: "announce",
          channel: "slack",
          to: "C123",
          accountId: "bot-b",
        },
      },
    });
    const patch = {
      delivery: {
        failureDestination: {
          channel: null,
          to: null,
          accountId: null,
          mode: null,
        },
      },
    } as Parameters<typeof applyJobPatch>[1];

    applyJobPatch(job, patch);

    expect(job.delivery?.failureDestination).toBeUndefined();
  });
});
