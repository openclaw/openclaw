import { expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { resolveCronPayloadOutcome } from "./isolated-agent/helpers.js";
import { resolveCronRunTimeoutOverrideMs } from "./isolated-agent/run-timeout.js";

function finalOutput(payloads: ReplyPayload[], text = "Final report") {
  return { payloads, finalAssistantVisibleText: text, preferFinalAssistantVisibleText: true };
}

function expectOutcome(
  params: Parameters<typeof resolveCronPayloadOutcome>[0],
  expected: Partial<ReturnType<typeof resolveCronPayloadOutcome>>,
  deliveryPayloads?: ReplyPayload[],
) {
  const result = resolveCronPayloadOutcome(params);
  expect(result).toMatchObject(expected);
  if (deliveryPayloads) {
    expect(result.deliveryPayloads).toEqual(deliveryPayloads);
  }
  return result;
}

it.each([
  ["bash", undefined, undefined, true, true],
  ["message", "Draft", "Final", true, false],
  ["canvas", "Partial", "Partial", false, true],
  [undefined, "Partial", "Partial", true, true],
] as const)("classifies %s warning recovery", (tool, prior, final, prefer, fatal) => {
  const text = tool ? `⚠️ ${tool} failed` : "⚠️ 🛠️ Exec failed";
  const warning = { text, isError: true };
  if (tool) {
    setReplyPayloadMetadata(warning, { toolErrorWarning: { toolName: tool } });
  }
  const selected = fatal ? text : final;
  expectOutcome(
    {
      payloads: [...(prior ? [{ text: prior }] : []), warning],
      finalAssistantVisibleText: final,
      preferFinalAssistantVisibleText: prefer,
    },
    {
      hasFatalErrorPayload: fatal,
      embeddedRunError: fatal ? text : undefined,
      pendingPresentationWarningError: tool === "message" ? text : undefined,
      summary: selected,
      outputText: selected,
    },
    [fatal ? { text, isError: true } : { text: selected }],
  );
});

it("keeps marked middleware warnings diagnostic after structured cron output", () => {
  const mediaPayload = { mediaUrl: "file:///tmp/cron-report.png" };
  const toolWarning = setReplyPayloadMetadata(
    { text: "⚠️ Exec failed", isError: true },
    { nonTerminalToolErrorWarning: true },
  );
  expectOutcome(
    { payloads: [mediaPayload, toolWarning] },
    {
      hasFatalErrorPayload: false,
      embeddedRunError: undefined,
      summary: undefined,
      outputText: undefined,
      synthesizedText: undefined,
      deliveryPayloadHasStructuredContent: true,
    },
    [mediaPayload],
  );
});

it.each([
  ["rate limit exceeded", ": rate limit exceeded", [{ text: " " }]],
  [
    { kind: "retry_limit", detail: { provider: "example" } },
    ": retry_limit",
    [{ text: "Partial" }],
  ],
  [{ detail: { provider: "example" } }, "", []],
])("synthesizes safe delivery for run-level error %j", (error, suffix, payloads) => {
  const text = `cron isolated run failed${suffix}`;
  expectOutcome(
    { payloads, runLevelError: error },
    { hasFatalErrorPayload: true, embeddedRunError: text, outputText: text },
    [{ text, isError: true }],
  );
});

it("bounds summaries without truncating the selected output", () => {
  const prefix = "a".repeat(1999);
  expectOutcome(
    { payloads: [{ text: `${prefix}🦞` }] },
    { summary: `${prefix}…`, outputText: `${prefix}🦞` },
  );
});

it.each([
  [["Final report"], true, false],
  [["Final report", "Later answer"], false, false],
  [["⚠️ Exec failed"], false, true],
] as const)("keeps speech ownership for %j", (texts, speech, isError) => {
  const finalText = texts[0];
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
  const result = resolveCronPayloadOutcome(finalOutput(payloads, finalText));

  expect(result.deliveryPayloads).toEqual([{ text: finalText }]);
  const metadata = getReplyPayloadMetadata(result.deliveryPayloads[0]!);
  expect(metadata?.tts).toEqual(speech ? tts : undefined);
  expect([
    metadata?.sourceReplyTranscriptMirror,
    metadata?.pendingFinalDeliveryCompletion,
    metadata?.deliverDespiteSourceReplySuppression,
  ]).toEqual([undefined, undefined, undefined]);
});

const presentation = {
  blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
};
it.each([
  [[{ mediaUrl: "https://example.com/report.png" }, { text: "final text" }], "final text", false],
  [[{ presentation }], undefined, true],
])("preserves structured batch %j rather than final text", (payloads, text, structured) => {
  const expected = payloads.map((payload) => ({ ...payload }));
  const result = expectOutcome(
    finalOutput(payloads),
    {
      outputText: text,
      synthesizedText: text,
      deliveryPayloadHasStructuredContent: structured,
    },
    expected,
  );
  expect(result.deliveryPayload).toEqual(expected.at(-1));
});

it.each([
  [["HEARTBEAT_OK", "Critical deployment failure"], { kind: "visible" }, 1],
  [["Checked inbox and calendar.", "HEARTBEAT_OK"], { kind: "heartbeat", controlOnly: false }, 0],
])("preserves heartbeat position in %j", (texts, disposition, start) => {
  const payloads = texts.map((text) => ({ text }));
  const result = resolveCronPayloadOutcome({
    payloads,
    finalAssistantVisibleText: texts.at(-1),
  });
  expect(result.deliveryPayloads).toEqual(texts.slice(start).map((text) => ({ text })));
  expect(result.deliveryDisposition).toEqual(disposition);
});

it("prefers typed failure signals over denial-token fallback", () => {
  const message = "SYSTEM_RUN_DENIED: approval required";
  const result = resolveCronPayloadOutcome({
    payloads: [{ text: "On it, retrying now." }],
    failureSignal: {
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message,
      fatalForCron: true,
    },
  });

  expect(result).toMatchObject({
    hasFatalErrorPayload: true,
    embeddedRunError: `cron classifier: execution_denied failure from exec (SYSTEM_RUN_DENIED): ${message}`,
    summary: message,
    outputText: message,
    synthesizedText: message,
    deliveryPayloadHasStructuredContent: false,
  });
  expect(result.deliveryPayload).toEqual({ text: message, isError: true });
  expect(result.deliveryPayloads).toEqual([{ text: message, isError: true }]);
});
it("preserves explicit payload timeoutSeconds even when it equals the agent default", () => {
  expect(resolveCronRunTimeoutOverrideMs(300)).toBe(300_000);
});
