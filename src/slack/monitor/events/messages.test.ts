import { describe, expect, it, vi } from "vitest";
import { registerSlackMessageEvents } from "./messages.js";

const enqueueSystemEventMock = vi.fn();

vi.mock("../../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

type RegisteredMessageHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
}) => Promise<void>;

function createContext() {
  let messageHandler: RegisteredMessageHandler | null = null;
  const app = {
    event: vi.fn((name: string, handler: RegisteredMessageHandler) => {
      if (name === "message") {
        messageHandler = handler;
      }
    }),
  };

  const ctx = {
    app,
    botUserId: "UBOT",
    runtime: {
      error: vi.fn(),
    },
    shouldDropMismatchedSlackEvent: vi.fn(() => false),
    resolveChannelName: vi.fn(async () => ({ name: "alerts", type: "channel" })),
    isChannelAllowed: vi.fn(() => true),
    resolveSlackSystemEventSessionKey: vi.fn(() => "agent:main:slack:channel:C1"),
  };

  return {
    ctx,
    app,
    getMessageHandler: () => messageHandler,
  };
}

describe("registerSlackMessageEvents", () => {
  it("ignores message_changed events authored by the connected bot user", async () => {
    enqueueSystemEventMock.mockReset();
    const handleSlackMessage = vi.fn(async () => undefined);
    const { ctx, getMessageHandler } = createContext();

    registerSlackMessageEvents({
      ctx: ctx as never,
      handleSlackMessage,
    });

    const messageHandler = getMessageHandler();
    expect(messageHandler).toBeTruthy();

    await messageHandler!({
      body: {},
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: {
          ts: "100.200",
          user: "UBOT",
        },
        previous_message: {
          ts: "100.200",
          user: "UBOT",
        },
      },
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(handleSlackMessage).not.toHaveBeenCalled();
  });

  it("enqueues message_changed events for non-bot edits", async () => {
    enqueueSystemEventMock.mockReset();
    const handleSlackMessage = vi.fn(async () => undefined);
    const { ctx, getMessageHandler } = createContext();

    registerSlackMessageEvents({
      ctx: ctx as never,
      handleSlackMessage,
    });

    const messageHandler = getMessageHandler();
    expect(messageHandler).toBeTruthy();

    await messageHandler!({
      body: {},
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: {
          ts: "100.200",
          user: "U123",
        },
      },
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Slack message edited in #alerts.", {
      sessionKey: "agent:main:slack:channel:C1",
      contextKey: "slack:message:changed:C1:100.200",
    });
    expect(handleSlackMessage).not.toHaveBeenCalled();
  });
});
