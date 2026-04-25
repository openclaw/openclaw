import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeIsolatedAgentTurnJob, makeIsolatedAgentTurnParams } from "./run.suite-helpers.js";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  resolveAgentConfigMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
  updateSessionStoreMock,
} from "./run.test-harness.js";

// Lock in the cron-side gating from cb16d22780 ("fix(cron): retire bundled mcp
// runtimes"): the cron isolated-agent run-executor must pass
// cleanupBundleMcpOnRunEnd=true to runEmbeddedPiAgent for ephemeral isolated
// jobs, and false for jobs bound to a persistent custom session. Without this
// gate, isolated cron fires either accumulate bundled-MCP subprocesses (when
// false) or kill long-lived persistent-session MCP state on every run (when
// true). The dispose call itself is covered at the runEmbeddedPiAgent level
// in pi-embedded-runner.e2e.test.ts; this asserts the upstream decision.
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeSuccessfulRunResult(provider = "openai", model = "gpt-5.4") {
  return {
    result: {
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          model,
          provider,
          usage: { input: 10, output: 5 },
        },
      },
    },
    provider,
    model,
    attempts: [],
  };
}

describe("runCronIsolatedAgentTurn — cleanupBundleMcpOnRunEnd gating", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openai",
      model: "gpt-5.4",
    });
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "openai", model: "gpt-5.4" },
    });
    resolveAgentConfigMock.mockReturnValue(undefined);
    updateSessionStoreMock.mockResolvedValue(undefined);
    resolveCronSessionMock.mockReturnValue(makeCronSession());

    // Passthrough so the embedded runner mock actually receives the call.
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
    runEmbeddedPiAgentMock.mockResolvedValue(makeSuccessfulRunResult().result);
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("requests bundled-MCP cleanup for an isolated cron run", async () => {
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ sessionTarget: "isolated" }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as
      | { cleanupBundleMcpOnRunEnd?: boolean; trigger?: string }
      | undefined;
    expect(call?.trigger).toBe("cron");
    expect(call?.cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it("does NOT request bundled-MCP cleanup when bound to a persistent custom session", async () => {
    // session:* targets bind the cron run to a long-lived session whose MCP
    // runtime is shared across runs; tearing it down here would force every
    // fire to repay subprocess startup cost and lose warm tool state.
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({ sessionTarget: "session:agent:main:main" }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as
      | { cleanupBundleMcpOnRunEnd?: boolean }
      | undefined;
    expect(call?.cleanupBundleMcpOnRunEnd).toBe(false);
  });
});
