import { describe, expect, it, vi } from "vitest";
import { registerSlackMessageEvents } from "./messages.js";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventTestOverrides,
} from "./system-event-test-harness.js";

const enqueueSystemEventMock = vi.fn();
const readAllowFromStoreMock = vi.fn();

vi.mock("../../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
}));

type SlackMessageHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
}) => Promise<void>;

function createMessagesContext(overrides?: SlackSystemEventTestOverrides) {
  const harness = createSlackSystemEventTestHarness(overrides);
  const handleSlackMessage = vi.fn(async () => {});
  registerSlackMessageEvents({
    ctx: harness.ctx,
    handleSlackMessage,
  });
  return {
    getMessageHandler: () => harness.getHandler("message") as SlackMessageHandler | null,
    handleSlackMessage,
  };
}

function makeChangedEvent(overrides?: { channel?: string; user?: string }) {
  const user = overrides?.user ?? "U1";
  return {
    type: "message",
    subtype: "message_changed",
    channel: overrides?.channel ?? "D1",
    message: {
      ts: "123.456",
      user,
    },
    previous_message: {
      ts: "123.450",
      user,
    },
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
    message: {
      ts: "123.456",
      user,
    },
    event_ts: "123.456",
  };
}

describe("registerSlackMessageEvents", () => {
  it("enqueues message_changed system events when dmPolicy is open", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getMessageHandler } = createMessagesContext({ dmPolicy: "open" });
    const messageHandler = getMessageHandler();
    expect(messageHandler).toBeTruthy();

    await messageHandler!({
      event: makeChangedEvent(),
      body: {},
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("blocks message_changed system events when dmPolicy is disabled", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getMessageHandler } = createMessagesContext({ dmPolicy: "disabled" });
    const messageHandler = getMessageHandler();
    expect(messageHandler).toBeTruthy();

    await messageHandler!({
      event: makeChangedEvent(),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("blocks message_changed system events for unauthorized senders in allowlist mode", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getMessageHandler } = createMessagesContext({
      dmPolicy: "allowlist",
      allowFrom: ["U2"],
    });
    const messageHandler = getMessageHandler();
    expect(messageHandler).toBeTruthy();

    await messageHandler!({
      event: makeChangedEvent({ user: "U1" }),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("blocks message_deleted system events for users outside channel users allowlist", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getMessageHandler } = createMessagesContext({
      dmPolicy: "open",
      channelType: "channel",
      channelUsers: ["U_OWNER"],
    });
    const messageHandler = getMessageHandler();
    expect(messageHandler).toBeTruthy();

    await messageHandler!({
      event: makeDeletedEvent({ channel: "C1", user: "U_ATTACKER" }),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("blocks thread_broadcast system events without an authenticated sender", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getMessageHandler } = createMessagesContext({ dmPolicy: "open" });
    const messageHandler = getMessageHandler();
    expect(messageHandler).toBeTruthy();

    await messageHandler!({
      event: {
        ...makeThreadBroadcastEvent(),
        user: undefined,
        message: {
          ts: "123.456",
        },
      },
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("passes regular message events to the message handler", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getMessageHandler, handleSlackMessage } = createMessagesContext({
      dmPolicy: "open",
    });
    const messageHandler = getMessageHandler();
    expect(messageHandler).toBeTruthy();

    await messageHandler!({
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
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
});
