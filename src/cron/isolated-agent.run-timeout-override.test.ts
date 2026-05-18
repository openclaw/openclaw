// Isolated agent timeout tests cover per-run timeout override propagation.
import "./isolated-agent.mocks.js";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runCronTurn, withTempHome } from "./isolated-agent.turn-test-helpers.js";
import { resolveCronRunTimeoutOverrideMs } from "./isolated-agent/run-timeout.js";

describe("resolveCronRunTimeoutOverrideMs", () => {
  // Regression: when a cron job's payload `timeoutSeconds` numerically equals
  // the configured agent default, `timeoutMs !== defaultTimeoutMs` collapses to
  // `false` in the embedded runner. The cron entry point must carry a separate
  // explicit-timeout signal so the LLM idle watchdog does not fall back to its
  // implicit 120s cap.
  it("preserves explicit payload timeoutSeconds even when it equals the agent default", () => {
    expect(resolveCronRunTimeoutOverrideMs(300)).toBe(300_000);
  });

  it("preserves explicit payload timeoutSeconds when it differs from the agent default", () => {
    expect(resolveCronRunTimeoutOverrideMs(600)).toBe(600_000);
  });

  it("caps oversized explicit payload timeoutSeconds at the timer-safe ceiling", () => {
    expect(resolveCronRunTimeoutOverrideMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("omits the signal when the cron payload has no positive numeric timeout", () => {
    expect(resolveCronRunTimeoutOverrideMs(undefined)).toBeUndefined();
    expect(resolveCronRunTimeoutOverrideMs(0)).toBeUndefined();
    expect(resolveCronRunTimeoutOverrideMs(-1)).toBeUndefined();
    expect(resolveCronRunTimeoutOverrideMs(Number.NaN)).toBeUndefined();
    expect(resolveCronRunTimeoutOverrideMs("300")).toBeUndefined();
  });
});

function lastEmbeddedCall(): { runTimeoutOverrideMs?: number; timeoutMs?: number } {
  const calls = vi.mocked(runEmbeddedPiAgent).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)?.[0] as { runTimeoutOverrideMs?: number; timeoutMs?: number };
}

describe("runCronIsolatedAgentTurn — explicit per-run timeout signal", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockClear();
  });

  // Regression: when a cron job's payload `timeoutSeconds` numerically equals
  // the configured agent default, `timeoutMs !== defaultTimeoutMs` collapses to
  // `false` in this case, stripping the runTimeoutMs signal and letting the
  // LLM idle watchdog fall back to the implicit 120s cap.
  // Fix: forward `runTimeoutOverrideMs` from the cron entry point so the
  // explicit-vs-default distinction survives the merge into `timeoutMs`.
  it("forwards runTimeoutOverrideMs when payload.timeoutSeconds equals the agent default", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        cfgOverrides: { agents: { defaults: { timeoutSeconds: 300 } } },
        jobPayload: { kind: "agentTurn", message: "do it", timeoutSeconds: 300 },
      });

      const call = lastEmbeddedCall();
      expect(call.runTimeoutOverrideMs).toBe(300_000);
    });
  });

  it("forwards runTimeoutOverrideMs when payload.timeoutSeconds differs from the agent default", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        cfgOverrides: { agents: { defaults: { timeoutSeconds: 300 } } },
        jobPayload: { kind: "agentTurn", message: "do it", timeoutSeconds: 600 },
      });

      const call = lastEmbeddedCall();
      expect(call.runTimeoutOverrideMs).toBe(600_000);
    });
  });

  it("leaves runTimeoutOverrideMs undefined when payload omits timeoutSeconds", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        cfgOverrides: { agents: { defaults: { timeoutSeconds: 300 } } },
        jobPayload: { kind: "agentTurn", message: "do it" },
      });

      const call = lastEmbeddedCall();
      expect(call.runTimeoutOverrideMs).toBeUndefined();
    });
  });
});
