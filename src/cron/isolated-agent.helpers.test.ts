import { describe, expect, it } from "vitest";
import { resolveCronPayloadOutcome } from "./isolated-agent/helpers.js";

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

  it("treats appended error as non-fatal when the deliverable payload precedes it", () => {
    // Common pattern: tool fails, LLM retries and succeeds, payloads.ts appends the original
    // error warning after the deliverable output.  Short outputs like "Done" are valid finals.
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "Done. Intake complete.", isError: false },
        { text: "⚠️ ✉️ Message failed", isError: true },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(false);
    expect(result.summary).toContain("Intake complete");
  });

  it("treats appended error as non-fatal even for longer deliverable payloads", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "Here is the full Linear intake summary:\n\n" + "x".repeat(150), isError: false },
        { text: "⚠️ ✉️ Message failed", isError: true },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(false);
    expect(result.summary).toContain("Linear intake summary");
  });

  it("treats a non-deliverable status line before an error as fatal (not recovered)", () => {
    // A payload that is not the deliverable output (e.g. a transient status with no
    // outbound content) before a real crash should not suppress hasFatalErrorPayload.
    // pickLastDeliverablePayload skips error payloads, so if the only non-error payload
    // is after the error it still recovers via hasSuccessfulPayloadAfterLastError.
    // Here there is NO non-error payload at all except the status line — which is not
    // the deliverable output because there is nothing to deliver after the error.
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "⚠️ Fatal: context limit exceeded", isError: true }],
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toContain("context limit exceeded");
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

    expect(String(result.summary ?? "")).toMatch(/…$/);
  });
});
