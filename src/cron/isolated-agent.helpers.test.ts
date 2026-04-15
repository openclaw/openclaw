import { describe, expect, it } from "vitest";
import { detectCronDenialToken, resolveCronPayloadOutcome } from "./isolated-agent/helpers.js";

describe("resolveCronPayloadOutcome", () => {
  it("uses the last non-empty non-error payload as summary and output", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "first" }, { text: " " }, { text: " last " }],
    });

    expect(result.summary).toBe("last");
    expect(result.outputText).toBe("last");
    expect(result.hasFatalErrorPayload).toBe(false);
  });

  it("returns a fatal error from the last error payload when no success follows", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        {
          text: "⚠️ 🛠️ Exec failed: /bin/bash: line 1: python: command not found",
          isError: true,
        },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toContain("command not found");
    expect(result.summary).toContain("Exec failed");
  });

  it("treats transient error payloads as non-fatal when a later success exists", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "⚠️ ✍️ Write: failed", isError: true },
        { text: "Write completed successfully.", isError: false },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(false);
    expect(result.summary).toBe("Write completed successfully.");
  });

  it("keeps error payloads fatal when the run also reported a run-level error", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "Model context overflow", isError: true },
        { text: "Partial assistant text before error" },
      ],
      runLevelError: { kind: "context_overflow", message: "exceeded context window" },
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toContain("Model context overflow");
  });

  it("truncates long summaries", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "a".repeat(2001) }],
    });

    expect(result.summary ?? "").toMatch(/…$/);
  });

  it("preserves all successful deliverable payloads when no final assistant text is available", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "line 1" },
        { text: "temporary error", isError: true },
        { text: "line 2" },
      ],
    });

    expect(result.deliveryPayloads).toEqual([{ text: "line 1" }, { text: "line 2" }]);
    expect(result.deliveryPayload).toEqual({ text: "line 2" });
  });

  it("prefers finalAssistantVisibleText for text-only announce delivery", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "section 1" },
        { text: "temporary error", isError: true },
        { text: "section 2" },
      ],
      finalAssistantVisibleText: "section 1\nsection 2",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.summary).toBe("section 1\nsection 2");
    expect(result.outputText).toBe("section 1\nsection 2");
    expect(result.synthesizedText).toBe("section 1\nsection 2");
    expect(result.deliveryPayloads).toEqual([{ text: "section 1\nsection 2" }]);
    expect(result.deliveryPayload).toEqual({ text: "section 2" });
  });

  it("keeps structured-content detection scoped to the last delivery payload", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ mediaUrl: "https://example.com/report.png" }, { text: "final text" }],
      finalAssistantVisibleText: "full final report",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.deliveryPayloads).toEqual([
      { mediaUrl: "https://example.com/report.png" },
      { text: "final text" },
    ]);
    expect(result.outputText).toBe("final text");
    expect(result.synthesizedText).toBe("final text");
    expect(result.deliveryPayloadHasStructuredContent).toBe(false);
  });

  it("returns only the last error payload when all payloads are errors", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "first error", isError: true },
        { text: "last error", isError: true },
      ],
      finalAssistantVisibleText: "Recovered final answer",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.outputText).toBe("last error");
    expect(result.deliveryPayloads).toEqual([{ text: "last error", isError: true }]);
    expect(result.deliveryPayload).toEqual({ text: "last error", isError: true });
  });

  it("keeps multi-payload direct delivery when finalAssistantVisibleText is not preferred", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
      finalAssistantVisibleText: "Final weather summary",
    });

    expect(result.outputText).toBe("Final weather summary");
    expect(result.deliveryPayloads).toEqual([
      { text: "Working on it..." },
      { text: "Final weather summary" },
    ]);
  });

  it("classifies runs as fatal when the summary narrates SYSTEM_RUN_DENIED without an isError payload (#67172)", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        {
          text: "I attempted to run the script but got: SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command.",
        },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    // Both the exact host token and the case-insensitive phrase match; the
    // exact-case scan runs first so SYSTEM_RUN_DENIED is what gets surfaced.
    expect(result.embeddedRunError).toContain("SYSTEM_RUN_DENIED");
  });

  it("classifies runs as fatal when a later payload narrates INVALID_REQUEST without an isError flag", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "starting step 1" },
        { text: "INVALID_REQUEST: command refused at gateway" },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toContain("INVALID_REQUEST");
  });

  it("classifies runs as fatal when the summary says 'approval cannot safely bind' (case-insensitive)", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        {
          text: "Approval cannot safely bind this interpreter/runtime command.",
        },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toContain("approval cannot safely bind");
  });

  it("leaves benign runs untouched even when they mention the word 'denied' in other contexts", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "Requested access to the public library catalog." }],
    });

    expect(result.hasFatalErrorPayload).toBe(false);
    expect(result.embeddedRunError).toBeUndefined();
  });
});

describe("detectCronDenialToken", () => {
  it("returns the exact host-emitted token when present", () => {
    expect(detectCronDenialToken("x SYSTEM_RUN_DENIED y")).toBe("SYSTEM_RUN_DENIED");
    expect(detectCronDenialToken("INVALID_REQUEST: nope")).toBe("INVALID_REQUEST");
  });

  it("does not match host tokens in different case (case-sensitive by design)", () => {
    expect(detectCronDenialToken("system_run_denied")).toBeUndefined();
  });

  it("matches human phrases case-insensitively", () => {
    expect(detectCronDenialToken("Approval cannot safely bind command.")).toBe(
      "approval cannot safely bind",
    );
    expect(detectCronDenialToken("the runtime denied this call")).toBe("runtime denied");
    expect(detectCronDenialToken("the script Was Denied by the gateway")).toBe("was denied");
  });

  it("returns undefined for empty / benign text", () => {
    expect(detectCronDenialToken(undefined)).toBeUndefined();
    expect(detectCronDenialToken("")).toBeUndefined();
    expect(detectCronDenialToken("all good")).toBeUndefined();
  });
});
