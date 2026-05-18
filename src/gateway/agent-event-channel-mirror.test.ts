import { describe, expect, it, vi } from "vitest";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { createAgentEventChannelMirror } from "./agent-event-channel-mirror.js";

function event(overrides: Partial<AgentEventPayload>): AgentEventPayload {
  return {
    runId: "run-1",
    seq: 1,
    stream: "assistant",
    ts: 1_000,
    sessionKey: "agent:main:subagent:child-1",
    data: {},
    ...overrides,
  } as AgentEventPayload;
}

function createHarness() {
  const sendDurableMessageBatch = vi.fn().mockResolvedValue({
    status: "sent",
    results: [{ channel: "telegram", messageId: "tg-1", chatId: "-100" }],
    receipt: { id: "receipt-1" },
  });
  const loadSessionEntry = vi.fn().mockReturnValue({
    cfg: { channels: {} },
    entry: {
      sessionId: "session-1",
      deliveryContext: {
        channel: "telegram",
        to: "-100",
        accountId: "default",
        threadId: "1189",
      },
    },
  });
  const mirror = createAgentEventChannelMirror({
    sendDurableMessageBatch,
    loadSessionEntry,
    delayMs: 0,
  });
  return { mirror, sendDurableMessageBatch, loadSessionEntry };
}

describe("agent event channel mirror", () => {
  it("mirrors thread-bound subagent progress, tool, command output, and thinking events to the Telegram topic", async () => {
    const { mirror, sendDurableMessageBatch } = createHarness();

    await mirror(
      event({
        stream: "assistant",
        data: { text: "Step 1: inspect", delta: "Step 1: inspect", phase: "commentary" },
      }),
    );
    await mirror(
      event({
        seq: 2,
        stream: "item",
        data: { phase: "start", kind: "tool", title: "exec cargo fmt" },
      }),
    );
    await mirror(
      event({
        seq: 3,
        stream: "command_output",
        data: { phase: "end", title: "exec cargo fmt", output: "fmt passed" },
      }),
    );
    await mirror(
      event({
        seq: 4,
        stream: "thinking",
        data: { text: "checking blockers", delta: "checking blockers" },
      }),
    );

    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(4);
    for (const call of sendDurableMessageBatch.mock.calls) {
      expect(call[0]).toMatchObject({
        channel: "telegram",
        to: "-100",
        accountId: "default",
        threadId: "1189",
        bestEffort: true,
      });
    }
    const sentText = sendDurableMessageBatch.mock.calls
      .map((call) => call[0].payloads?.[0]?.text)
      .join("\n---\n");
    expect(sentText).toContain("Step 1: inspect");
    expect(sentText).toContain("exec cargo fmt");
    expect(sentText).toContain("fmt passed");
    expect(sentText).toContain("checking blockers");
  });

  it("skips final-answer assistant text because normal agent delivery already sends it", async () => {
    const { mirror, sendDurableMessageBatch } = createHarness();

    await mirror(
      event({
        data: {
          text: "Final review summary",
          delta: "Final review summary",
          phase: "final_answer",
        },
      }),
    );

    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
  });

  it("mirrors any session with an explicit Telegram thread route, including cron proof sessions", async () => {
    const { mirror, sendDurableMessageBatch } = createHarness();

    await mirror(
      event({
        sessionKey: "agent:main:cron:job-1:run:run-1",
        data: { text: "cron threaded progress", delta: "cron threaded progress" },
      }),
    );

    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    expect(sendDurableMessageBatch.mock.calls[0]?.[0]).toMatchObject({
      channel: "telegram",
      to: "-100",
      threadId: "1189",
      payloads: [{ text: "💬 cron threaded progress" }],
    });
  });

  it("does not mirror sessions without a Telegram thread route", async () => {
    const { sendDurableMessageBatch, loadSessionEntry } = createHarness();
    loadSessionEntry.mockReturnValue({
      cfg: { channels: {} },
      entry: {
        sessionId: "session-1",
        deliveryContext: { channel: "telegram", to: "-100", accountId: "default" },
      },
    });
    const mirror = createAgentEventChannelMirror({
      sendDurableMessageBatch,
      loadSessionEntry,
      delayMs: 0,
    });

    await mirror(
      event({
        sessionKey: "agent:main:explicit:abc",
        data: { text: "no thread", delta: "no thread" },
      }),
    );

    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
  });
});
