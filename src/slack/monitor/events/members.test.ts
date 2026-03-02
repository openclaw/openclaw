import { describe, expect, it, vi } from "vitest";
import { registerSlackMemberEvents } from "./members.js";
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

type SlackMemberHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
}) => Promise<void>;

function createMembersContext(params?: {
  overrides?: SlackSystemEventTestOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = createSlackSystemEventTestHarness(params?.overrides);
  if (params?.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackMemberEvents({ ctx: harness.ctx, trackEvent: params?.trackEvent });
  return {
    getJoinedHandler: () =>
      harness.getHandler("member_joined_channel") as SlackMemberHandler | null,
    getLeftHandler: () => harness.getHandler("member_left_channel") as SlackMemberHandler | null,
  };
}

function makeMemberEvent(overrides?: { user?: string; channel?: string }) {
  return {
    type: "member_joined_channel",
    user: overrides?.user ?? "U1",
    channel: overrides?.channel ?? "D1",
    event_ts: "123.456",
  };
}

describe("registerSlackMemberEvents", () => {
  it("enqueues DM member events when dmPolicy is open", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getJoinedHandler } = createMembersContext({ overrides: { dmPolicy: "open" } });
    const joinedHandler = getJoinedHandler();
    expect(joinedHandler).toBeTruthy();

    await joinedHandler!({
      event: makeMemberEvent(),
      body: {},
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("blocks DM member events when dmPolicy is disabled", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getJoinedHandler } = createMembersContext({ overrides: { dmPolicy: "disabled" } });
    const joinedHandler = getJoinedHandler();
    expect(joinedHandler).toBeTruthy();

    await joinedHandler!({
      event: makeMemberEvent(),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("blocks DM member events for unauthorized senders in allowlist mode", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getJoinedHandler } = createMembersContext({
      overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
    });
    const joinedHandler = getJoinedHandler();
    expect(joinedHandler).toBeTruthy();

    await joinedHandler!({
      event: makeMemberEvent({ user: "U1" }),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("allows DM member events for authorized senders in allowlist mode", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getLeftHandler } = createMembersContext({
      overrides: { dmPolicy: "allowlist", allowFrom: ["U1"] },
    });
    const leftHandler = getLeftHandler();
    expect(leftHandler).toBeTruthy();

    await leftHandler!({
      event: {
        ...makeMemberEvent({ user: "U1" }),
        type: "member_left_channel",
      },
      body: {},
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("blocks channel member events for users outside channel users allowlist", async () => {
    enqueueSystemEventMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    const { getJoinedHandler } = createMembersContext({
      overrides: {
        dmPolicy: "open",
        channelType: "channel",
        channelUsers: ["U_OWNER"],
      },
    });
    const joinedHandler = getJoinedHandler();
    expect(joinedHandler).toBeTruthy();

    await joinedHandler!({
      event: makeMemberEvent({ channel: "C1", user: "U_ATTACKER" }),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    const { getJoinedHandler } = createMembersContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });
    const joinedHandler = getJoinedHandler();
    expect(joinedHandler).toBeTruthy();

    await joinedHandler!({
      event: makeMemberEvent(),
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted member events", async () => {
    const trackEvent = vi.fn();
    const { getJoinedHandler } = createMembersContext({ trackEvent });
    const joinedHandler = getJoinedHandler();
    expect(joinedHandler).toBeTruthy();

    await joinedHandler!({
      event: makeMemberEvent(),
      body: {},
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});
