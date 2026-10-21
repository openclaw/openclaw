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

  async function createInput(timedOut = false) {
    fixture = await createCodexSettledFinalizerTestFixture();
    const { attempt, params } = fixture;
    if (timedOut) {
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
  }

  it.each([
    ["required", 1],
    ["result-required", 2],
  ] as const)(
    "preserves the provider failure after %s finalizer silence",
    async (expectation, calls) => {
      const input = await createInput();
      input.terminalBase.runParams.terminalReplyExpectation = expectation;
      const runAttempt = vi.spyOn(input.finalization.harness, "runAttempt");
      returnBoundedText("NO_REPLY");
      const result = await prepareTerminalWithSettledTurnFinalization(input);
      expect(fixture.runBounded).toHaveBeenCalledTimes(calls);
      expect(result.finalizationOutcome).toBe("failed");
      expect(result.attempt).toBe(input.initial.attempt);
      expect(result.terminalState).toBe(input.initial.terminalState);
      expect(result.attempt.terminal).toMatchObject({ kind: "failed" });
      expect(result.terminalState.outcome.error).toContain("Provider overloaded");
      expect(fixture.runBounded).toHaveBeenCalledWith(
        expect.objectContaining({
          isolation: "private-stdio",
          requireNoExternalCapabilities: true,
        }),
      );
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
        expect.objectContaining({ text: expect.stringMatching(/try again/i), isError: true }),
      ]);
      expect(resolved.result.payloads?.[0]?.text).toContain(
        "some tool actions may have already been executed",
      );
      expect(runAttempt).not.toHaveBeenCalled();
      expect(fixture.mirror).not.toHaveBeenCalled();
    },
  );

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
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text }] }),
    ]);
  });

  it("does not dispatch a native finalizer after the original timeout", async () => {
    const input = await createInput(true);
    returnBoundedText("NO_REPLY");
    const result = await prepareTerminalWithSettledTurnFinalization(input);
    expect(fixture.runBounded).not.toHaveBeenCalled();
    expect(result.finalizationOutcome).toBe("not-attempted");
    expect(result.attempt).toBe(input.initial.attempt);
    expect(isEmbeddedRunTerminalTimeout(result.terminalState.outcome)).toBe(true);
    expect(result.prepared.timedOutDuringPrompt).toBe(true);
    expect(result.prepared.payloadsWithToolMedia ?? []).toEqual([]);
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
    expect(setTerminalLifecycleMeta).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ replayInvalid: true, livenessState: "blocked" }),
    );
    expect(fixture.mirror).not.toHaveBeenCalled();
  });
});
