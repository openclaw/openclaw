import { beforeEach, describe, expect, it, vi } from "vitest";
const logger = vi.hoisted(() => ({
  isEnabled: vi.fn((_level: string) => false),
  debug: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => logger }));
import { logDecisionEvaluation } from "./diagnostics.js";
import type { DecisionOutcome } from "./types.js";

beforeEach(() => {
  logger.isEnabled.mockReset().mockReturnValue(false);
  logger.debug.mockClear();
  logger.warn.mockClear();
});
const emit = (outcome: DecisionOutcome, dispatched = false) =>
  logDecisionEvaluation({
    options: {
      purpose: "private-purpose",
      rubricVersion: "private-rubric",
      timeoutMs: 1000,
      signal: new AbortController().signal,
      inputBudgetPolicy: "require-declared",
    },
    model: "private-model",
    providerId: "private-provider",
    started: performance.now(),
    capabilities: {
      questionTypes: ["boolean"],
      maxInputTokens: 512,
      maxTotalInputTokens: 1024,
      inputTokenScope: "encoded-question",
    },
    facts: {
      dispatched,
      estimate: {
        method: "cjk-weighted-chars-v1",
        overhead: "heuristic",
        questionCount: 1,
        criterionCount: 2,
        estimatedMaxInputTokens: 80,
        estimatedTotalInputTokens: 100,
      },
    },
    outcome,
  });

describe("Decision diagnostics", () => {
  it("collects no private identifiers or debug facts when debug is disabled", () => {
    emit({ status: "unavailable", reason: "unsupported-input", inputIssue: "budget-unknown" });
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it("reports only bounded safe counters and correlations, distinguishes estimates and actual usage", () => {
    logger.isEnabled.mockImplementation((level) => level === "debug");
    emit(
      {
        status: "ok",
        result: {
          model: "private-result-model",
          answers: { secret: { type: "boolean", probabilityTrue: 0.5 } },
          usage: { inputTokens: 95 },
        },
        provenance: {
          providerId: "private-provider",
          rubricVersion: "private-rubric",
          runtimeGeneration: "opaque",
        },
      },
      true,
    );
    expect(logger.debug).toHaveBeenCalledWith(
      "Decision evaluation completed",
      expect.objectContaining({
        estimatedMaxInputTokens: 80,
        actualInputTokens: 95,
        actualOutputTokens: null,
        providerDispatched: true,
        callerEffect: "not-observed",
        limitSource: "provider-manifest",
      }),
    );
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("private-");
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain("secret");
    emit({ status: "unavailable", reason: "unsupported-input", inputIssue: "budget-unknown" });
    expect(logger.debug).toHaveBeenLastCalledWith(
      "Decision evaluation completed",
      expect.objectContaining({ providerDispatched: false, inputIssue: "budget-unknown" }),
    );
  });
  it("rate limits safe warnings for estimated excess and confirmed provider overflow together", () => {
    logger.isEnabled.mockImplementation((level) => level === "warn");
    emit({
      status: "unavailable",
      reason: "unsupported-input",
      inputIssue: "estimated-budget-exceeded",
    });
    emit(
      {
        status: "unavailable",
        reason: "unsupported-input",
        inputIssue: "provider-context-overflow",
      },
      true,
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private-");
  });
});
