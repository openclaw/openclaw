import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { runCronTurn, withTempHome } from "./isolated-agent.turn-test-helpers.js";

function lastEmbeddedCall(): { runTimeoutOverrideMs?: number; timeoutMs?: number } {
  const calls = vi.mocked(runEmbeddedAgent).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)?.[0] as { runTimeoutOverrideMs?: number; timeoutMs?: number };
}

describe("runCronIsolatedAgentTurn — explicit per-run timeout signal", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedAgent).mockClear();
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
