import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCodexSettledFinalizerTestFixture } from "../extensions/codex/test-api.js";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
} from "../src/agents/admitted-run-context.js";
import {
  normalizeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
} from "../src/agents/agent-run-terminal-outcome.js";
import { resolveSettledToolBatchEvidence } from "../src/agents/embedded-agent-runner/run/incomplete-turn-recovery.js";
import { resolveReplayInvalidFlag } from "../src/agents/embedded-agent-runner/run/incomplete-turn-resolution.js";
import { prepareTerminalWithSettledTurnFinalization } from "../src/agents/embedded-agent-runner/run/settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "../src/agents/embedded-agent-runner/run/settled-turn-finalization.test-support.js";
import { isEmbeddedRunTerminalTimeout } from "../src/agents/embedded-agent-runner/run/terminal-outcome.js";
import { resolveEmbeddedRunTerminal } from "../src/agents/embedded-agent-runner/run/terminal-resolution.js";
import { makeTerminalInput } from "../src/agents/embedded-agent-runner/run/terminal-resolution.test-support.js";
import { resolveEmbeddedRunTerminalTimeout } from "../src/agents/embedded-agent-runner/run/terminal-timeout.js";

const { createCodexSettledFinalizerTestFixture, registerCodexEventProjectorTestLifecycle } =
  await loadCodexSettledFinalizerTestFixture();

registerCodexEventProjectorTestLifecycle();

describe("registered Codex finalizer host silence contract", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  let admittedRunContext: AdmittedRunContext;
  let fixture: Awaited<ReturnType<typeof createCodexSettledFinalizerTestFixture>>;

  beforeEach(async () => {
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "codex-finalizer-test");
    admittedRunContext = await admission.admit("embedded");
  });

  afterEach(() => admission.close());

  async function createInput(
    options: {
      failedTool?: boolean;
      timedOut?: boolean;
    } = {},
  ) {
    fixture = await createCodexSettledFinalizerTestFixture(options);
    const { attempt, params } = fixture;
    expect(attempt.terminal.kind).toBe("failed");
    expect(attempt.itemLifecycle).toMatchObject({ activeCount: 0, completedCount: 1 });
    expect(attempt.didSendViaMessagingTool).toBe(false);
    expect(attempt.messagingToolSentTexts).toEqual([]);
    expect(attempt.messagingToolSentMediaUrls).toEqual([]);
    expect(resolveSettledToolBatchEvidence(attempt)).toMatchObject({
      allToolCallsRecorded: true,
      allToolsProvenSettled: true,
      hasUnsettledToolError: false,
    });
    expect(attempt.settledTurnFinalizationContext).toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ type: "function_call_output" })]),
    });
    if (options.timedOut) {
      // Deadline ownership follows native projection; a timeout must block finalization.
      attempt.terminal = normalizeAgentRunAttemptTerminal({
        ...projectAgentRunAttemptTerminal(attempt.terminal),
        timedOut: true,
      });
    }
    const input = createSettledFinalizationTestInput(attempt, admittedRunContext);
    input.finalization.harness = fixture.harness;
    input.finalization.preparedAttempt = { ...input.finalization.preparedAttempt, ...params };
    input.finalization.modelApi = params.model.api;
    input.terminalBase.provider = params.provider;
    input.terminalBase.model = params.modelId;
    input.terminalBase.activeErrorContext = { provider: params.provider, model: params.modelId };
    Object.assign(input.terminalBase.runParams, {
      trigger: "heartbeat",
      terminalReplyExpectation: "required",
      sourceReplyDeliveryMode: "automatic",
    });
    return input;
  }

  function returnBoundedText(text: string) {
    const result = {
      text,
      items: [],
      model: "synthetic-finalizer-model",
      nativeSelection: { model: "synthetic-finalizer-model", modelProvider: "openai" },
      managedHooksEnabled: false,
    };
    fixture.runBounded.mockResolvedValue(result);
    return result;
  }

  it.each([
    { text: " NO_REPLY\n", expectation: "required", calls: 1 },
    { text: "NO_REPLY", expectation: "required", calls: 1 },
    { text: "NO_REPLY", expectation: "result-required", calls: 2 },
    { text: " ", expectation: "required", calls: 2 },
  ] as const)(
    "preserves the provider failure after $expectation $text output",
    async ({ text, expectation, calls }) => {
      const input = await createInput();
      const runAttempt = vi.spyOn(input.finalization.harness, "runAttempt");
      input.terminalBase.runParams.terminalReplyExpectation = expectation;
      returnBoundedText(text);
      const result = await prepareTerminalWithSettledTurnFinalization(input);
      expect(fixture.runBounded).toHaveBeenCalledTimes(calls);
      expect(result.finalizationOutcome).toBe("failed");
      expect(fixture.runBounded).toHaveBeenCalledWith(
        expect.objectContaining({
          isolation: "private-stdio",
          requireNoExternalCapabilities: true,
        }),
      );
      expect(result.attempt).toBe(input.initial.attempt);
      expect(result.terminalState).toBe(input.initial.terminalState);
      expect(result.attempt.terminal).toMatchObject({ kind: "failed" });
      expect(result.terminalState.outcome.error).toContain("Provider overloaded");
      // Native tool-only failures have no completed assistant to prepare a
      // payload from; terminal resolution owns their provider guidance.
      const terminalInput = makeTerminalInput({
        ...result.prepared,
        attempt: result.attempt,
        attemptAssistant: result.attemptAssistant,
        terminalState: result.terminalState,
        runParams: input.terminalBase.runParams,
        settledTurnFinalizationOutcome: result.finalizationOutcome,
        replayState: { hadPotentialSideEffects: true, replayInvalid: true },
        resolveReplayInvalid: () => true,
      });
      const resolved = await resolveEmbeddedRunTerminal(terminalInput);
      expect(terminalInput.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
      expect(resolved.action).toBe("complete");
      if (resolved.action !== "complete") {
        throw new Error("Provider failure must settle without replay");
      }
      expect(resolved.result.meta).toMatchObject({
        stopReason: "error",
        replayInvalid: true,
        error: { message: expect.stringContaining("Provider overloaded"), fallbackSafe: false },
      });
      expect(resolved.result.payloads).toEqual([
        expect.objectContaining({
          text: expect.stringMatching(/try again/i),
          isError: true,
        }),
      ]);
      expect(resolved.result.payloads?.[0]?.text).toContain(
        "some tool actions may have already been executed",
      );
      expect(runAttempt).not.toHaveBeenCalled();
      expect(fixture.mirror).not.toHaveBeenCalled();
    },
  );

  it("does not finalize an optional empty turn after settled tool work", async () => {
    const input = await createInput();
    input.terminalBase.runParams.terminalReplyExpectation = "optional";
    const runAttempt = vi.spyOn(input.finalization.harness, "runAttempt");

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(result.finalizationOutcome).toBe("not-attempted");
    expect(result.attempt).toBe(input.initial.attempt);
    expect(result.terminalState).toBe(input.initial.terminalState);
    expect(result.terminalState.outcome.error).toContain("Provider overloaded");
    expect(fixture.runBounded).not.toHaveBeenCalled();
    expect(runAttempt).not.toHaveBeenCalled();
    expect(fixture.mirror).not.toHaveBeenCalled();
  });

  it("replaces provider failure with the ordinary finalizer answer", async () => {
    const text = "The command completed and returned: settled.";
    const input = await createInput();
    input.terminalBase.runParams.terminalReplyExpectation = "result-required";
    const runAttempt = vi.spyOn(input.finalization.harness, "runAttempt");
    returnBoundedText(text);

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(fixture.runBounded).toHaveBeenCalledOnce();
    expect(result.finalizationOutcome).toBe("answered");
    expect(result.attempt.terminal).toEqual({ kind: "ok" });
    expect(result.terminalState.outcome.error).toBeUndefined();
    expect(result.attempt.assistantTexts).toEqual([text]);
    expect(result.attempt.preparedTerminalReply).toEqual({
      text,
      terminalReply: { disposition: "visible", text },
    });
    expect(result.prepared.payloadsWithToolMedia).toEqual([expect.objectContaining({ text })]);
    expect(result.prepared.payloadsWithToolMedia?.some((payload) => payload.isError)).toBe(false);
    expect(runAttempt).not.toHaveBeenCalled();
    expect(fixture.mirror).toHaveBeenCalledOnce();
    expect(fixture.mirror.mock.calls[0]?.[0].messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text }],
      }),
    ]);
  });

  it.each(["failedTool", "timedOut", "cancelled"] as const)(
    "preserves tool failures and interruption ownership despite authored silence: %j",
    async (failure) => {
      const input = await createInput({
        failedTool: failure === "failedTool",
        timedOut: failure === "timedOut",
      });
      const boundedResult = returnBoundedText("NO_REPLY");
      if (failure === "cancelled") {
        const controller = new AbortController();
        input.finalization.abortSignal = controller.signal;
        fixture.runBounded.mockImplementation(async () => {
          controller.abort(new Error("cancelled"));
          return boundedResult;
        });
      }

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(fixture.runBounded).toHaveBeenCalledTimes(failure === "timedOut" ? 0 : 1);
      expect(result.finalizationOutcome).toBe(failure === "timedOut" ? "not-attempted" : "failed");
      expect(result.attempt).toBe(input.initial.attempt);
      if (failure === "failedTool") {
        expect(result.attempt.lastToolError).toEqual(input.initial.attempt.lastToolError);
      }
      if (failure === "timedOut") {
        expect(isEmbeddedRunTerminalTimeout(result.terminalState.outcome)).toBe(true);
        expect(result.prepared.timedOutDuringPrompt).toBe(true);
        expect(result.prepared.payloadsWithToolMedia ?? []).toEqual([]);
        // The run loop presents timeout errors after finalization preparation.
        const setTerminalLifecycleMeta = vi.fn();
        const timeout = resolveEmbeddedRunTerminalTimeout({
          terminalPrepared: result.prepared,
          attempt: result.attempt,
          terminalState: result.terminalState,
          resolveReplayInvalid: (incompleteTurnText) =>
            resolveReplayInvalidFlag({ attempt: result.attempt, incompleteTurnText }),
          setTerminalLifecycleMeta,
          startedAtMs: Date.now(),
        });
        expect(timeout?.payloads).toEqual([
          { text: expect.stringContaining("timed out"), isError: true },
        ]);
        expect(timeout?.meta).toMatchObject({
          replayInvalid: true,
          modelFallbackStopReason: "agent_run_terminal_timeout",
          error: { kind: "incomplete_turn", fallbackSafe: false },
        });
        expect(setTerminalLifecycleMeta).toHaveBeenCalledOnce();
        expect(setTerminalLifecycleMeta).toHaveBeenCalledWith(
          expect.objectContaining({ replayInvalid: true, livenessState: "blocked" }),
        );
      } else if (failure === "failedTool") {
        expect(result.prepared.payloadsWithToolMedia?.[0]).toMatchObject({ isError: true });
      }
      expect(fixture.mirror).not.toHaveBeenCalled();
    },
  );
});
