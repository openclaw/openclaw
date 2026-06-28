import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemEvent } from "../../infra/system-events.js";

const mocks = vi.hoisted(() => ({
  emitContinuationQueueDrainSpan: vi.fn(),
  peekSystemEventEntries: vi.fn(),
  consumeSelectedSystemEventEntries: vi.fn(),
  buildChannelSummary: vi.fn(async () => []),
}));

vi.mock("../../infra/continuation-tracer.js", () => ({
  emitContinuationQueueDrainSpan: mocks.emitContinuationQueueDrainSpan,
}));

vi.mock("../../infra/system-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/system-events.js")>();
  return {
    ...actual,
    peekSystemEventEntries: mocks.peekSystemEventEntries,
    consumeSelectedSystemEventEntries: mocks.consumeSelectedSystemEventEntries,
  };
});

vi.mock("../../infra/channel-summary.js", () => ({
  buildChannelSummary: mocks.buildChannelSummary,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
  },
}));

const { drainFormattedSystemEvents } = await import("./session-system-events.js");

describe("drainFormattedSystemEvents trace context", () => {
  beforeEach(() => {
    mocks.emitContinuationQueueDrainSpan.mockClear();
    mocks.peekSystemEventEntries.mockReset();
    mocks.consumeSelectedSystemEventEntries.mockReset();
    mocks.buildChannelSummary.mockClear();
  });

  it("parents the queue-drain span to the first traced drained entry", async () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const events: SystemEvent[] = [
      { text: "ordinary event", ts: 1 },
      { text: "[continuation:resume] traced event", ts: 2, traceparent },
      {
        text: "[continuation:resume] later traced event",
        ts: 3,
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    ];
    mocks.peekSystemEventEntries.mockReturnValue(events);
    mocks.consumeSelectedSystemEventEntries.mockReturnValue(events);

    await drainFormattedSystemEvents({
      cfg: {},
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(mocks.emitContinuationQueueDrainSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        drainedCount: 3,
        drainedContinuationCount: 2,
        traceparent,
      }),
    );
  });

  it("omits traceparent for untraced drained entries", async () => {
    const events: SystemEvent[] = [{ text: "[continuation:resume] untraced", ts: 1 }];
    mocks.peekSystemEventEntries.mockReturnValue(events);
    mocks.consumeSelectedSystemEventEntries.mockReturnValue(events);

    await drainFormattedSystemEvents({
      cfg: {},
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(mocks.emitContinuationQueueDrainSpan).toHaveBeenCalledWith(
      expect.not.objectContaining({ traceparent: expect.any(String) }),
    );
  });
});
