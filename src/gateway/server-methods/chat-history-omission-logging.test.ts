import { describe, expect, it } from "vitest";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../../infra/diagnostic-events.js";
import { reportOmittedChatHistory } from "./chat-history-budget.js";
import { prepareChatHistoryResponsePage } from "./chat-history-response-page.js";

function runHistoryBudgetPipeline(messages: unknown[], maxHistoryBytes: number) {
  const events: Extract<DiagnosticEventPayload, { type: "payload.large" }>[] = [];
  const unsubscribe = onDiagnosticEvent((event) => {
    if (event.type === "payload.large") {
      events.push(event);
    }
  });
  try {
    const page = prepareChatHistoryResponsePage(
      { messages },
      { entry: undefined, messageId: undefined, maxHistoryBytes },
    );
    if (page.omission) {
      reportOmittedChatHistory({ ...page.omission, maxHistoryBytes, logDebug: () => {} });
    }
    return { page, events };
  } finally {
    unsubscribe();
  }
}

function textMessage(role: string, text: string) {
  return { role, content: [{ type: "text", text }] };
}

describe("chat.history truncation logging (real diagnostic bus)", () => {
  it("emits a truncated diagnostic when history is trimmed to the last message", () => {
    const messages = [textMessage("user", "x".repeat(8000)), textMessage("assistant", "ok")];
    const { events } = runHistoryBudgetPipeline(messages, 2_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      surface: "gateway.chat.history",
      action: "truncated",
      reason: "chat_history_budget",
      count: 1,
      bytes: Buffer.byteLength(JSON.stringify(messages)),
      limitBytes: 2_000,
    });
  });

  it("emits no diagnostic when nothing is omitted", () => {
    const messages = [textMessage("user", "hello"), textMessage("assistant", "hi")];
    const { page, events } = runHistoryBudgetPipeline(messages, 1_000_000);
    expect(page.messages).toEqual(messages);
    expect(page.omission).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("counts a replaced-then-trimmed message once, not twice", () => {
    const huge = textMessage("user", "h".repeat(140_000));
    const older = textMessage("assistant", "a".repeat(2000));
    const newer = textMessage("user", "b".repeat(2000));
    const last = textMessage("assistant", "ok");
    const { page, events } = runHistoryBudgetPipeline([huge, older, newer, last], 4_000);
    expect(page.messages).toEqual([newer, last]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ count: 2 });
  });
});
