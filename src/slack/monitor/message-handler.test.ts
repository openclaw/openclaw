import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import { createSlackMessageHandler } from "./message-handler.js";

const enqueueCalls: Array<{
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention" };
}> = [];
const prepareMock = vi.fn(async ({ message }: { message: SlackMessageEvent }) => ({
  ctxPayload: {},
  message,
}));
const dispatchMock = vi.fn(async () => {});

vi.mock("../../auto-reply/inbound-debounce.js", () => ({
  resolveInboundDebounceMs: () => 0,
  createInboundDebouncer: (params: {
    onFlush: (
      entries: Array<{ message: SlackMessageEvent; opts: { source: "message" | "app_mention" } }>,
    ) => Promise<void>;
  }) => ({
    enqueue: async (entry: {
      message: SlackMessageEvent;
      opts: { source: "message" | "app_mention" };
    }) => {
      enqueueCalls.push(entry);
      await params.onFlush([entry]);
    },
  }),
}));

vi.mock("./message-handler/prepare.js", () => ({
  prepareSlackMessage: (...args: unknown[]) => prepareMock(...args),
}));

vi.mock("./message-handler/dispatch.js", () => ({
  dispatchPreparedSlackMessage: (...args: unknown[]) => dispatchMock(...args),
}));

function createCtx(params?: {
  replies?: Array<{
    messages?: Array<SlackMessageEvent>;
    response_metadata?: { next_cursor?: string };
  }>;
}) {
  const replyQueue = [...(params?.replies ?? [])];
  const conversationsReplies = vi.fn(async () => replyQueue.shift() ?? { messages: [] });

  return {
    cfg: { channels: { slack: { enabled: true } } },
    accountId: "default",
    app: {
      client: {
        conversations: {
          replies: conversationsReplies,
        },
      },
    },
    markMessageSeen: vi.fn(() => false),
    runtime: {
      error: vi.fn(),
    },
  } as unknown as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
}

const account: ResolvedSlackAccount = {
  accountId: "default",
  enabled: true,
  botTokenSource: "config",
  appTokenSource: "config",
  config: {},
};

describe("createSlackMessageHandler", () => {
  beforeEach(() => {
    enqueueCalls.length = 0;
    prepareMock.mockClear();
    dispatchMock.mockClear();
  });

  it("ignores message_changed/message_deleted even when thread_ts exists", async () => {
    await withStateDirEnv("openclaw-slack-handler-", async () => {
      const ctx = createCtx();
      const handler = createSlackMessageHandler({ ctx, account });

      await handler(
        {
          type: "message",
          subtype: "message_changed",
          channel: "D1",
          thread_ts: "100.000",
          ts: "101.000",
          text: "edited",
        } as SlackMessageEvent,
        { source: "message" },
      );

      await handler(
        {
          type: "message",
          subtype: "message_deleted",
          channel: "D1",
          thread_ts: "100.000",
          ts: "101.001",
          text: "deleted",
        } as SlackMessageEvent,
        { source: "message" },
      );

      expect(enqueueCalls).toHaveLength(0);
      expect(prepareMock).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(ctx.app.client.conversations.replies).not.toHaveBeenCalled();
    });
  });

  it("backfills message_replied with pagination and ingests only plain user replies", async () => {
    await withStateDirEnv("openclaw-slack-handler-", async () => {
      const ctx = createCtx({
        replies: [
          {
            messages: [
              {
                type: "message",
                channel: "D1",
                ts: "100.000",
                thread_ts: "100.000",
                text: "parent",
              },
              {
                type: "message",
                channel: "D1",
                ts: "100.100",
                thread_ts: "100.000",
                user: "U1",
                text: "reply one",
              },
              {
                type: "message",
                subtype: "message_deleted",
                channel: "D1",
                ts: "100.101",
                thread_ts: "100.000",
                text: "deleted",
              },
            ],
            response_metadata: { next_cursor: "cursor-2" },
          },
          {
            messages: [
              {
                type: "message",
                channel: "D1",
                ts: "100.200",
                thread_ts: "100.000",
                user: "U2",
                text: "reply two",
              },
            ],
            response_metadata: { next_cursor: "" },
          },
        ],
      });
      const handler = createSlackMessageHandler({ ctx, account });

      await handler(
        {
          type: "message",
          subtype: "message_replied",
          channel: "D1",
          ts: "100.150",
          event_ts: "100.151",
          message: {
            type: "message",
            channel: "D1",
            ts: "100.150",
            thread_ts: "100.000",
            latest_reply: "100.200",
          },
        } as unknown as SlackMessageEvent,
        { source: "message" },
      );

      expect(ctx.app.client.conversations.replies).toHaveBeenCalledTimes(2);
      expect(ctx.app.client.conversations.replies).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ cursor: undefined, limit: 200 }),
      );
      expect(ctx.app.client.conversations.replies).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: "cursor-2", limit: 200 }),
      );

      expect(enqueueCalls).toHaveLength(2);
      expect(enqueueCalls.map((entry) => entry.message.ts)).toEqual(["100.100", "100.200"]);
      expect(dispatchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("uses persisted thread backfill cursor as oldest", async () => {
    await withStateDirEnv("openclaw-slack-handler-", async ({ stateDir }) => {
      const cursorPath = path.join(stateDir, "state", "slack-thread-backfill-cursors.json");
      await fs.mkdir(path.dirname(cursorPath), { recursive: true });
      await fs.writeFile(cursorPath, JSON.stringify({ "D1:100.000": "100.555" }, null, 2), "utf8");

      const ctx = createCtx({
        replies: [{ messages: [], response_metadata: { next_cursor: "" } }],
      });
      const handler = createSlackMessageHandler({ ctx, account });

      await handler(
        {
          type: "message",
          subtype: "message_replied",
          channel: "D1",
          ts: "100.700",
          event_ts: "100.701",
          message: {
            type: "message",
            channel: "D1",
            ts: "100.700",
            thread_ts: "100.000",
            latest_reply: "100.700",
          },
        } as unknown as SlackMessageEvent,
        { source: "message" },
      );

      expect(ctx.app.client.conversations.replies).toHaveBeenCalledWith(
        expect.objectContaining({ oldest: "100.555" }),
      );
    });
  });
});
