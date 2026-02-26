import { describe, expect, it, vi } from "vitest";
import { registerSlackPinEvents } from "./pins.js";
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

type SlackPinHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

function createPinContext(overrides?: SlackSystemEventTestOverrides) {
  const harness = createSlackSystemEventTestHarness(overrides);
  registerSlackPinEvents({ ctx: harness.ctx });
  return {
    getAddedHandler: () => harness.getHandler("pin_added") as SlackPinHandler | null,
    getRemovedHandler: () => harness.getHandler("pin_removed") as SlackPinHandler | null,
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
