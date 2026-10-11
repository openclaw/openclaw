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

  async function createInput(options: { failedTool?: boolean; timedOut?: boolean } = {}) {
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
      terminalReplyExpectation: "optional",
      sourceReplyDeliveryMode: "automatic",
    });
    return input;
  }

  function returnBoundedText(text: string) {
    const result = {
      text,
      items: [],
      submittedInput: [{ type: "text" as const, text: fixture.params.prompt, text_elements: [] }],
      model: "synthetic-finalizer-model",
      nativeSelection: { model: "synthetic-finalizer-model", modelProvider: "openai" },
      managedHooksEnabled: false,
    };
    fixture.runBounded.mockResolvedValue(result);
    return result;
  }

  it.each([
    { text: " NO_REPLY\n", expectation: "optional", allowEmpty: false, answered: true },
    { text: "NO_REPLY", expectation: "required", allowEmpty: true, answered: false },
    { text: " ", expectation: "optional", allowEmpty: true, answered: false },
  ] as const)(
    "distinguishes $expectation $text output",
    async ({ text, expectation, allowEmpty, answered }) => {
      const input = await createInput();
      input.terminalBase.runParams.terminalReplyExpectation = expectation;
      input.terminalBase.runParams.allowEmptyAssistantReplyAsSilent = allowEmpty;
      returnBoundedText(text);
      const result = await prepareTerminalWithSettledTurnFinalization(input);
      expect(fixture.runBounded).toHaveBeenCalledTimes(answered ? 1 : 2);
      expect(result.finalizationOutcome).toBe(answered ? "answered" : "failed");
      if (answered) {
        expect(fixture.runBounded).toHaveBeenCalledWith(
          expect.objectContaining({
            isolation: "private-stdio",
            requireNoExternalCapabilities: true,
          }),
        );
        expect(result.attempt.assistantTexts).toEqual(["NO_REPLY"]);
        expect(result.prepared.payloadsWithToolMedia ?? []).toEqual([]);
      } else {
        expect(result.attempt.terminal).toBe(input.initial.attempt.terminal);
        expect(result.prepared.payloadsWithToolMedia).toEqual([
          expect.objectContaining({
            text: "The AI service is temporarily overloaded. Please try again in a moment.",
          }),
        ]);
      }
      expect(fixture.mirror).not.toHaveBeenCalled();
    },
  );

  it.each(["failedTool", "timedOut", "cancelled"] as const)(
    "does not hide an original failure with authored silence: %j",
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
      } else {
        input.terminalBase.runParams.allowEmptyAssistantReplyAsSilent = true;
      }

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(fixture.runBounded).toHaveBeenCalledTimes(
        failure === "timedOut" ? 0 : failure === "cancelled" ? 1 : 2,
      );
      expect(result.finalizationOutcome).toBe(failure === "timedOut" ? "not-attempted" : "failed");
      expect(result.attempt).toBe(input.initial.attempt);
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
