import { beforeEach, describe, expect, it, vi } from "vitest";

const prepareSlackMessageMock =
  vi.fn<
    (params: {
      opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
    }) => Promise<unknown>
  >();
const dispatchPreparedSlackMessageMock = vi.fn<(prepared: unknown) => Promise<void>>();

vi.mock("../../channels/inbound-debounce-policy.js", () => ({
  shouldDebounceTextInbound: () => false,
  createChannelInboundDebouncer: (params: {
    onFlush: (
      entries: Array<{
        message: Record<string, unknown>;
        opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
      }>,
    ) => Promise<void>;
  }) => ({
    debounceMs: 0,
    debouncer: {
      enqueue: async (entry: {
        message: Record<string, unknown>;
        opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
      }) => {
        await params.onFlush([entry]);
      },
      flushKey: async (_key: string) => {},
    },
  }),
}));

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: async ({ message }: { message: Record<string, unknown> }) => message,
  }),
}));

vi.mock("./message-handler/prepare.js", () => ({
  prepareSlackMessage: (
    params: Parameters<typeof prepareSlackMessageMock>[0],
  ): ReturnType<typeof prepareSlackMessageMock> => prepareSlackMessageMock(params),
}));

vi.mock("./message-handler/dispatch.js", () => ({
  dispatchPreparedSlackMessage: (
    prepared: Parameters<typeof dispatchPreparedSlackMessageMock>[0],
  ): ReturnType<typeof dispatchPreparedSlackMessageMock> =>
    dispatchPreparedSlackMessageMock(prepared),
}));

import { createSlackMessageHandler } from "./message-handler.js";

function createMarkMessageSeen() {
  const seen = new Set<string>();
  return (channel: string | undefined, ts: string | undefined) => {
    if (!channel || !ts) {
      return false;
    }
    const key = `${channel}:${ts}`;
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
    return false;
  };
}

describe("createSlackMessageHandler app_mention race handling", () => {
  beforeEach(() => {
    prepareSlackMessageMock.mockReset();
    dispatchPreparedSlackMessageMock.mockReset();
  });

  it("allows a single app_mention retry when message event was dropped before dispatch", async () => {
    prepareSlackMessageMock.mockImplementation(async ({ opts }) => {
      if (opts.source === "message") {
        return null;
      }
      return { ctxPayload: {} };
    });

    const handler = createSlackMessageHandler({
      ctx: {
        cfg: {},
        accountId: "default",
        app: { client: {} },
        runtime: {},
        markMessageSeen: createMarkMessageSeen(),
      } as Parameters<typeof createSlackMessageHandler>[0]["ctx"],
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    await handler(
      { type: "message", channel: "C1", ts: "1700000000.000100", text: "hello" } as never,
      { source: "message" },
    );
    await handler(
      {
        type: "app_mention",
        channel: "C1",
        ts: "1700000000.000100",
        text: "<@U_BOT> hello",
      } as never,
      { source: "app_mention", wasMentioned: true },
    );
    await handler(
      {
        type: "app_mention",
        channel: "C1",
        ts: "1700000000.000100",
        text: "<@U_BOT> hello",
      } as never,
      { source: "app_mention", wasMentioned: true },
    );

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("allows app_mention while message handling is still in-flight, then keeps later duplicates deduped", async () => {
    let resolveMessagePrepare: ((value: unknown) => void) | undefined;
    const messagePrepare = new Promise<unknown>((resolve) => {
      resolveMessagePrepare = resolve;
    });
    prepareSlackMessageMock.mockImplementation(async ({ opts }) => {
      if (opts.source === "message") {
        return messagePrepare;
      }
      return { ctxPayload: {} };
    });

    const handler = createSlackMessageHandler({
      ctx: {
        cfg: {},
        accountId: "default",
        app: { client: {} },
        runtime: {},
        markMessageSeen: createMarkMessageSeen(),
      } as Parameters<typeof createSlackMessageHandler>[0]["ctx"],
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    const messagePending = handler(
      { type: "message", channel: "C1", ts: "1700000000.000150", text: "hello" } as never,
      { source: "message" },
    );
    await Promise.resolve();

    await handler(
      {
        type: "app_mention",
        channel: "C1",
        ts: "1700000000.000150",
        text: "<@U_BOT> hello",
      } as never,
      { source: "app_mention", wasMentioned: true },
    );

    resolveMessagePrepare?.(null);
    await messagePending;

    await handler(
      {
        type: "app_mention",
        channel: "C1",
        ts: "1700000000.000150",
        text: "<@U_BOT> hello",
      } as never,
      { source: "app_mention", wasMentioned: true },
    );

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses message dispatch when app_mention already dispatched during in-flight race", async () => {
    let resolveMessagePrepare: ((value: unknown) => void) | undefined;
    const messagePrepare = new Promise<unknown>((resolve) => {
      resolveMessagePrepare = resolve;
    });
    prepareSlackMessageMock.mockImplementation(async ({ opts }) => {
      if (opts.source === "message") {
        return messagePrepare;
      }
      return { ctxPayload: {} };
    });

    const handler = createSlackMessageHandler({
      ctx: {
        cfg: {},
        accountId: "default",
        app: { client: {} },
        runtime: {},
        markMessageSeen: createMarkMessageSeen(),
      } as Parameters<typeof createSlackMessageHandler>[0]["ctx"],
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    const messagePending = handler(
      { type: "message", channel: "C1", ts: "1700000000.000175", text: "hello" } as never,
      { source: "message" },
    );
    await Promise.resolve();

    await handler(
      {
        type: "app_mention",
        channel: "C1",
        ts: "1700000000.000175",
        text: "<@U_BOT> hello",
      } as never,
      { source: "app_mention", wasMentioned: true },
    );

    resolveMessagePrepare?.({ ctxPayload: {} });
    await messagePending;

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("keeps app_mention deduped when message event already dispatched", async () => {
    prepareSlackMessageMock.mockResolvedValue({ ctxPayload: {} });

    const handler = createSlackMessageHandler({
      ctx: {
        cfg: {},
        accountId: "default",
        app: { client: {} },
        runtime: {},
        markMessageSeen: createMarkMessageSeen(),
      } as Parameters<typeof createSlackMessageHandler>[0]["ctx"],
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    await handler(
      { type: "message", channel: "C1", ts: "1700000000.000200", text: "hello" } as never,
      { source: "message" },
    );
    await handler(
      {
        type: "app_mention",
        channel: "C1",
        ts: "1700000000.000200",
        text: "<@U_BOT> hello",
      } as never,
      { source: "app_mention", wasMentioned: true },
    );

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });
});
