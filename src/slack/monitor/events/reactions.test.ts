import { describe, expect, it, vi } from "vitest";
import { registerSlackReactionEvents } from "./reactions.js";
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

type SlackReactionHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
}) => Promise<void>;

function createReactionContext(params?: {
  overrides?: SlackSystemEventTestOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = createSlackSystemEventTestHarness(params?.overrides);
  if (params?.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackReactionEvents({ ctx: harness.ctx, trackEvent: params?.trackEvent });
  return {
    getAddedHandler: () => harness.getHandler("reaction_added") as SlackReactionHandler | null,
    getRemovedHandler: () => harness.getHandler("reaction_removed") as SlackReactionHandler | null,
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
    const { getAddedHandler } = createReactionContext({ overrides: { dmPolicy: "open" } });
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
    const { getAddedHandler } = createReactionContext({ overrides: { dmPolicy: "disabled" } });
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
      overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
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
      overrides: { dmPolicy: "allowlist", allowFrom: ["U1"] },
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
      overrides: { dmPolicy: "disabled", channelType: "channel" },
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

  it("blocks channel reaction events for users outside channel users allowlist", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getAddedHandler } = createReactionContext({
      overrides: {
        dmPolicy: "open",
        channelType: "channel",
        channelUsers: ["U_OWNER"],
      },
    });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makeReactionEvent({ channel: "C1", user: "U_ATTACKER" }),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    const { getAddedHandler } = createReactionContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makeReactionEvent(),
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted message reactions", async () => {
    const trackEvent = vi.fn();
    const { getAddedHandler } = createReactionContext({ trackEvent });
    const addedHandler = getAddedHandler();
    expect(addedHandler).toBeTruthy();

    await addedHandler!({
      event: makeReactionEvent(),
      body: {},
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});
