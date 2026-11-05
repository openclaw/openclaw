import { describe, expect, it } from "vitest";
import { readSessionTranscriptAccountingTail } from "./session-transcript-accounting-policy.js";

function assistantEvent(message: Record<string, unknown>) {
  return { type: "message", message: { role: "assistant", ...message } };
}

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/** The gateway stamps a stopped run's partial with unavailable usage and an abort marker. */
function gatewayInjectedAbort(content: string) {
  return assistantEvent({
    content,
    stopReason: "stop",
    usage: {
      ...zeroUsage,
      usageReport: { state: "unavailable" },
      contextUsage: { state: "unavailable" },
    },
    api: "openai-responses",
    provider: "openclaw",
    model: "gateway-injected",
    openclawAbort: { aborted: true, origin: "chat.abort", runId: "run-1" },
  });
}

function readUsage(events: unknown[]) {
  // Backends visit the active tail newest first.
  return readSessionTranscriptAccountingTail(
    (visitor) => {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        visitor(events[index]);
      }
    },
    { includeByteSize: false, includeUsage: true },
  ).usage;
}

describe("readSessionTranscriptAccountingTail usage anchor", () => {
  const anchor = assistantEvent({
    content: "calling a tool",
    stopReason: "toolUse",
    usage: { input: 72_912, output: 150, cacheRead: 0, cacheWrite: 0, totalTokens: 73_062 },
  });

  it("keeps the previous usage anchor across a gateway-injected abort marker", () => {
    const aborted = gatewayInjectedAbort("partial answer before the stop");
    const usage = readUsage([anchor, aborted]);

    expect(usage?.promptTokens).toBe(72_912);
    expect(usage?.outputTokens).toBe(150);
    expect(usage?.trailingMessages.map((message) => message.content)).toEqual([
      "partial answer before the stop",
    ]);
  });

  it("still treats an unavailable context snapshot without the abort marker as a barrier", () => {
    const unavailable = assistantEvent({
      content: "usage unavailable",
      usage: { ...zeroUsage, contextUsage: { state: "unavailable" } },
    });

    expect(readUsage([anchor, unavailable])).toBeUndefined();
  });

  it("prefers a later real usage snapshot over the anchor kept across an abort", () => {
    const later = assistantEvent({
      content: "next turn",
      usage: { input: 45_000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 45_020 },
    });

    const usage = readUsage([anchor, gatewayInjectedAbort("partial"), later]);
    expect(usage?.promptTokens).toBe(45_000);
    expect(usage?.trailingMessages).toEqual([]);
  });
});
