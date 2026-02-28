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

function createMembersContext(overrides?: SlackSystemEventTestOverrides) {
  const harness = createSlackSystemEventTestHarness(overrides);
  registerSlackMemberEvents({ ctx: harness.ctx });
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
    const { getJoinedHandler } = createMembersContext({ dmPolicy: "open" });
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
    const { getJoinedHandler } = createMembersContext({ dmPolicy: "disabled" });
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
      dmPolicy: "allowlist",
      allowFrom: ["U2"],
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
      dmPolicy: "allowlist",
      allowFrom: ["U1"],
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
      dmPolicy: "open",
      channelType: "channel",
      channelUsers: ["U_OWNER"],
    });
    const joinedHandler = getJoinedHandler();
    expect(joinedHandler).toBeTruthy();

    await joinedHandler!({
      event: makeMemberEvent({ channel: "C1", user: "U_ATTACKER" }),
      body: {},
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
});
