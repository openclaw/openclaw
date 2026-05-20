import { describe, expect, it } from "vitest";
import { isContextOverflowError } from "../../agents/pi-embedded-helpers.js";
import type { EmbeddedPiRunMeta } from "../../agents/pi-embedded-runner/types.js";

// Contract test for tasks/openclaw/20260520-001 — agent-runner-execution.ts
// broadened the overflow safety net to also consume
// `meta.lastAssistantErrorMessage` when `meta.error` is not populated. This
// keeps the duplicate-emission fix from regressing into a silent failure on
// the rare runs where vLLM surfaces the context-overflow string only via the
// final assistant turn (work-report 20260520-040, §4 row D).

describe("agent-runner-execution overflow safety net", () => {
  const VLLM_CONTEXT_OVERFLOW_RAW =
    "400 This model's maximum context length is 65536 tokens. However, you requested 70000 tokens.";

  // Mirror the production selection from agent-runner-execution.ts so the
  // test fails if anyone removes the new field or reverses the precedence.
  const selectOverflowErrorMessage = (meta: EmbeddedPiRunMeta | undefined): string | undefined =>
    meta?.error?.message ?? meta?.lastAssistantErrorMessage;

  it("T4: meta.error missing + lastAssistantErrorMessage matches → overflow detected", () => {
    const meta: EmbeddedPiRunMeta = {
      durationMs: 12,
      lastAssistantErrorMessage: VLLM_CONTEXT_OVERFLOW_RAW,
    };

    const selected = selectOverflowErrorMessage(meta);
    expect(selected).toBe(VLLM_CONTEXT_OVERFLOW_RAW);
    expect(isContextOverflowError(selected)).toBe(true);
  });

  it("T4b: meta.error takes precedence over lastAssistantErrorMessage when both present", () => {
    const meta: EmbeddedPiRunMeta = {
      durationMs: 8,
      error: { kind: "context_overflow", message: "explicit overflow from meta.error" },
      lastAssistantErrorMessage: VLLM_CONTEXT_OVERFLOW_RAW,
    };

    expect(selectOverflowErrorMessage(meta)).toBe("explicit overflow from meta.error");
  });

  it("T4c: no error signal anywhere → selector returns undefined, overflow check false", () => {
    const meta: EmbeddedPiRunMeta = { durationMs: 5 };
    expect(selectOverflowErrorMessage(meta)).toBeUndefined();
    expect(isContextOverflowError(selectOverflowErrorMessage(meta))).toBe(false);
  });
});
