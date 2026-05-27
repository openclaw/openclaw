import { describe, expect, it } from "vitest";
import { detectCronDenialToken, resolveCronPayloadOutcome } from "./isolated-agent/helpers.js";

describe("detectCronDenialToken", () => {
  it("matches host denial markers case-sensitively", () => {
    expect(detectCronDenialToken("SYSTEM_RUN_DENIED: approval blocked")).toBe("SYSTEM_RUN_DENIED");
    expect(detectCronDenialToken("INVALID_REQUEST: denied")).toBe("INVALID_REQUEST");
    expect(detectCronDenialToken("system_run_denied: approval blocked")).toBeUndefined();
    expect(detectCronDenialToken("invalid_request: denied")).toBeUndefined();
  });

  it("matches model-narrated denial phrases case-insensitively", () => {
    expect(detectCronDenialToken("Approval Cannot Safely Bind this runtime command")).toBe(
      "approval cannot safely bind",
    );
    expect(detectCronDenialToken("The runtime denied the operation.")).toBe("runtime denied");
    expect(detectCronDenialToken("I could not run the script.")).toBe("could not run");
    expect(detectCronDenialToken("The command did not run to completion.")).toBe("did not run");
    expect(detectCronDenialToken("The request was denied by policy.")).toBe("was denied");
  });

  it("ignores empty and non-token text", () => {
    expect(detectCronDenialToken(undefined)).toBeUndefined();
    expect(
      detectCronDenialToken("The denied claim was reviewed, then the job succeeded."),
    ).toBeUndefined();
  });
});

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

  it("promotes narrated denial markers in summary text to fatal errors", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        {
          text: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
        },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe(
      'cron classifier: denial token "SYSTEM_RUN_DENIED" detected in summary',
    );
  });

  it("promotes narrated denial markers from final assistant visible text", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "Working on it..." }],
      finalAssistantVisibleText: "I could not run the requested script.",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.outputText).toBe("I could not run the requested script.");
    expect(result.embeddedRunError).toBe(
      'cron classifier: denial token "could not run" detected in summary',
    );
  });

  it("keeps structured error payload reasons ahead of denial-token reasons", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        {
          text: "Exec failed before SYSTEM_RUN_DENIED could be retried",
          isError: true,
        },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe("Exec failed before SYSTEM_RUN_DENIED could be retried");
  });
});
