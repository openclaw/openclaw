import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundDebounceCreateParams } from "../../auto-reply/inbound-debounce.js";
import type { SlackMessageEvent } from "../types.js";
import {
  createSlackMessageHandler,
  MAX_PENDING_TOP_LEVEL_IMMEDIATE_ENTRIES_PER_CONVERSATION,
  MAX_PENDING_TOP_LEVEL_IMMEDIATE_ENTRIES_TOTAL,
} from "./message-handler.js";

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
  runtimeError?: (message: string) => void;
}) {
  return {
    cfg: {},
    accountId: "default",
    app: {
      client: {},
    },
    runtime: {
      error: overrides?.runtimeError,
    },
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

  it("queues non-priority top-level follow-ups until pending buffered keys fully flush", async () => {
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
    const immediateMessage = {
      type: "message",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000200",
      text: "",
    } as SlackMessageEvent;

    await handler(bufferedMessage as never, { source: "message" });
    enqueueMock.mockClear();

    await handler(immediateMessage as never, { source: "message" });

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
    const immediateMessage = {
      type: "message",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000200",
      text: "",
    } as SlackMessageEvent;

    await handler(bufferedMessage as never, { source: "message" });
    enqueueMock.mockClear();

    await handler(immediateMessage as never, { source: "message" });

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

  it("flushes priority top-level followers immediately while older keys are still retrying", async () => {
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
    const priorityMessage = {
      type: "message",
      channel: "C111",
      user: "U111",
      ts: "1709000000.000200",
      text: "/stop",
    } as SlackMessageEvent;

    await handler(bufferedMessage as never, { source: "message" });
    enqueueMock.mockClear();

    await handler(priorityMessage as never, { source: "message" });

    expect(flushKeyMock).toHaveBeenCalledWith("slack:default:C111:1709000000.000100:U111");
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith({
      message: expect.objectContaining({
        ts: "1709000000.000200",
        channel: "C111",
        text: "/stop",
      }),
      opts: { source: "message" },
    });
  });

  it("bypasses the per-conversation immediate queue when it reaches the backlog cap", async () => {
    flushKeyMock.mockResolvedValue(false);
    const runtimeError = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext({ runtimeError }),
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

    await handler(bufferedMessage as never, { source: "message" });
    enqueueMock.mockClear();

    for (
      let index = 0;
      index < MAX_PENDING_TOP_LEVEL_IMMEDIATE_ENTRIES_PER_CONVERSATION;
      index += 1
    ) {
      await handler(
        {
          type: "message",
          channel: "C111",
          user: "U111",
          ts: `1709000000.${String(200 + index).padStart(6, "0")}`,
          text: "",
        } as never,
        { source: "message" },
      );
    }

    expect(enqueueMock).not.toHaveBeenCalled();

    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.999999",
        text: "",
      } as never,
      { source: "message" },
    );

    expect(runtimeError).toHaveBeenCalledWith(
      "slack inbound immediate backlog overflow; bypassing queue to cap memory growth",
    );
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenLastCalledWith({
      message: expect.objectContaining({
        ts: "1709000000.999999",
        channel: "C111",
      }),
      opts: { source: "message" },
    });

    capturedDebouncerParams?.onError?.(
      Object.assign(new Error("inbound debounce flush retries exceeded"), {
        code: "INBOUND_DEBOUNCE_MAX_RETRIES_EXCEEDED",
      }),
      [{ message: bufferedMessage, opts: { source: "message" } }],
    );
    await vi.waitFor(() => {
      expect(enqueueMock).toHaveBeenCalledTimes(
        MAX_PENDING_TOP_LEVEL_IMMEDIATE_ENTRIES_PER_CONVERSATION + 1,
      );
    });

    expect(enqueueMock).toHaveBeenCalledTimes(
      MAX_PENDING_TOP_LEVEL_IMMEDIATE_ENTRIES_PER_CONVERSATION + 1,
    );
  });

  it("bypasses the immediate queue when the global backlog cap is reached", async () => {
    flushKeyMock.mockResolvedValue(false);
    const runtimeError = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext({ runtimeError }),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    const conversations = [
      { channel: "C111", user: "U111", baseTs: 100_000 },
      { channel: "C222", user: "U222", baseTs: 200_000 },
      { channel: "C333", user: "U333", baseTs: 300_000 },
    ] as const;

    for (const [index, conversation] of conversations.entries()) {
      await handler(
        {
          type: "message",
          channel: conversation.channel,
          user: conversation.user,
          ts: `1709000000.${String(conversation.baseTs + index).padStart(6, "0")}`,
          text: "first buffered text",
        } as never,
        { source: "message" },
      );
    }
    enqueueMock.mockClear();

    for (let index = 0; index < MAX_PENDING_TOP_LEVEL_IMMEDIATE_ENTRIES_TOTAL; index += 1) {
      const conversation = conversations[index % 2];
      await handler(
        {
          type: "message",
          channel: conversation.channel,
          user: conversation.user,
          ts: `1709000000.${String(conversation.baseTs + 1000 + index).padStart(6, "0")}`,
          text: "",
        } as never,
        { source: "message" },
      );
    }

    expect(enqueueMock).not.toHaveBeenCalled();

    await handler(
      {
        type: "message",
        channel: conversations[2].channel,
        user: conversations[2].user,
        ts: "1709000000.999998",
        text: "",
      } as never,
      { source: "message" },
    );

    expect(runtimeError).toHaveBeenCalledWith(
      "slack inbound immediate backlog overflow; bypassing queue to cap memory growth",
    );
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenLastCalledWith({
      message: expect.objectContaining({
        ts: "1709000000.999998",
        channel: "C333",
      }),
      opts: { source: "message" },
    });
  });
});
