import { describe, expect, it } from "vitest";
import { CronOperatorSourceError } from "../cron/operator-source-error.js";
import type { CronStoredJob } from "../cron/types.js";
import { restoreCronOperatorSource } from "./cron-operator-source.js";

function restore(signal?: AbortSignal) {
  return restoreCronOperatorSource({
    job: {
      id: "continuation",
      operatorSource: { source: { invalid: true }, executionRevision: "rev" },
    } as unknown as CronStoredJob,
    agentId: "main",
    sessionKey: "agent:main:dashboard:continuation",
    entry: { sessionId: "session", lifecycleRevision: "1" },
    signal,
    deliveryAttemptFence: null,
  });
}

describe("restoreCronOperatorSource", () => {
  it("classifies an unusable stored source as an operator source failure", async () => {
    await expect(restore()).rejects.toBeInstanceOf(CronOperatorSourceError);
  });

  it("keeps an aborted attempt retryable instead of retiring the source", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await restore(controller.signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CronOperatorSourceError);
  });
});
