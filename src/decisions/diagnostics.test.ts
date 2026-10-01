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
const emit = (outcome?: DecisionOutcome, dispatched = false) =>
  logDecisionEvaluation({
    options: {
      purpose: "private-purpose",
      rubricVersion: "private-rubric",
      timeoutMs: 1000,
      signal: new AbortController().signal,
    },
    model: "private-model",
    providerId: "private-provider",
    started: performance.now(),
    facts: { dispatched, questionCount: 1, jsonInputBytes: 120 },
    outcome,
  });

describe("Decision diagnostics", () => {
  it("collects no DEBUG facts when disabled", () => {
    emit({ status: "unavailable", reason: "disabled" });
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it("logs safe counters and actual usage, not content or an inferred caller effect", () => {
    logger.isEnabled.mockImplementation((level) => level === "debug");
    emit(
      {
        status: "ok",
        result: {
          model: "private-result-model",
          answers: { privateQuestion: { type: "boolean", probabilityTrue: 0.5 } },
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
        questionCount: 1,
        jsonInputBytes: 120,
        actualInputTokens: 95,
        actualOutputTokens: null,
        providerDispatched: true,
        callerEffect: "not-observed",
      }),
    );
    const logged = JSON.stringify(logger.debug.mock.calls);
    expect(logged).not.toContain("private");
    expect(logged).not.toContain("estimated");
    emit({ status: "unavailable", reason: "unsupported-input" }, true);
    expect(logger.debug).toHaveBeenLastCalledWith(
      "Decision evaluation completed",
      expect.objectContaining({
        status: "unavailable",
        reason: "unsupported-input",
        providerDispatched: true,
      }),
    );
    emit();
    expect(logger.debug).toHaveBeenLastCalledWith(
      "Decision evaluation completed",
      expect.objectContaining({ status: "rejected" }),
    );
  });
  it("rate limits generic input-rejection warnings without claiming context overflow", () => {
    logger.isEnabled.mockImplementation((level) => level === "warn");
    emit({ status: "unavailable", reason: "unsupported-input" }, true);
    emit({ status: "unavailable", reason: "unsupported-input" }, true);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "Decision input was rejected; the caller retains its fallback policy.",
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
