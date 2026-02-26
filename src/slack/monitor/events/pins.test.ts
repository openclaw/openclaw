import { describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "../context.js";
import { registerSlackPinEvents } from "./pins.js";

const enqueueSystemEventMock = vi.fn();
const readAllowFromStoreMock = vi.fn();

vi.mock("../../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
}));

type SlackPinHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

function createPinContext(overrides?: {
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
  channelType?: "im" | "channel";
  channelUsers?: string[];
}) {
  let addedHandler: SlackPinHandler | null = null;
  let removedHandler: SlackPinHandler | null = null;
  const channelType = overrides?.channelType ?? "im";
  const app = {
    event: vi.fn((name: string, handler: SlackPinHandler) => {
      if (name === "pin_added") {
        addedHandler = handler;
      } else if (name === "pin_removed") {
        removedHandler = handler;
      }
    }),
  };
  const ctx = {
    app,
    runtime: { error: vi.fn() },
    dmEnabled: true,
    dmPolicy: overrides?.dmPolicy ?? "open",
    defaultRequireMention: true,
    channelsConfig: overrides?.channelUsers
      ? {
          C1: {
            users: overrides.channelUsers,
            allow: true,
          },
        }
      : undefined,
    groupPolicy: "open",
    allowFrom: overrides?.allowFrom ?? [],
    allowNameMatching: false,
    shouldDropMismatchedSlackEvent: vi.fn().mockReturnValue(false),
    isChannelAllowed: vi.fn().mockReturnValue(true),
    resolveChannelName: vi.fn().mockResolvedValue({
      name: channelType === "im" ? "direct" : "general",
      type: channelType,
    }),
    resolveUserName: vi.fn().mockResolvedValue({ name: "alice" }),
    resolveSlackSystemEventSessionKey: vi.fn().mockReturnValue("agent:main:main"),
  } as unknown as SlackMonitorContext;
  registerSlackPinEvents({ ctx });
  return {
    ctx,
    getAddedHandler: () => addedHandler,
    getRemovedHandler: () => removedHandler,
  };
}

function makePinEvent(overrides?: { user?: string; channel?: string }) {
  return {
    type: "pin_added",
    user: overrides?.user ?? "U1",
    channel_id: overrides?.channel ?? "D1",
    event_ts: "123.456",
    item: {
      type: "message",
      message: {
        ts: "123.456",
      },
    },
  };
}

describe("registerSlackPinEvents", () => {
  it("enqueues DM pin system events when dmPolicy is open", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getAddedHandler } = createPinContext({ dmPolicy: "open" });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makePinEvent(),
      body: {},
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("blocks DM pin system events when dmPolicy is disabled", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getAddedHandler } = createPinContext({ dmPolicy: "disabled" });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makePinEvent(),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("blocks DM pin system events for unauthorized senders in allowlist mode", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getAddedHandler } = createPinContext({
      dmPolicy: "allowlist",
      allowFrom: ["U2"],
    });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makePinEvent({ user: "U1" }),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("allows DM pin system events for authorized senders in allowlist mode", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getAddedHandler } = createPinContext({
      dmPolicy: "allowlist",
      allowFrom: ["U1"],
    });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makePinEvent({ user: "U1" }),
      body: {},
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("blocks channel pin events for users outside channel users allowlist", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getAddedHandler } = createPinContext({
      dmPolicy: "open",
      channelType: "channel",
      channelUsers: ["U_OWNER"],
    });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makePinEvent({ channel: "C1", user: "U_ATTACKER" }),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
});
