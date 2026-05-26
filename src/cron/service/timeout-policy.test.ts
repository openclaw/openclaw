import { describe, expect, it } from "vitest";
import type { CronJob, CronSessionTarget, CronWakeMode } from "../types.js";
import {
  AGENT_TURN_SAFETY_TIMEOUT_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  resolveCronJobTimeoutMs,
} from "./timeout-policy.js";

type JobOverrides = {
  sessionTarget?: CronSessionTarget;
  wakeMode?: CronWakeMode;
};

function makeJob(payload: CronJob["payload"], overrides: JobOverrides = {}): CronJob {
  const sessionTarget = payload.kind === "agentTurn" ? "isolated" : "main";
  return {
    id: "job-1",
    name: "job",
    createdAtMs: 0,
    updatedAtMs: 0,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: overrides.sessionTarget ?? sessionTarget,
    wakeMode: overrides.wakeMode ?? "next-heartbeat",
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

  it("uses expanded safety timeout for main systemEvent wakeMode=now jobs", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "systemEvent", text: "hello" }, { wakeMode: "now", sessionTarget: "main" }),
    );
    expect(timeout).toBe(AGENT_TURN_SAFETY_TIMEOUT_MS);
  });

  it("keeps the default timeout for main systemEvent next-heartbeat jobs", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "systemEvent", text: "hello" }, { wakeMode: "next-heartbeat" }),
    );
    expect(timeout).toBe(DEFAULT_JOB_TIMEOUT_MS);
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
});
