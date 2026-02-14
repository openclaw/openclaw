import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";

let capturedCtx: MsgContext | undefined;

vi.mock("../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/dispatch.js")>();
  const dispatchInboundMessage = vi.fn(async (params: { ctx: MsgContext }) => {
    capturedCtx = params.ctx;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
  return {
    ...actual,
    dispatchInboundMessage,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessage,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessage,
  };
});

import { createSignalEventHandler } from "./monitor/event-handler.js";

const createMockHandler = (account?: string) =>
  createSignalEventHandler({
    // oxlint-disable-next-line typescript/no-explicit-any
    runtime: { log: () => {}, error: () => {} } as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
    baseUrl: "http://localhost",
    accountId: "default",
    account,
    historyLimit: 0,
    groupHistories: new Map(),
    textLimit: 4000,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupAllowFrom: ["*"],
    groupPolicy: "open",
    reactionMode: "off",
    reactionAllowlist: [],
    mediaMaxBytes: 1024,
    ignoreAttachments: true,
    sendReadReceipts: false,
    readReceiptsViaDaemon: false,
    fetchAttachment: async () => null,
    deliverReplies: async () => {},
    resolveSignalReactionTargets: () => [],
    // oxlint-disable-next-line typescript/no-explicit-any
    isSignalReactionMessage: () => false as any,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: () => "reaction",
  });

describe("signal event handler - syncMessage support (Note to Self)", () => {
  beforeEach(() => {
    capturedCtx = undefined;
  });

  it("processes syncMessage.sentMessage as Note to Self", async () => {
    const handler = createMockHandler("+14259798283");

    // WebSocket format: syncMessage with sentMessage (Note to Self)
    await handler({
      envelope: {
        sourceNumber: "+14259798283",
        timestamp: 1700000000000,
        syncMessage: {
          sentMessage: {
            message: "Hello bot, this is a Note to Self message",
            timestamp: 1700000000000,
            destination: "+14259798283",
          },
        },
      },
    });

    expect(capturedCtx).toBeTruthy();
    if (capturedCtx) {
      expect(String(capturedCtx.Body ?? "")).toContain("Hello bot, this is a Note to Self message");
    }
  });

  it("blocks dataMessage from self (bot echo)", async () => {
    const handler = createMockHandler("+14259798283");

    // WebSocket format: dataMessage from self (bot echo - should be blocked)
    await handler({
      envelope: {
        sourceNumber: "+14259798283",
        timestamp: 1700000000000,
        dataMessage: {
          message: "This is a bot echo, should be blocked",
        },
      },
    });

    // Should NOT have dispatched the message
    expect(capturedCtx).toBeUndefined();
  });

  it("processes dataMessage from other users normally", async () => {
    const handler = createMockHandler("+14259798283");

    // WebSocket format: dataMessage from another user
    await handler({
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Alice",
        timestamp: 1700000000000,
        dataMessage: {
          message: "Hello from Alice",
        },
      },
    });

    expect(capturedCtx).toBeTruthy();
    if (capturedCtx) {
      expect(String(capturedCtx.Body ?? "")).toContain("Hello from Alice");
    }
  });

  it("handles both SSE and WebSocket formats", async () => {
    const handler = createMockHandler();

    // SSE format: event.data contains JSON string
    capturedCtx = undefined;
    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          timestamp: 1700000000000,
          dataMessage: {
            message: "SSE format message",
          },
        },
      }),
    });

    expect(capturedCtx).toBeTruthy();
    if (capturedCtx) {
      expect(String(capturedCtx.Body ?? "")).toContain("SSE format message");
    }

    // WebSocket format: envelope is directly in event
    capturedCtx = undefined;
    await handler({
      envelope: {
        sourceNumber: "+15550001111",
        timestamp: 1700000000000,
        dataMessage: {
          message: "WebSocket format message",
        },
      },
    });

    expect(capturedCtx).toBeTruthy();
    if (capturedCtx) {
      expect(String(capturedCtx.Body ?? "")).toContain("WebSocket format message");
    }
  });

  it("ignores syncMessage without sentMessage (e.g., read receipts)", async () => {
    const handler = createMockHandler("+14259798283");

    // syncMessage with readMessages (not sentMessage)
    await handler({
      envelope: {
        sourceNumber: "+14259798283",
        timestamp: 1700000000000,
        syncMessage: {
          readMessages: [
            {
              sender: "+15550001111",
              timestamp: 1699999999000,
            },
          ],
        },
      },
    });

    // Should NOT have dispatched anything
    expect(capturedCtx).toBeUndefined();
  });

  it("normalizes E164 format for self-message comparison", async () => {
    const handler = createMockHandler("14259798283"); // Without + prefix

    // dataMessage from self with + prefix (should be blocked)
    await handler({
      envelope: {
        sourceNumber: "+14259798283",
        timestamp: 1700000000000,
        dataMessage: {
          message: "Bot echo with + prefix",
        },
      },
    });

    expect(capturedCtx).toBeUndefined();
  });
});
