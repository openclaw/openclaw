// A cron primary timeout must reach the fallback without recapturing the user turn.
import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { createEmbeddedRunSessionPromptState } from "../../agents/embedded-agent-runner/run/session-prompt-state.js";
import { FailoverError } from "../../agents/failover-error.js";
import { getUserTurnTranscriptAdmissionOwner } from "../../sessions/user-turn-transcript-admission.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const PRIMARY = "openai/gpt-5.4";
const FALLBACK = "anthropic/claude-sonnet-4-6";

describe("runCronIsolatedAgentTurn fallback transcript turn", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("keeps one dispatched user turn when a primary timeout reaches the fallback model", async () => {
    runWithModelFallbackMock.mockImplementation(
      (
        await vi.importActual<typeof import("../../agents/model-fallback-runner.js")>(
          "../../agents/model-fallback-runner.js",
        )
      ).runWithModelFallback,
    );
    const calls: RunEmbeddedAgentParams[] = [];
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      calls.push(params);
      if (`${params.provider}/${params.model}` === PRIMARY) {
        params.userTurnTranscriptRecorder?.markSentToProvider?.();
        params.userTurnTranscriptRecorder?.markRuntimePersisted?.();
        throw new FailoverError("LLM request timed out.", {
          reason: "timeout",
          provider: params.provider ?? "openai",
          model: params.model ?? "gpt-5.4",
        });
      }
      return {
        payloads: [{ text: "fallback report" }],
        meta: { agentMeta: {} },
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          payload: {
            kind: "agentTurn",
            message: "Write the daily report.",
            fallbacks: [FALLBACK],
          },
        }),
      }),
    );

    expect(result).toMatchObject({ status: "ok" });
    expect(calls.map((call) => `${call.provider}/${call.model}`)).toEqual([PRIMARY, FALLBACK]);
    const [primary, fallback] = calls;
    const recorder = primary?.userTurnTranscriptRecorder;
    expect(recorder).toBeDefined();
    expect(fallback?.userTurnTranscriptRecorder).toBe(recorder);
    expect(primary?.modelRoutingProvenance).toMatchObject({
      requestedProvider: "openai",
      requestedModel: "gpt-5.4",
      stage: "initial",
    });
    expect(getUserTurnTranscriptAdmissionOwner(recorder)?.sentToProvider()).toBe(true);
    expect(fallback?.modelRoutingProvenance).toMatchObject({
      requestedProvider: "openai",
      requestedModel: "gpt-5.4",
      stage: "fallback",
      fallbackReason: "timeout",
    });
    if (!fallback?.sessionKey) {
      throw new Error("fallback invocation is missing its session");
    }

    await using promptState = await createEmbeddedRunSessionPromptState({
      runParams: {
        ...fallback,
        sessionFile: fallback.sessionFile ?? fallback.sessionKey,
      },
      sessionAgentId: fallback.agentId ?? "main",
      resolvedSessionKey: fallback.sessionKey,
      lifecycleGeneration: "cron-fallback-turn",
      onInterrupt: () => {},
    });
    expect(promptState.activePrompt).toMatchObject({ internal: true, persisted: true });
    expect(promptState.suppressNextUserMessagePersistence).toBe(true);
  });
});
