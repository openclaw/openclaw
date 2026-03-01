import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackMessageHandler } from "./message-handler.js";

const enqueueMock = vi.fn(async (_entry: unknown) => {});
const resolveThreadTsMock = vi.fn(async ({ message }: { message: Record<string, unknown> }) => ({
  ...message,
}));

vi.mock("../../auto-reply/inbound-debounce.js", () => ({
  resolveInboundDebounceMs: () => 10,
  createInboundDebouncer: () => ({
    enqueue: (entry: unknown) => enqueueMock(entry),
  }),
}));

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: (entry: { message: Record<string, unknown> }) => resolveThreadTsMock(entry),
  }),
}));

function createContext(overrides?: {
  markMessageSeen?: (channel: string | undefined, ts: string | undefined) => boolean;
}) {
  return {
    cfg: {},
    accountId: "default",
    app: {
      client: {},
    },
    runtime: {},
    markMessageSeen: (channel: string | undefined, ts: string | undefined) =>
      overrides?.markMessageSeen?.(channel, ts) ?? false,
  } as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
}

describe("createSlackMessageHandler", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
    resolveThreadTsMock.mockClear();
  });

  it("does not track invalid non-message events from the message stream", async () => {
    const trackEvent = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
      trackEvent,
    });

    await handler(
      {
        type: "reaction_added",
        channel: "D1",
        ts: "123.456",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("does not track duplicate messages that are already seen", async () => {
    const trackEvent = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext({ markMessageSeen: () => true }),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
      trackEvent,
    });

    await handler(
      {
        type: "message",
        channel: "D1",
        ts: "123.456",
        text: "hello",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("tracks accepted non-duplicate messages", async () => {
    const trackEvent = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
      trackEvent,
    });

    await handler(
      {
        type: "message",
        channel: "D1",
        ts: "123.456",
        text: "hello",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});
