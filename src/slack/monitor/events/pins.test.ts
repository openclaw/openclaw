import { describe, expect, it, vi } from "vitest";
import { registerSlackPinEvents } from "./pins.js";
import {
  createSlackSystemEventTestHarness as buildPinHarness,
  type SlackSystemEventTestOverrides as PinOverrides,
} from "./system-event-test-harness.js";

const pinEnqueueMock = vi.hoisted(() => vi.fn());
const pinAllowMock = vi.hoisted(() => vi.fn());

vi.mock("../../../infra/system-events.js", () => {
  return { enqueueSystemEvent: pinEnqueueMock };
});
vi.mock("../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: pinAllowMock,
}));

type PinHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

type PinCase = {
  body?: unknown;
  event?: Record<string, unknown>;
  handler?: "added" | "removed";
  overrides?: PinOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
};

function makePinEvent(overrides?: { channel?: string; user?: string }) {
  return {
    type: "pin_added",
    user: overrides?.user ?? "U1",
    channel_id: overrides?.channel ?? "D1",
    event_ts: "123.456",
    item: {
      type: "message",
      message: { ts: "123.456" },
    },
  };
}

function installPinHandlers(args: {
  overrides?: PinOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = buildPinHarness(args.overrides);
  if (args.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = args.shouldDropMismatchedSlackEvent;
  }
  registerSlackPinEvents({ ctx: harness.ctx, trackEvent: args.trackEvent });
  return {
    added: harness.getHandler("pin_added") as PinHandler | null,
    removed: harness.getHandler("pin_removed") as PinHandler | null,
  };
}

async function runPinCase(input: PinCase = {}): Promise<void> {
  pinEnqueueMock.mockClear();
  pinAllowMock.mockReset().mockResolvedValue([]);
  const { added, removed } = installPinHandlers({
    overrides: input.overrides,
    trackEvent: input.trackEvent,
    shouldDropMismatchedSlackEvent: input.shouldDropMismatchedSlackEvent,
  });
  const handlerKey = input.handler ?? "added";
  const handler = handlerKey === "removed" ? removed : added;
  expect(handler).toBeTruthy();
  const event = (input.event ?? makePinEvent()) as Record<string, unknown>;
  const body = input.body ?? {};
  await handler!({
    body,
    event,
  });
}

describe("registerSlackPinEvents", () => {
  it.each([
    ["enqueues DM pin system events when dmPolicy is open", { overrides: { dmPolicy: "open" } }, 1],
    [
      "blocks DM pin system events when dmPolicy is disabled",
      { overrides: { dmPolicy: "disabled" } },
      0,
    ],
    [
      "blocks DM pin system events for unauthorized senders in allowlist mode",
      {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
        event: makePinEvent({ user: "U1" }),
      },
      0,
    ],
    [
      "allows DM pin system events for authorized senders in allowlist mode",
      {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U1"] },
        event: makePinEvent({ user: "U1" }),
      },
      1,
    ],
    [
      "blocks channel pin events for users outside channel users allowlist",
      {
        overrides: {
          dmPolicy: "open",
          channelType: "channel",
          channelUsers: ["U_OWNER"],
        },
        event: makePinEvent({ channel: "C1", user: "U_ATTACKER" }),
      },
      0,
    ],
  ])("%s", async (_name, args: PinCase, expectedCalls: number) => {
    await runPinCase(args);
    expect(pinEnqueueMock).toHaveBeenCalledTimes(expectedCalls);
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await runPinCase({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted pin events", async () => {
    const trackEvent = vi.fn();
    await runPinCase({ trackEvent });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});
