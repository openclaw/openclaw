import { describe, expect, it } from "vitest";
import { FailoverError } from "../../agents/failover/error.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "../../agents/prepared-model-runtime.errors.js";
import {
  isPreparedModelRuntimeSupersessionError,
  resolveReplyOperationAbortReason,
} from "./reply-operation-abort.js";

/**
 * Regression for the recurring `heartbeat-main` false `agent-runner-failure`.
 *
 * The TOCTOU race: `main` re-prepares its runtime and bumps the published owner
 * generation after the heartbeat run passed its point-in-time idle guards but
 * before the model turn acquired that owner. The turn then throws a
 * `PreparedModelRuntimeOwnerNotPublishedError` ("plugin generation was
 * superseded") that fast-fails every model-fallback candidate. Because it is a
 * thrown error (not an abort-signal supersession), it must be recognised here so
 * the heartbeat classifies it as a benign preemption skip instead of a genuine
 * runner failure — while any other thrown error stays a real failure.
 */
describe("prepared-model-runtime supersession classification", () => {
  const supersession = () =>
    new PreparedModelRuntimeOwnerNotPublishedError(
      "prepared model runtime plugin generation was superseded for /agents/main/agent",
    );

  // The FailoverError the model-fallback loop throws when every candidate
  // fast-failed on the same supersession; the last real error rides as `cause`.
  const fallbackSummaryWith = (cause: unknown) =>
    new FailoverError("All model fallback candidates failed (4): ...", {
      reason: "unknown",
      attempts: [
        { provider: "openai", model: "gpt-6-astra", reason: "unknown", error: "superseded" },
      ] as never,
      soonestCooldownExpiry: null,
      cause: cause instanceof Error ? cause : undefined,
    });

  describe("isPreparedModelRuntimeSupersessionError", () => {
    it("detects a directly thrown generation-supersession error", () => {
      expect(isPreparedModelRuntimeSupersessionError(supersession())).toBe(true);
    });

    it("detects the publication-superseded subclass", () => {
      expect(
        isPreparedModelRuntimeSupersessionError(
          new PreparedModelRuntimePublicationSupersededError(
            "prepared model runtime publication was superseded for /agents/main/agent",
          ),
        ),
      ).toBe(true);
    });

    it("detects a supersession carried as the cause of a model-fallback summary", () => {
      expect(isPreparedModelRuntimeSupersessionError(fallbackSummaryWith(supersession()))).toBe(
        true,
      );
    });

    it("detects a supersession chained via error cause", () => {
      expect(
        isPreparedModelRuntimeSupersessionError(
          new Error("embedded agent failed before reply", { cause: supersession() }),
        ),
      ).toBe(true);
    });

    it("leaves a genuine (non-supersession) failure unclassified", () => {
      expect(isPreparedModelRuntimeSupersessionError(new Error("provider 500"))).toBe(false);
      expect(isPreparedModelRuntimeSupersessionError(fallbackSummaryWith(new Error("boom")))).toBe(
        false,
      );
      expect(isPreparedModelRuntimeSupersessionError(undefined)).toBe(false);
    });
  });

  describe("resolveReplyOperationAbortReason maps supersession to a benign preemption", () => {
    it("returns 'superseded' for a thrown supersession error (no abort signal)", () => {
      expect(resolveReplyOperationAbortReason(undefined, supersession())).toBe("superseded");
    });

    it("returns 'superseded' for the model-fallback summary carrying the supersession", () => {
      expect(resolveReplyOperationAbortReason(undefined, fallbackSummaryWith(supersession()))).toBe(
        "superseded",
      );
    });

    it("returns undefined for a genuine runner failure so it stays a real failure", () => {
      expect(resolveReplyOperationAbortReason(undefined, new Error("provider 500"))).toBeUndefined();
    });
  });
});
