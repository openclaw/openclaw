import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { resolveCronPayloadOutcome } from "./isolated-agent/helpers.js";
import { resolveCronRunTimeoutOverrideMs } from "./isolated-agent/run-timeout.js";

function createToolWarning(text: string, toolName: string): ReplyPayload {
  return setReplyPayloadMetadata({ text, isError: true }, { toolErrorWarning: { toolName } });
}

describe("resolveCronPayloadOutcome", () => {
  it("keeps tool warnings fatal when terminal output is NO_REPLY", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [createToolWarning("⚠️ Bash failed: mount unavailable", "bash")],
      finalAssistantVisibleText: "NO_REPLY",
      preferFinalAssistantVisibleText: true,
    });
    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toContain("Bash failed");
  });

  it("keeps genuine visible terminal output as recovery proof", () => {
    const result = resolveCronPayloadOutcome({
      payloads: buildEmbeddedRunPayloads({
        assistantTexts: [],
        lastAssistant: undefined,
        lastToolError: { toolName: "bash", error: "mount unavailable" },
        sessionKey: "cron:test",
      }),
      finalAssistantVisibleText: "Mount restored; report written.",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.hasFatalErrorPayload).toBe(false);
    expect(result.outputText).toBe("Mount restored; report written.");
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

  it("keeps marked middleware warnings diagnostic after structured cron output", () => {
    const mediaPayload = { mediaUrl: "file:///tmp/cron-report.png" };
    const toolWarning = setReplyPayloadMetadata(
      {
        text: "⚠️ Exec failed",
        isError: true,
      },
      { nonTerminalToolErrorWarning: true },
    );

    const result = resolveCronPayloadOutcome({
      payloads: [mediaPayload, toolWarning],
    });

    expect(result.hasFatalErrorPayload).toBe(false);
    expect(result.embeddedRunError).toBeUndefined();
    expect(result.summary).toBeUndefined();
    expect(result.outputText).toBeUndefined();
    expect(result.synthesizedText).toBeUndefined();
    expect(result.deliveryPayloads).toEqual([mediaPayload]);
    expect(result.deliveryPayloadHasStructuredContent).toBe(true);
  });

  it("treats trailing message delivery warnings as non-fatal when final assistant text exists", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "Draft output" }, createToolWarning("⚠️ Message failed", "message")],
      finalAssistantVisibleText: "Final cron report",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.hasFatalErrorPayload).toBe(false);
    expect(result.embeddedRunError).toBeUndefined();
    expect(result.pendingPresentationWarningError).toBe("⚠️ Message failed");
    expect(result.summary).toBe("Final cron report");
    expect(result.outputText).toBe("Final cron report");
    expect(result.deliveryPayloads).toEqual([{ text: "Final cron report" }]);
  });

  it("keeps trailing canvas warnings fatal even when earlier assistant output exists", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        { text: "Saved report to disk." },
        createToolWarning("⚠️ Canvas failed", "canvas"),
      ],
      finalAssistantVisibleText: "Saved report to disk.",
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.pendingPresentationWarningError).toBeUndefined();
    expect(result.embeddedRunError).toBe("⚠️ Canvas failed");
    expect(result.deliveryPayloads).toEqual([{ text: "⚠️ Canvas failed", isError: true }]);
  });

  it.each(["⚠️ 🛠️ Exec failed"])(
    "keeps unmarked trailing error %s fatal despite earlier output",
    (errorText) => {
      const result = resolveCronPayloadOutcome({
        payloads: [{ text: "Partial result" }, { text: errorText, isError: true }],
        finalAssistantVisibleText: "Partial result",
        preferFinalAssistantVisibleText: true,
      });

      expect(result.hasFatalErrorPayload).toBe(true);
      expect(result.embeddedRunError).toBe(errorText);
      expect(result.outputText).toBe(errorText);
      expect(result.deliveryPayloads).toEqual([{ text: errorText, isError: true }]);
    },
  );

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
    expect(result.outputText).toBe("Model context overflow");
    expect(result.deliveryPayloads).toEqual([{ text: "Model context overflow", isError: true }]);
  });

  it.each([
    { error: "rate limit exceeded", suffix: ": rate limit exceeded", payloads: [{ text: " " }] },
    {
      error: { kind: "retry_limit", detail: { provider: "example" } },
      suffix: ": retry_limit",
      payloads: [{ text: "Partial assistant text before failure" }],
    },
    { error: { detail: { provider: "example" } }, suffix: "", payloads: [] },
  ])("synthesizes safe delivery for run-level error $error", ({ error, suffix, payloads }) => {
    const result = resolveCronPayloadOutcome({ payloads, runLevelError: error });
    const text = `cron isolated run failed${suffix}`;
    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe(text);
    expect(result.outputText).toBe(text);
    expect(result.deliveryPayloads).toEqual([{ text, isError: true }]);
  });

  it.each([[`${"a".repeat(1999)}🦞`, `${"a".repeat(1999)}…`]])(
    "bounds summaries without truncating the selected output",
    (text, summary) => {
      const result = resolveCronPayloadOutcome({
        payloads: [{ text }],
      });

      expect(result.summary).toBe(summary);
      expect(result.outputText).toBe(text);
    },
  );

  it.each([
    {
      name: "matching final answer",
      texts: ["Final report"],
      finalText: "Final report",
      speech: true,
    },
    {
      name: "earlier matching answer",
      texts: ["Final report", "Later answer"],
      finalText: "Final report",
      speech: false,
    },
    {
      name: "matching recovered tool warning",
      texts: ["⚠️ Exec failed"],
      finalText: "⚠️ Exec failed",
      speech: false,
      isError: true,
    },
  ])("keeps only speech facts owned by the $name", ({ texts, finalText, speech, isError }) => {
    const tts = { tagged: true as const, text: "Authored spoken report" };
    const payloads = texts.map((text) =>
      setReplyPayloadMetadata<ReplyPayload>(
        { text, ...(isError ? { isError } : {}) },
        {
          tts,
          ...(isError ? { toolErrorWarning: { toolName: "exec" } } : {}),
          sourceReplyTranscriptMirror: { sessionKey: "agent:main:source" },
          pendingFinalDeliveryCompletion: {
            deliveryId: "delivery-1",
            intentId: "intent-1",
            sessionId: "session-1",
            sessionKey: "agent:main:source",
            storePath: "/tmp/cron-speech-test.sqlite",
          },
          deliverDespiteSourceReplySuppression: true,
        },
      ),
    );
    const result = resolveCronPayloadOutcome({
      payloads,
      finalAssistantVisibleText: finalText,
      preferFinalAssistantVisibleText: true,
    });

    expect(result.deliveryPayloads).toEqual([{ text: finalText }]);
    const metadata = getReplyPayloadMetadata(result.deliveryPayloads[0]!);
    expect(metadata?.tts).toEqual(speech ? tts : undefined);
    expect(metadata?.sourceReplyTranscriptMirror).toBeUndefined();
    expect(metadata?.pendingFinalDeliveryCompletion).toBeUndefined();
    expect(metadata?.deliverDespiteSourceReplySuppression).toBeUndefined();
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

  it("keeps presentation-only delivery payloads instead of collapsing to final text", () => {
    const presentationPayload = {
      presentation: {
        blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
      },
    };
    const result = resolveCronPayloadOutcome({
      payloads: [presentationPayload],
      finalAssistantVisibleText: "fallback text",
      preferFinalAssistantVisibleText: true,
    });

    expect(result.deliveryPayloads).toEqual([presentationPayload]);
    expect(result.deliveryPayload).toEqual(presentationPayload);
    expect(result.outputText).toBeUndefined();
    expect(result.synthesizedText).toBeUndefined();
    expect(result.deliveryPayloadHasStructuredContent).toBe(true);
  });

  it("removes an earlier silent acknowledgement from a substantive final result", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "NO_REPLY" }, { text: "Critical deployment failure" }],
      finalAssistantVisibleText: "Critical deployment failure",
    });

    expect(result.deliveryPayloads).toEqual([{ text: "Critical deployment failure" }]);
    expect(result.deliveryDisposition).toEqual({ kind: "visible" });
  });

  it("keeps a terminal silent acknowledgement intentionally quiet", () => {
    const payloads = [{ text: "Checked inbox and calendar." }, { text: "NO_REPLY" }];
    const result = resolveCronPayloadOutcome({
      payloads,
      finalAssistantVisibleText: "NO_REPLY",
    });

    expect(result.deliveryPayloads).toEqual(payloads);
    expect(result.deliveryDisposition).toEqual({ kind: "silent", controlOnly: false });
  });

  it("records a pure silent acknowledgement as a control-only terminal", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "NO_REPLY" }],
      finalAssistantVisibleText: "NO_REPLY",
    });

    expect(result.deliveryDisposition).toEqual({ kind: "silent", controlOnly: true });
  });

  it("preserves structured output while removing a sibling silent acknowledgement", () => {
    const mediaPayload = {
      text: "NO_REPLY",
      mediaUrl: "https://example.com/report.png",
    };
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "NO_REPLY" }, mediaPayload],
      finalAssistantVisibleText: "NO_REPLY",
    });

    expect(result.deliveryPayloads).toEqual([mediaPayload]);
    expect(result.deliveryDisposition).toEqual({ kind: "visible" });
  });

  it("does not promote narrated denial markers in summary text to fatal errors", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [
        {
          text: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
        },
      ],
    });

    expect(result.hasFatalErrorPayload).toBe(false);
    expect(result.embeddedRunError).toBeUndefined();
    expect(result.outputText).toBe(
      "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
    );
  });

  it("prefers typed failure signals over denial-token fallback", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "On it, retrying now." }],
      failureSignal: {
        kind: "execution_denied",
        source: "tool",
        toolName: "exec",
        code: "SYSTEM_RUN_DENIED",
        message: "SYSTEM_RUN_DENIED: approval required",
        fatalForCron: true,
      },
    });

    expect(result.hasFatalErrorPayload).toBe(true);
    expect(result.embeddedRunError).toBe(
      "cron classifier: execution_denied failure from exec (SYSTEM_RUN_DENIED): SYSTEM_RUN_DENIED: approval required",
    );
    expect(result.summary).toBe("SYSTEM_RUN_DENIED: approval required");
    expect(result.outputText).toBe("SYSTEM_RUN_DENIED: approval required");
    expect(result.synthesizedText).toBe("SYSTEM_RUN_DENIED: approval required");
    expect(result.deliveryPayload).toEqual({
      text: "SYSTEM_RUN_DENIED: approval required",
      isError: true,
    });
    expect(result.deliveryPayloads).toEqual([
      { text: "SYSTEM_RUN_DENIED: approval required", isError: true },
    ]);
    expect(result.deliveryPayloadHasStructuredContent).toBe(false);
  });
});

describe("resolveCronRunTimeoutOverrideMs", () => {
  // Explicit payload timeouts must survive even when they equal the configured default.
  it("preserves explicit payload timeoutSeconds even when it equals the agent default", () => {
    expect(resolveCronRunTimeoutOverrideMs(300)).toBe(300_000);
  });

  it("caps oversized explicit payload timeoutSeconds at the timer-safe ceiling", () => {
    expect(resolveCronRunTimeoutOverrideMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("omits the signal when the cron payload has no positive finite timeout", () => {
    expect(resolveCronRunTimeoutOverrideMs(undefined)).toBeUndefined();
    expect(resolveCronRunTimeoutOverrideMs(0)).toBeUndefined();
    expect(resolveCronRunTimeoutOverrideMs(-1)).toBeUndefined();
    expect(resolveCronRunTimeoutOverrideMs(Number.NaN)).toBeUndefined();
  });
});
