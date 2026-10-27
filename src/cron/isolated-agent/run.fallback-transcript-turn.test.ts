import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { createEmbeddedRunSessionPromptState } from "../../agents/embedded-agent-runner/run/session-prompt-state.js";
import { FailoverError } from "../../agents/failover-error.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const run = await loadRunCronIsolatedAgentTurn();
const PRIMARY = "openai/gpt-5.4";
const FALLBACK = "anthropic/claude-sonnet-4-6";

setupRunCronIsolatedAgentTurnSuite({ fast: true });
it.each([true, false])(
  "preserves the cron turn on timeout fallback (dispatched: %s)",
  async (dispatched) => {
    const actual = await vi.importActual<typeof import("../../agents/model-fallback-runner.js")>(
      "../../agents/model-fallback-runner.js",
    );
    runWithModelFallbackMock.mockImplementation(actual.runWithModelFallback);
    const userKeys: string[] = [];
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      const recorder = expectDefined(params.userTurnTranscriptRecorder, "candidate recorder");
      const message = expectDefined(await recorder.resolveMessage(), "scheduled user input");
      userKeys.push(expectDefined(message.idempotencyKey, "scheduled user key"));
      if (`${params.provider}/${params.model}` === PRIMARY) {
        recorder.markRuntimePersisted?.(message);
        if (dispatched) {
          recorder.markSentToProvider?.();
        }
        throw new FailoverError("LLM request timed out.", {
          reason: "timeout",
          provider: params.provider ?? "openai",
          model: params.model ?? "gpt-5.4",
        });
      }
      const sessionKey = expectDefined(params.sessionKey, "fallback session key");
      await using promptState = await createEmbeddedRunSessionPromptState({
        runParams: { ...params, sessionFile: params.sessionFile ?? sessionKey },
        sessionAgentId: params.agentId ?? "main",
        resolvedSessionKey: sessionKey,
        lifecycleGeneration: "cron-fallback-turn",
        onInterrupt: () => {},
      });
      expect(promptState.activePrompt).toMatchObject({
        internal: false,
        persisted: true,
        override: undefined,
      });
      expect(promptState.suppressNextUserMessagePersistence).toBe(true);
      return { payloads: [{ text: "fallback report" }], meta: { agentMeta: {} } };
    });
    const job = makeIsolatedAgentJobFixture({
      payload: { kind: "agentTurn", message: "Report.", fallbacks: [FALLBACK] },
    });
    expect((await run(makeIsolatedAgentParamsFixture({ job }))).status).toBe("ok");
    const calls = runEmbeddedAgentMock.mock.calls.map(([params]) => params);
    expect(calls.map((call) => `${call.provider}/${call.model}`)).toEqual([PRIMARY, FALLBACK]);
    const [primary, fallback] = calls;
    expect(fallback?.userTurnTranscriptRecorder).toBe(primary?.userTurnTranscriptRecorder);
    expect(fallback?.sessionId).toBe(primary?.sessionId);
    expect(fallback?.runId).toBe(primary?.runId);
    expect(userKeys).toEqual([userKeys[0], userKeys[0]]);
    const requestedModel = { requestedProvider: "openai", requestedModel: "gpt-5.4" };
    expect(calls.map((call) => call.modelRoutingProvenance)).toMatchObject([
      { ...requestedModel, stage: "initial" },
      { ...requestedModel, stage: "fallback", fallbackReason: "timeout" },
    ]);
  },
);
