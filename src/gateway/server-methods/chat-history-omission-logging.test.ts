// Exercise the actual history budget helpers and diagnostic bus. Omission counts
// reflect unique source messages, including messages both replaced and trimmed.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { onDiagnosticEvent } from "../../infra/diagnostic-events.js";
import type { DiagnosticPayloadLargeEvent } from "../../infra/diagnostic-events.js";
import { capArrayByJsonBytes } from "../session-transcript-readers.js";
import {
  replaceOversizedChatHistoryMessages,
  reportOmittedChatHistory,
} from "./chat-history-budget.js";

function capturePayloadLargeEvents(report: () => number) {
  const events: DiagnosticPayloadLargeEvent[] = [];
  const unsubscribe = onDiagnosticEvent((evt) => {
    if (evt.type === "payload.large") {
      events.push(evt);
    }
  });
  try {
    return { emittedCount: report(), events };
  } finally {
    unsubscribe();
  }
}

function textMessage(role: string, text: string): Record<string, unknown> {
  return { role, content: [{ type: "text", text }] };
}

describe("chat.history truncation logging (real diagnostic bus)", () => {
  it("emits a truncated diagnostic when history is trimmed to the last message", () => {
    const big = textMessage("user", "x".repeat(8000));
    const last = textMessage("assistant", "ok");
    const messages = [big, last];
    const capped = capArrayByJsonBytes(messages, 2_000).items;
    expect(capped).toEqual([last]);
    expect(capped[0]).toBe(last);

    const result = capturePayloadLargeEvents(() =>
      reportOmittedChatHistory({
        originalMessages: messages,
        finalMessages: capped,
        getNormalizedBytes: () => Buffer.byteLength(JSON.stringify(messages), "utf8"),
        maxHistoryBytes: 2_000,
        logDebug: () => {},
      }),
    );

    expect(result.events).toHaveLength(1);
    const event = expectDefined(result.events[0], "result.events[0] test invariant");
    expect(event.surface).toBe("gateway.chat.history");
    expect(event.action).toBe("truncated");
    expect(event.reason).toBe("chat_history_budget");
    expect(event.count).toBe(1);
    expect(result.emittedCount).toBe(1);
  });

  it("emits no diagnostic when nothing is omitted", () => {
    const first = textMessage("user", "hello");
    const last = textMessage("assistant", "hi");
    const messages = [first, last];
    const getNormalizedBytes = vi.fn(() => Buffer.byteLength(JSON.stringify(messages), "utf8"));
    const result = capturePayloadLargeEvents(() =>
      reportOmittedChatHistory({
        originalMessages: messages,
        finalMessages: messages,
        getNormalizedBytes,
        maxHistoryBytes: 1_000_000,
        logDebug: () => {},
      }),
    );

    expect(result.emittedCount).toBe(0);
    expect(result.events).toEqual([]);
    expect(getNormalizedBytes).not.toHaveBeenCalled();
    expect(messages).toEqual([first, last]);
    expect(messages[0]).toBe(first);
    expect(messages[1]).toBe(last);
  });

  it("counts a replaced-then-trimmed message once, not twice", () => {
    // `huge` is oversized so it is replaced with a small placeholder, then the
    // placeholder sits at the front and is dropped by the byte cap. The naive
    // sum of replacedCount + front-cap drops would count `huge` twice.
    const huge = textMessage("user", "h".repeat(8000));
    const big1 = textMessage("assistant", "a".repeat(2000));
    const big2 = textMessage("user", "b".repeat(2000));
    const last = textMessage("assistant", "ok");
    const messages = [huge, big1, big2, last];

    const replaced = replaceOversizedChatHistoryMessages({
      messages,
      maxSingleMessageBytes: 3_000,
    });
    const capped = capArrayByJsonBytes(replaced.messages, 4_000).items;

    // Scenario preconditions: a message was replaced AND front-capped, so the
    // old additive count would have over-reported.
    expect(replaced.replacedCount).toBe(1);
    const frontCapDropped = replaced.messages.length - capped.length;
    expect(frontCapDropped).toBe(2);
    expect(capped).toEqual([big2, last]);
    expect(capped[0]).toBe(big2);
    expect(capped[1]).toBe(last);
    const naiveAdditive = replaced.replacedCount + frontCapDropped;
    expect(naiveAdditive).toBe(3);

    const result = capturePayloadLargeEvents(() =>
      reportOmittedChatHistory({
        originalMessages: messages,
        finalMessages: capped,
        getNormalizedBytes: () => Buffer.byteLength(JSON.stringify(messages), "utf8"),
        maxHistoryBytes: 4_000,
        logDebug: () => {},
      }),
    );

    // The emitted count equals the number of original messages that lost their
    // verbatim representation, and is strictly less than the double-counting sum.
    expect(result.events).toHaveLength(1);
    const event = expectDefined(result.events[0], "result.events[0] test invariant");
    expect(event.surface).toBe("gateway.chat.history");
    expect(event.action).toBe("truncated");
    expect(event.reason).toBe("chat_history_budget");
    expect(event.count).toBe(2);
    expect(result.emittedCount).toBe(2);
    expect(naiveAdditive).toBeGreaterThan(result.emittedCount);
  });
});
