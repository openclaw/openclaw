import { describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "../context.js";
import { registerSlackReactionEvents } from "./reactions.js";

const enqueueSystemEventMock = vi.fn();
const readAllowFromStoreMock = vi.fn();

vi.mock("../../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
}));

type SlackReactionHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
}) => Promise<void>;

function createReactionContext(overrides?: {
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
  channelType?: "im" | "channel";
}) {
  let addedHandler: SlackReactionHandler | null = null;
  let removedHandler: SlackReactionHandler | null = null;
  const channelType = overrides?.channelType ?? "im";
  const app = {
    event: vi.fn((name: string, handler: SlackReactionHandler) => {
      if (name === "reaction_added") {
        addedHandler = handler;
      } else if (name === "reaction_removed") {
        removedHandler = handler;
      }
    }),
  };
  const ctx = {
    app,
    runtime: { error: vi.fn() },
    dmPolicy: overrides?.dmPolicy ?? "open",
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
  registerSlackReactionEvents({ ctx });
  return {
    ctx,
    getAddedHandler: () => addedHandler,
    getRemovedHandler: () => removedHandler,
  };
}

function makeReactionEvent(overrides?: { user?: string; channel?: string }) {
  return {
    type: "reaction_added",
    user: overrides?.user ?? "U1",
    reaction: "thumbsup",
    item: {
      type: "message",
      channel: overrides?.channel ?? "D1",
      ts: "123.456",
    },
    item_user: "UBOT",
  };
}

describe("registerSlackReactionEvents", () => {
  it("enqueues DM reaction system events when dmPolicy is open", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getAddedHandler } = createReactionContext({ dmPolicy: "open" });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makeReactionEvent(),
      body: {},
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("blocks DM reaction system events when dmPolicy is disabled", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getAddedHandler } = createReactionContext({ dmPolicy: "disabled" });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makeReactionEvent(),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("blocks DM reaction system events for unauthorized senders in allowlist mode", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getAddedHandler } = createReactionContext({
      dmPolicy: "allowlist",
      allowFrom: ["U2"],
    });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makeReactionEvent({ user: "U1" }),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("allows DM reaction system events for authorized senders in allowlist mode", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getAddedHandler } = createReactionContext({
      dmPolicy: "allowlist",
      allowFrom: ["U1"],
    });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makeReactionEvent({ user: "U1" }),
      body: {},
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("enqueues channel reaction events regardless of dmPolicy", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getRemovedHandler } = createReactionContext({
      dmPolicy: "disabled",
      channelType: "channel",
    });
    const removedHandler = getRemovedHandler();
    expect(removedHandler).toBeTruthy();

    await removedHandler!({
      event: {
        ...makeReactionEvent({ channel: "C1" }),
        type: "reaction_removed",
      },
      body: {},
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });
});
