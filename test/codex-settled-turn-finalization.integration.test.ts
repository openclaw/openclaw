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
      model: "synthetic-finalizer-model",
      nativeSelection: { model: "synthetic-finalizer-model", modelProvider: "openai" },
      managedHooksEnabled: false,
    };
    fixture.runBounded.mockResolvedValue(result);
    return result;
  }

  it.each([true, false, undefined])(
    "honors optional authored silence independently of empty-reply permission (%s)",
    async (allowed) => {
      const input = await createInput();
      input.terminalBase.runParams.allowEmptyAssistantReplyAsSilent = allowed;
      returnBoundedText(" NO_REPLY\n");

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(fixture.runBounded).toHaveBeenCalledOnce();
      expect(fixture.runBounded).toHaveBeenCalledWith(
        expect.objectContaining({
          isolation: "private-stdio",
          requireNoExternalCapabilities: true,
        }),
      );
      expect(result.finalizationOutcome).toBe("answered");
      expect(result.attempt.assistantTexts).toEqual(["NO_REPLY"]);
      expect(result.prepared.payloadsWithToolMedia ?? []).toEqual([]);
      expect(fixture.mirror).not.toHaveBeenCalled();
    },
  );

  it.each([
    { text: "no_reply", expectation: "optional", silent: true },
    { text: "NO_REPLY", expectation: "required", silent: false },
    { text: " ", expectation: "optional", silent: false },
    { text: " ", expectation: "required", silent: false },
  ] as const)("distinguishes $expectation $text output", async ({ text, expectation, silent }) => {
    const input = await createInput();
    input.terminalBase.runParams.terminalReplyExpectation = expectation;
    input.terminalBase.runParams.allowEmptyAssistantReplyAsSilent = true;
    returnBoundedText(text);

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(fixture.runBounded).toHaveBeenCalledTimes(silent ? 1 : 2);
    expect(result.finalizationOutcome).toBe(silent ? "answered" : "completed-empty");
    if (silent) {
      expect(result.attempt.assistantTexts).toEqual([text]);
      expect(result.prepared.payloadsWithToolMedia ?? []).toEqual([]);
    } else {
      expect(result.prepared.payloadsWithToolMedia).toEqual([
        expect.objectContaining({
          text: "The tool run finished, but no final summary was produced. I did not repeat any completed actions.",
        }),
      ]);
    }
    expect(fixture.mirror).not.toHaveBeenCalled();
  });

  it.each([{ failedTool: true }, { timedOut: true }])(
    "does not hide an original failure with authored silence: %j",
    async (options) => {
      const input = await createInput(options);
      input.terminalBase.runParams.allowEmptyAssistantReplyAsSilent = true;
      returnBoundedText("NO_REPLY");

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(fixture.runBounded).toHaveBeenCalledTimes(options.timedOut ? 0 : 2);
      expect(result.finalizationOutcome).toBe(options.timedOut ? "not-attempted" : "failed");
      expect(result.attempt).toBe(input.initial.attempt);
      if (options.timedOut) {
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
      } else {
        expect(result.prepared.payloadsWithToolMedia?.[0]).toMatchObject({ isError: true });
      }
      expect(fixture.mirror).not.toHaveBeenCalled();
    },
  );

  it("preserves cancellation while the bounded finalizer returns authored silence", async () => {
    const input = await createInput();
    const controller = new AbortController();
    input.finalization.abortSignal = controller.signal;
    const boundedResult = returnBoundedText("NO_REPLY");
    fixture.runBounded.mockImplementation(async () => {
      controller.abort(new Error("cancelled"));
      return boundedResult;
    });

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(fixture.runBounded).toHaveBeenCalledOnce();
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt).toBe(input.initial.attempt);
    expect(fixture.mirror).not.toHaveBeenCalled();
  });
});
