// Tests the question forwarder: a pending question is pushed to its turn-source
// chat with the right per-channel button payload (Telegram command actions,
// Slack callback actions), nothing is pushed when there is no deliverable
// turn-source, and each question is forwarded exactly once (deduped).
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { QuestionRecord } from "../gateway/question-manager.js";
import { createQuestionForwarder } from "./question-forwarder.js";

type DeliverArgs = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  payloads: Array<{ text: string; presentation?: { blocks: unknown[] } }>;
};

function makeRecord(overrides: Partial<QuestionRecord>): QuestionRecord {
  return {
    id: "rec-1",
    sessionKey: "s1",
    agentId: null,
    turnSourceChannel: "telegram",
    turnSourceTo: "12345",
    turnSourceAccountId: null,
    turnSourceThreadId: null,
    createdAtMs: 100,
    expiresAtMs: null,
    status: "pending",
    questions: [
      {
        id: "q1",
        header: "Deploy",
        question: "Ship it?",
        isOther: true,
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ],
    ...overrides,
  };
}

function setup() {
  const calls: DeliverArgs[] = [];
  const deliver = vi.fn(async (args: DeliverArgs) => {
    calls.push(args);
    return { status: "sent" as const };
  });
  const forwarder = createQuestionForwarder({
    getConfig: () => ({}) as OpenClawConfig,
    deliver: deliver as never,
  });
  return { calls, deliver, forwarder };
}

describe("question forwarder", () => {
  it("pushes a Telegram inline keyboard with /answer command-action buttons", async () => {
    const { calls, forwarder } = setup();
    forwarder.onPending(makeRecord({ turnSourceChannel: "telegram", turnSourceTo: "12345" }));
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe("telegram");
    expect(calls[0].to).toBe("12345");
    const buttons = (calls[0].payloads[0].presentation as { blocks: Array<{ buttons: unknown[] }> })
      .blocks[0].buttons;
    expect(buttons).toEqual([
      { label: "Yes", action: { type: "command", command: "/answer 1" }, value: "/answer 1" },
      { label: "No", action: { type: "command", command: "/answer 2" }, value: "/answer 2" },
      { label: "✏️ Other", action: { type: "command", command: "/answer" }, value: "/answer" },
    ]);
  });

  it("pushes Slack blocks with /answer callback-action buttons", async () => {
    const { calls, forwarder } = setup();
    forwarder.onPending(makeRecord({ turnSourceChannel: "slack", turnSourceTo: "C123" }));
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe("slack");
    const buttons = (calls[0].payloads[0].presentation as { blocks: Array<{ buttons: unknown[] }> })
      .blocks[0].buttons;
    expect(buttons).toEqual([
      { label: "Yes", action: { type: "callback", value: "/answer 1" } },
      { label: "No", action: { type: "callback", value: "/answer 2" } },
      { label: "✏️ Other", action: { type: "callback", value: "/answer" } },
    ]);
  });

  it("pushes nothing (and does not crash) when there is no deliverable turn source", async () => {
    const { deliver, forwarder } = setup();
    forwarder.onPending(makeRecord({ turnSourceChannel: null, turnSourceTo: null }));
    forwarder.onPending(
      makeRecord({ id: "rec-2", turnSourceChannel: "telegram", turnSourceTo: null }),
    );
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("forwards each question exactly once, re-pushing only after resolve/expiry", async () => {
    const { deliver, forwarder } = setup();
    const record = makeRecord({ id: "rec-9" });
    forwarder.onPending(record);
    forwarder.onPending(record); // reconnect/replay must not re-push
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    // After the question resolves, its dedupe entry is cleared.
    forwarder.onResolved(record);
    forwarder.onPending(record);
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
