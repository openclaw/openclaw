import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundDebounceCreateParams } from "../../auto-reply/inbound-debounce.js";
import type { SlackMessageEvent } from "../types.js";
import { createSlackMessageHandler } from "./message-handler.js";

const enqueueMock = vi.fn(async (_entry: unknown) => {});
const flushKeyMock = vi.fn(async (_key: string) => true);
const resolveThreadTsMock = vi.fn(async ({ message }: { message: Record<string, unknown> }) => ({
  ...message,
}));
const prepareSlackMessageMock = vi.fn(async (_args: unknown) => ({ ctxPayload: {} }));
const dispatchPreparedSlackMessageMock = vi.fn(async (_prepared: unknown) => {});

type SlackInboundEntry = {
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
};

let capturedDebouncerParams: InboundDebounceCreateParams<SlackInboundEntry> | null = null;

vi.mock("../../auto-reply/inbound-debounce.js", () => ({
  resolveInboundDebounceMs: () => 10,
  createInboundDebouncer: (params: InboundDebounceCreateParams<SlackInboundEntry>) => {
    capturedDebouncerParams = params;
    return {
      enqueue: (entry: unknown) => enqueueMock(entry),
      flushKey: (key: string) => flushKeyMock(key),
    };
  },
}));

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: (entry: { message: Record<string, unknown> }) => resolveThreadTsMock(entry),
  }),
}));

vi.mock("./message-handler/prepare.js", () => ({
  prepareSlackMessage: (args: unknown) => prepareSlackMessageMock(args),
}));

vi.mock("./message-handler/dispatch.js", () => ({
  dispatchPreparedSlackMessage: (prepared: unknown) => dispatchPreparedSlackMessageMock(prepared),
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

function createHandlerWithTracker(overrides?: {
  markMessageSeen?: (channel: string | undefined, ts: string | undefined) => boolean;
}) {
  const trackEvent = vi.fn();
  const handler = createSlackMessageHandler({
    ctx: createContext(overrides),
    account: { accountId: "default" } as Parameters<typeof createSlackMessageHandler>[0]["account"],
    trackEvent,
  });
  return { handler, trackEvent };
}

describe("createSlackMessageHandler", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
    flushKeyMock.mockClear();
    flushKeyMock.mockResolvedValue(true);
    resolveThreadTsMock.mockClear();
    prepareSlackMessageMock.mockClear();
    prepareSlackMessageMock.mockResolvedValue({ ctxPayload: {} });
    dispatchPreparedSlackMessageMock.mockClear();
    capturedDebouncerParams = null;
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
    const { handler, trackEvent } = createHandlerWithTracker({ markMessageSeen: () => true });

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
    const { handler, trackEvent } = createHandlerWithTracker();

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

  it("flushes pending top-level buffered keys before immediate non-debounce follow-ups", async () => {
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000100",
        text: "first buffered text",
      } as never,
      { source: "message" },
    );
    await handler(
      {
        type: "message",
        subtype: "file_share",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000200",
        text: "file follows",
        files: [{ id: "F1" }],
      } as never,
      { source: "message" },
    );

    expect(flushKeyMock).toHaveBeenCalledWith("slack:default:C111:1709000000.000100:U111");
  });

  it("queues immediate top-level follow-ups until pending buffered keys fully flush", async () => {
    flushKeyMock.mockResolvedValue(false);
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    const bufferedMessage = {
      type: "message",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000100",
      text: "first buffered text",
    } as SlackMessageEvent;
    const fileMessage = {
      type: "message",
      subtype: "file_share",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000200",
      text: "file follows",
      files: [{ id: "F1" }],
    } as SlackMessageEvent;

    await handler(bufferedMessage as never, { source: "message" });
    enqueueMock.mockClear();

    await handler(fileMessage as never, { source: "message" });

    expect(flushKeyMock).toHaveBeenCalledWith("slack:default:C111:1709000000.000100:U111");
    expect(enqueueMock).not.toHaveBeenCalled();

    await capturedDebouncerParams?.onFlush?.([
      { message: bufferedMessage, opts: { source: "message" } },
    ]);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith({
      message: expect.objectContaining({
        ts: "1709000000.000200",
        channel: "C111",
      }),
      opts: { source: "message" },
    });
  });

  it("releases queued top-level follow-ups when a pending buffered key exhausts retries", async () => {
    flushKeyMock.mockResolvedValue(false);
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    const bufferedMessage = {
      type: "message",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000100",
      text: "first buffered text",
    } as SlackMessageEvent;
    const fileMessage = {
      type: "message",
      subtype: "file_share",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000200",
      text: "file follows",
      files: [{ id: "F1" }],
    } as SlackMessageEvent;

    await handler(bufferedMessage as never, { source: "message" });
    enqueueMock.mockClear();

    await handler(fileMessage as never, { source: "message" });

    capturedDebouncerParams?.onError?.(
      Object.assign(new Error("inbound debounce flush retries exceeded"), {
        code: "INBOUND_DEBOUNCE_MAX_RETRIES_EXCEEDED",
      }),
      [{ message: bufferedMessage, opts: { source: "message" } }],
    );
    await Promise.resolve();

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith({
      message: expect.objectContaining({
        ts: "1709000000.000200",
        channel: "C111",
      }),
      opts: { source: "message" },
    });
  });
});
