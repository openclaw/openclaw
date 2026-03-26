import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumePersistedQueues: vi.fn(),
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../auto-reply/reply/queue/persist.js", () => ({
  consumePersistedQueues: mocks.consumePersistedQueues,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { replayPersistedPendingMessages } = await import("./server-pending-messages.js");

describe("replayPersistedPendingMessages", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });
  it("does nothing when no persisted entries exist", async () => {
    mocks.consumePersistedQueues.mockResolvedValue(null);
    await replayPersistedPendingMessages();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("does nothing for empty entries array", async () => {
    mocks.consumePersistedQueues.mockResolvedValue([]);
    await replayPersistedPendingMessages();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("injects system events for persisted messages", async () => {
    mocks.consumePersistedQueues.mockResolvedValue([
      {
        key: "agent:main:slack:channel:C123",
        items: [
          {
            prompt: "hello from Tom",
            originatingChannel: "slack",
            run: { senderName: "Tom Chapin", senderId: "U123" },
          },
        ],
      },
    ]);

    await replayPersistedPendingMessages();

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const call = mocks.enqueueSystemEvent.mock.calls[0];
    const eventText = call[0] as string;
    const opts = call[1] as { sessionKey: string; contextKey: string };
    expect(eventText).toContain("Gateway restart recovery");
    expect(eventText).toContain("hello from Tom");
    expect(eventText).toContain("Tom Chapin");
    expect(opts.sessionKey).toBe("agent:main:slack:channel:C123");
    expect(opts.contextKey).toBe("restart-pending-messages");
  });

  it("handles multiple queues with multiple messages", async () => {
    mocks.consumePersistedQueues.mockResolvedValue([
      {
        key: "session-1",
        items: [
          {
            prompt: "msg 1",
            originatingChannel: "slack",
            run: { senderName: "Alice" },
          },
          {
            prompt: "msg 2",
            originatingChannel: "slack",
            run: { senderName: "Bob" },
          },
        ],
      },
      {
        key: "session-2",
        items: [
          {
            prompt: "msg 3",
            originatingChannel: "telegram",
            run: { senderId: "tg:123" },
          },
        ],
      },
    ]);

    await replayPersistedPendingMessages();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(2);
  });

  it("truncates long message prompts to 500 chars", async () => {
    const longPrompt = "x".repeat(800);
    mocks.consumePersistedQueues.mockResolvedValue([
      {
        key: "session-1",
        items: [
          {
            prompt: longPrompt,
            originatingChannel: "slack",
            run: { senderName: "Tom Chapin" },
          },
        ],
      },
    ]);

    await replayPersistedPendingMessages();
    const [eventText] = mocks.enqueueSystemEvent.mock.calls[0];
    // The full 800-char prompt should not appear in the event text
    expect(eventText).not.toContain(longPrompt);
    // It should contain the truncated version (500 chars + ellipsis)
    expect(eventText).toContain("x".repeat(500) + "…");
  });

  it("skips entries with empty items array", async () => {
    mocks.consumePersistedQueues.mockResolvedValue([
      { key: "session-1", items: [] },
      {
        key: "session-2",
        items: [
          {
            prompt: "real message",
            originatingChannel: "slack",
            run: { senderName: "Tom" },
          },
        ],
      },
    ]);

    await replayPersistedPendingMessages();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });
});
