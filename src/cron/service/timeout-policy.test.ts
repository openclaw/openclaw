import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import {
  AGENT_TURN_SAFETY_TIMEOUT_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  resolveCronJobTimeoutMs,
} from "./timeout-policy.js";

function makeJob(payload: CronJob["payload"]): CronJob {
  const sessionTarget = payload.kind === "systemEvent" ? "main" : "isolated";
  return {
    id: "job-1",
    name: "job",
    createdAtMs: 0,
    updatedAtMs: 0,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget,
    wakeMode: "next-heartbeat",
    payload,
    state: {},
  };
}

describe("timeout-policy", () => {
  it("uses default timeout for non-agent jobs", () => {
    const timeout = resolveCronJobTimeoutMs(makeJob({ kind: "systemEvent", text: "hello" }));
    expect(timeout).toBe(DEFAULT_JOB_TIMEOUT_MS);
  });

  it("uses expanded safety timeout for agentTurn jobs without explicit timeout", () => {
    const timeout = resolveCronJobTimeoutMs(makeJob({ kind: "agentTurn", message: "hi" }));
    expect(timeout).toBe(AGENT_TURN_SAFETY_TIMEOUT_MS);
  });

  it("disables timeout when timeoutSeconds <= 0", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "agentTurn", message: "hi", timeoutSeconds: 0 }),
    );
    expect(timeout).toBeUndefined();
  });

  it("applies explicit timeoutSeconds when positive", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "agentTurn", message: "hi", timeoutSeconds: 1.9 }),
    );
    expect(timeout).toBe(1_900);
  });

  it("uses default timeout for script jobs without explicit timeout", () => {
    const timeout = resolveCronJobTimeoutMs(makeJob({ kind: "script", command: "echo hi" }));
    expect(timeout).toBe(DEFAULT_JOB_TIMEOUT_MS);
  });

  it("applies explicit timeoutSeconds for script jobs", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "script", command: "echo hi", timeoutSeconds: 5 }),
    );
    expect(timeout).toBe(5_000);
  });

  it("floors fractional timeoutSeconds for script jobs", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "script", command: "echo hi", timeoutSeconds: 1.9 }),
    );
    expect(timeout).toBe(1_900);
  });

  it("disables timeout for script jobs when timeoutSeconds is zero", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "script", command: "echo hi", timeoutSeconds: 0 }),
    );
    expect(timeout).toBeUndefined();
  });

  it("disables timeout for script jobs when timeoutSeconds is negative", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "script", command: "echo hi", timeoutSeconds: -1 }),
    );
    expect(timeout).toBeUndefined();
  });

  it("falls back to default timeout when timeoutSeconds is NaN", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "script", command: "echo hi", timeoutSeconds: NaN }),
    );
    expect(timeout).toBe(DEFAULT_JOB_TIMEOUT_MS);
  });
});
