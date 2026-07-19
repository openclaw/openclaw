import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createFollowupRun,
  createMockReplyOperation,
  createMinimalRunAgentTurnParams,
  GENERIC_RUN_FAILURE_TEXT,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

// Pre-flight commit of a pending user-initiated `/model` switch. The reported
// bug: Opus -> `/model openai/gpt-5.6-sol` -> first request crashed with a
// generic "Something went wrong" because the switch was injected mid-attempt
// and the target (a different provider) was absent from the pre-switch
// candidate chain. Committing the switch before the first attempt builds the
// chain around the target instead.
const state = setupAgentRunnerExecutionTestState();

const SOL = { provider: "openai", model: "gpt-5.6-sol", agentRuntimeOverride: "codex" } as const;

function runParams(replyOperation?: ReturnType<typeof createMockReplyOperation>["replyOperation"]) {
  const followupRun = createFollowupRun();
  const params = {
    ...createMinimalRunAgentTurnParams({
      followupRun,
      sessionCtx: { Provider: "webchat", MessageSid: "msg" } as unknown as TemplateContext,
    }),
    replyOperation,
    sessionKey: "agent:main:main",
  };
  return { followupRun, params };
}

describe("runAgentTurnWithFallback: live /model switch pre-flight", () => {
  it("Opus -> /model openai/gpt-5.6-sol -> first request commits the target", async () => {
    state.shouldSwitchToLiveModelMock.mockReturnValue(SOL);
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const { followupRun, params } = runParams();

    await runAgentTurnWithFallback(params);

    // Run mutated to the target provider/model (drives the first attempt).
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.6-sol");
    // Candidate chain was built AROUND THE TARGET, not the pre-switch model.
    expect(state.resolveModelCandidateChainMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model: "gpt-5.6-sol" }),
    );
    // Flag cleared exactly once, only after resolution + chain build + apply.
    expect(state.clearLiveModelSwitchPendingMock).toHaveBeenCalledTimes(1);
    // The mid-attempt live-switch throw path is never entered here — the model
    // fallback runner ran normally.
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
  });

  it("same-provider switch (anthropic sonnet) rebuilds around the new model", async () => {
    state.shouldSwitchToLiveModelMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const { followupRun, params } = runParams();

    await runAgentTurnWithFallback(params);

    expect(followupRun.run.model).toBe("claude-sonnet-5");
    expect(state.resolveModelCandidateChainMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-5" }),
    );
    expect(state.clearLiveModelSwitchPendingMock).toHaveBeenCalledTimes(1);
  });

  it("no pending switch -> run loop untouched (regression guard)", async () => {
    // Default mock returns undefined (no pending switch).
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const { followupRun, params } = runParams();

    await runAgentTurnWithFallback(params);

    expect(followupRun.run.provider).toBe("anthropic");
    expect(followupRun.run.model).toBe("claude");
    expect(state.resolveModelCandidateChainMock).not.toHaveBeenCalled();
    expect(state.clearLiveModelSwitchPendingMock).not.toHaveBeenCalled();
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
  });

  it("two sequential /model -> commits the latest persisted target once", async () => {
    // shouldSwitchToLiveModel reflects the latest persisted override.
    state.shouldSwitchToLiveModelMock.mockReturnValue(SOL);
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const { followupRun, params } = runParams();

    await runAgentTurnWithFallback(params);

    expect(followupRun.run.model).toBe("gpt-5.6-sol");
    expect(state.clearLiveModelSwitchPendingMock).toHaveBeenCalledTimes(1);
  });

  it("unresolvable target (chain build throws) -> flag kept, precise error", async () => {
    state.shouldSwitchToLiveModelMock.mockReturnValue(SOL);
    state.resolveModelCandidateChainMock.mockImplementation(() => {
      throw new Error("secure store unavailable");
    });
    const { replyOperation, failMock } = createMockReplyOperation();
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const { params } = runParams(replyOperation);

    const result = await runAgentTurnWithFallback(params);

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Could not switch to openai/gpt-5.6-sol");
      expect(result.payload.text).not.toContain("Something went wrong");
    }
    // Flag NOT cleared -> the switch is retried next turn.
    expect(state.clearLiveModelSwitchPendingMock).not.toHaveBeenCalled();
    // No inference attempt happened.
    expect(state.runWithModelFallbackMock).not.toHaveBeenCalled();
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.anything());
  });

  it("unresolvable target (empty chain) -> flag kept, precise error", async () => {
    state.shouldSwitchToLiveModelMock.mockReturnValue(SOL);
    state.resolveModelCandidateChainMock.mockReturnValue([]);
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const { params } = runParams();

    const result = await runAgentTurnWithFallback(params);

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Could not switch to openai/gpt-5.6-sol");
      expect(result.payload.text).not.toContain("Something went wrong");
    }
    expect(state.clearLiveModelSwitchPendingMock).not.toHaveBeenCalled();
    expect(state.runWithModelFallbackMock).not.toHaveBeenCalled();
  });

  it("probe failure is fail-safe -> normal turn, no pre-flight side effects", async () => {
    // A session-store/lock error while probing the flag must not fail the turn.
    state.shouldSwitchToLiveModelMock.mockImplementation(() => {
      throw new Error("SQLite session store path belongs to agent agent; requested agent main.");
    });
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const { followupRun, params } = runParams();

    await runAgentTurnWithFallback(params);

    // Degrades to prior (no pre-flight) behavior: run untouched, no clear.
    expect(followupRun.run.provider).toBe("anthropic");
    expect(state.clearLiveModelSwitchPendingMock).not.toHaveBeenCalled();
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
  });

  // Before/after reproduction of the reported bug at the real execution loop.
  // `runWithModelFallback` is stubbed to encode the REAL cross-provider contract:
  //   - invoked on the OLD provider (target NOT applied) -> exhaustion -> the
  //     turn surfaces GENERIC_RUN_FAILURE_TEXT ("Something went wrong");
  //   - invoked on the TARGET (openai/gpt-5.6-sol) -> the target answers.
  // With the pre-flight the run is switched to the target before the first
  // attempt, so the target answers. Reverting the pre-flight (checkout
  // execution.ts from main) leaves the run on the old provider and this test
  // reproduces the generic failure.
  it("repro: pending openai/gpt-5.6-sol switch answers on the target, not a generic failure", async () => {
    state.shouldSwitchToLiveModelMock.mockReturnValue(SOL);
    state.runEmbeddedAgentMock.mockImplementation(async (p: { provider?: string }) =>
      p.provider === "openai"
        ? { payloads: [{ text: "switched: hello from gpt-5.6-sol" }], meta: {} }
        : {
            payloads: [],
            meta: { error: { kind: "exhausted", message: "terminal before reply" } },
          },
    );
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const provider = (params as { provider?: string }).provider;
      const model = (params as { model?: string }).model;
      if (provider === "openai") {
        return {
          outcome: "completed",
          result: await params.run("openai", "gpt-5.6-sol"),
          provider: "openai",
          model: "gpt-5.6-sol",
          attempts: [],
        };
      }
      // Old provider still active: emulate the stale-chain demotion + exhaustion
      // that the real runner produces for an out-of-chain cross-provider switch.
      return {
        outcome: "exhausted",
        result: await params.run(provider ?? "anthropic", model ?? "claude"),
        provider: provider ?? "anthropic",
        model: model ?? "claude",
        attempts: [{ error: "live switch to openai/gpt-5.6-sol demoted; chain exhausted" }],
      };
    });
    const { replyOperation } = createMockReplyOperation();
    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const { followupRun, params } = runParams(replyOperation);

    const result = await runAgentTurnWithFallback(params);

    // Fixed behavior: switched to the target and it answered.
    expect(followupRun.run.provider).toBe("openai");
    expect(followupRun.run.model).toBe("gpt-5.6-sol");
    const text = JSON.stringify(result);
    expect(text).toContain("gpt-5.6-sol");
    expect(text).not.toContain(GENERIC_RUN_FAILURE_TEXT);
  });

  // NOTE: the "switch requested during an active turn" (deferred, mid-tool-call)
  // path throws LiveSessionModelSwitchError from inside the fallback runner and
  // is exercised by src/agents/model-fallback.test.ts (#58496 family) and
  // src/agents/embedded-agent-runner attempt-recovery tests. The pre-flight here
  // deliberately does not change that path.
});
