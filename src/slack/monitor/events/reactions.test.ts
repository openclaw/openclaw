import { describe, expect, it, vi } from "vitest";
import { registerSlackReactionEvents } from "./reactions.js";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventTestOverrides,
} from "./system-event-test-harness.js";

const reactionQueueMock = vi.fn();
const reactionAllowMock = vi.fn();

vi.mock("../../../infra/system-events.js", () => {
  return {
    enqueueSystemEvent: (...args: unknown[]) => reactionQueueMock(...args),
  };
});

vi.mock("../../../pairing/pairing-store.js", () => {
  return {
    readChannelAllowFromStore: (...args: unknown[]) => reactionAllowMock(...args),
  };
});

type ReactionHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

type ReactionRunInput = {
  handler?: "added" | "removed";
  overrides?: SlackSystemEventTestOverrides;
  event?: Record<string, unknown>;
  body?: unknown;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
};

function buildReactionEvent(overrides?: { user?: string; channel?: string }) {
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

function createReactionHandlers(params: {
  overrides?: SlackSystemEventTestOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = createSlackSystemEventTestHarness(params.overrides);
  if (params.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackReactionEvents({ ctx: harness.ctx, trackEvent: params.trackEvent });
  return {
    added: harness.getHandler("reaction_added") as ReactionHandler | null,
    removed: harness.getHandler("reaction_removed") as ReactionHandler | null,
  };
}

async function executeReactionCase(input: ReactionRunInput = {}) {
  reactionQueueMock.mockClear();
  reactionAllowMock.mockReset().mockResolvedValue([]);
  const handlers = createReactionHandlers({
    overrides: input.overrides,
    trackEvent: input.trackEvent,
    shouldDropMismatchedSlackEvent: input.shouldDropMismatchedSlackEvent,
  });
  const handler = handlers[input.handler ?? "added"];
  expect(handler).toBeTruthy();
  await handler!({
    event: (input.event ?? buildReactionEvent()) as Record<string, unknown>,
    body: input.body ?? {},
  });
}

describe("registerSlackReactionEvents", () => {
  it.each([
    {
      name: "enqueues DM reaction system events when dmPolicy is open",
      args: { overrides: { dmPolicy: "open" } },
      expectedCalls: 1,
    },
    {
      name: "blocks DM reaction system events when dmPolicy is disabled",
      args: { overrides: { dmPolicy: "disabled" } },
      expectedCalls: 0,
    },
    {
      name: "blocks DM reaction system events for unauthorized senders in allowlist mode",
      args: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 0,
    },
    {
      name: "allows DM reaction system events for authorized senders in allowlist mode",
      args: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U1"] },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 1,
    },
    {
      name: "enqueues channel reaction events regardless of dmPolicy",
      args: {
        handler: "removed" as const,
        overrides: { dmPolicy: "disabled", channelType: "channel" },
        event: {
          ...buildReactionEvent({ channel: "C1" }),
          type: "reaction_removed",
        },
      },
      expectedCalls: 1,
    },
    {
      name: "blocks channel reaction events for users outside channel users allowlist",
      args: {
        overrides: {
          dmPolicy: "open",
          channelType: "channel",
          channelUsers: ["U_OWNER"],
        },
        event: buildReactionEvent({ channel: "C1", user: "U_ATTACKER" }),
      },
      expectedCalls: 0,
    },
  ])("$name", async ({ args, expectedCalls }) => {
    await executeReactionCase(args);
    expect(reactionQueueMock).toHaveBeenCalledTimes(expectedCalls);
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await executeReactionCase({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted message reactions", async () => {
    const trackEvent = vi.fn();
    await executeReactionCase({ trackEvent });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });
});
