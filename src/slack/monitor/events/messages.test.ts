import { describe, expect, it, vi } from "vitest";
import { registerSlackMessageEvents } from "./messages.js";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventTestOverrides,
} from "./system-event-test-harness.js";

const messageQueueMock = vi.fn();
const messageAllowMock = vi.fn();

vi.mock("../../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => messageQueueMock(...args),
}));

vi.mock("../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => messageAllowMock(...args),
}));

type MessageHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

type MessageCase = {
  overrides?: SlackSystemEventTestOverrides;
  event?: Record<string, unknown>;
  body?: unknown;
};

function createMessageHandlers(overrides?: SlackSystemEventTestOverrides) {
  const harness = createSlackSystemEventTestHarness(overrides);
  const handleSlackMessage = vi.fn(async () => {});
  registerSlackMessageEvents({
    ctx: harness.ctx,
    handleSlackMessage,
  });
  return {
    handler: harness.getHandler("message") as MessageHandler | null,
    handleSlackMessage,
  };
}

function makeChangedEvent(overrides?: { channel?: string; user?: string }) {
  const user = overrides?.user ?? "U1";
  return {
    type: "message",
    subtype: "message_changed",
    channel: overrides?.channel ?? "D1",
    message: { ts: "123.456", user },
    previous_message: { ts: "123.450", user },
    event_ts: "123.456",
  };
}

function makeDeletedEvent(overrides?: { channel?: string; user?: string }) {
  return {
    type: "message",
    subtype: "message_deleted",
    channel: overrides?.channel ?? "D1",
    deleted_ts: "123.456",
    previous_message: {
      ts: "123.450",
      user: overrides?.user ?? "U1",
    },
    event_ts: "123.456",
  };
}

function makeThreadBroadcastEvent(overrides?: { channel?: string; user?: string }) {
  const user = overrides?.user ?? "U1";
  return {
    type: "message",
    subtype: "thread_broadcast",
    channel: overrides?.channel ?? "D1",
    user,
    message: { ts: "123.456", user },
    event_ts: "123.456",
  };
}

async function runMessageCase(input: MessageCase = {}): Promise<void> {
  messageQueueMock.mockClear();
  messageAllowMock.mockReset().mockResolvedValue([]);
  const { handler } = createMessageHandlers(input.overrides);
  expect(handler).toBeTruthy();
  await handler!({
    event: (input.event ?? makeChangedEvent()) as Record<string, unknown>,
    body: input.body ?? {},
  });
}

describe("registerSlackMessageEvents", () => {
  it.each([
    {
      name: "enqueues message_changed system events when dmPolicy is open",
      input: { overrides: { dmPolicy: "open" }, event: makeChangedEvent() },
      calls: 1,
    },
    {
      name: "blocks message_changed system events when dmPolicy is disabled",
      input: { overrides: { dmPolicy: "disabled" }, event: makeChangedEvent() },
      calls: 0,
    },
    {
      name: "blocks message_changed system events for unauthorized senders in allowlist mode",
      input: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
        event: makeChangedEvent({ user: "U1" }),
      },
      calls: 0,
    },
    {
      name: "blocks message_deleted system events for users outside channel users allowlist",
      input: {
        overrides: {
          dmPolicy: "open",
          channelType: "channel",
          channelUsers: ["U_OWNER"],
        },
        event: makeDeletedEvent({ channel: "C1", user: "U_ATTACKER" }),
      },
      calls: 0,
    },
    {
      name: "blocks thread_broadcast system events without an authenticated sender",
      input: {
        overrides: { dmPolicy: "open" },
        event: {
          ...makeThreadBroadcastEvent(),
          user: undefined,
          message: { ts: "123.456" },
        },
      },
      calls: 0,
    },
  ])("$name", async ({ input, calls }) => {
    await runMessageCase(input);
    expect(messageQueueMock).toHaveBeenCalledTimes(calls);
  });

  it("passes regular message events to the message handler", async () => {
    messageQueueMock.mockClear();
    messageAllowMock.mockReset().mockResolvedValue([]);
    const { handler, handleSlackMessage } = createMessageHandlers({ dmPolicy: "open" });
    expect(handler).toBeTruthy();

    await handler!({
      event: {
        type: "message",
        channel: "D1",
        user: "U1",
        text: "hello",
        ts: "123.456",
      },
      body: {},
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    expect(messageQueueMock).not.toHaveBeenCalled();
  });
});
