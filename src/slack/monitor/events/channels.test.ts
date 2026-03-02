import { describe, expect, it, vi } from "vitest";
import { registerSlackChannelEvents } from "./channels.js";
import { createSlackSystemEventTestHarness } from "./system-event-test-harness.js";

const enqueueSystemEventMock = vi.fn();

vi.mock("../../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

type SlackChannelHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
}) => Promise<void>;

function createChannelContext(params?: {
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = createSlackSystemEventTestHarness();
  if (params?.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackChannelEvents({ ctx: harness.ctx, trackEvent: params?.trackEvent });
  return {
    getCreatedHandler: () => harness.getHandler("channel_created") as SlackChannelHandler | null,
  };
}

describe("registerSlackChannelEvents", () => {
  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    const { getCreatedHandler } = createChannelContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });
    const createdHandler = getCreatedHandler();
    expect(createdHandler).toBeTruthy();

    await createdHandler!({
      event: {
        channel: { id: "C1", name: "general" },
      },
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("tracks accepted events", async () => {
    const trackEvent = vi.fn();
    const { getCreatedHandler } = createChannelContext({ trackEvent });
    const createdHandler = getCreatedHandler();
    expect(createdHandler).toBeTruthy();

    await createdHandler!({
      event: {
        channel: { id: "C1", name: "general" },
      },
      body: {},
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });
});
