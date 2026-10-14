import { describe, expect, it } from "vitest";
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

  it("removes an earlier heartbeat acknowledgement from a substantive final result", () => {
    const result = resolveCronPayloadOutcome({
      payloads: [{ text: "HEARTBEAT_OK" }, { text: "Critical deployment failure" }],
      finalAssistantVisibleText: "Critical deployment failure",
    });

    expect(result.deliveryPayloads).toEqual([{ text: "Critical deployment failure" }]);
    expect(result.deliveryDisposition).toEqual({ kind: "visible" });
  });

  it("keeps a terminal heartbeat acknowledgement intentionally quiet", () => {
    const payloads = [{ text: "Checked inbox and calendar." }, { text: "HEARTBEAT_OK" }];
    const result = resolveCronPayloadOutcome({
      payloads,
      finalAssistantVisibleText: "HEARTBEAT_OK",
    });

    expect(result.deliveryPayloads).toEqual(payloads);
    expect(result.deliveryDisposition).toEqual({ kind: "heartbeat", controlOnly: false });
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
});
