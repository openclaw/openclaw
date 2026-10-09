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
  it.each([false, true])("keeps DEBUG disabled and bounds input warnings (warn: %s)", (warn) => {
    logger.isEnabled.mockImplementation((level) => warn && level === "warn");
    if (warn) {
      emit({ status: "unavailable", reason: "unsupported-input" }, true);
      emit({ status: "unavailable", reason: "unsupported-input" }, true);
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        "Decision input was rejected; the caller retains its fallback policy.",
      );
    } else {
      emit({ status: "unavailable", reason: "disabled" });
      expect(logger.warn).not.toHaveBeenCalled();
    }
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
