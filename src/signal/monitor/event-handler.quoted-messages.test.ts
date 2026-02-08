import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";

let capturedCtx: MsgContext | undefined;

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
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

import { createSignalEventHandler } from "./event-handler.js";

describe("signal quoted message handling", () => {
  it("includes full quoted message context in Body", async () => {
    capturedCtx = undefined;

    const handler = createSignalEventHandler({
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: { log: () => {}, error: () => {} } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
      baseUrl: "http://localhost",
      accountId: "default",
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

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Bob",
          timestamp: 1700000001000,
          dataMessage: {
            message: "I agree with that!",
            attachments: [],
            quote: {
              id: 1700000000000,
              authorNumber: "+15550002222",
              authorUuid: "uuid-alice-1234",
              text: "Let's meet tomorrow at 3pm",
            },
          },
        },
      }),
    });

    expect(capturedCtx).toBeTruthy();
    expect(capturedCtx?.Body).toBeTruthy();

    const body = String(capturedCtx?.Body ?? "");

    // Should contain the new message
    expect(body).toContain("I agree with that!");

    // Should contain quote marker
    expect(body).toContain("[Replying to");
    expect(body).toContain("[/Replying]");

    // Should contain quoted author's phone number
    expect(body).toContain("+15550002222");

    // Should contain quoted message ID
    expect(body).toContain("id:1700000000000");

    // Should contain quoted message text
    expect(body).toContain("Let's meet tomorrow at 3pm");
  });

  it("handles quotes with UUID but no phone number", async () => {
    capturedCtx = undefined;

    const handler = createSignalEventHandler({
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: { log: () => {}, error: () => {} } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
      baseUrl: "http://localhost",
      accountId: "default",
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

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Bob",
          timestamp: 1700000001000,
          dataMessage: {
            message: "Thanks!",
            attachments: [],
            quote: {
              id: 1700000000000,
              authorUuid: "uuid-charlie-5678",
              text: "Here's the info you requested",
            },
          },
        },
      }),
    });

    expect(capturedCtx).toBeTruthy();
    const body = String(capturedCtx?.Body ?? "");

    // Should contain UUID when phone number is not available
    expect(body).toContain("uuid-charlie-5678");
    expect(body).toContain("Here's the info you requested");
  });

  it("handles quotes without text (attachment-only quotes)", async () => {
    capturedCtx = undefined;

    const handler = createSignalEventHandler({
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: { log: () => {}, error: () => {} } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
      baseUrl: "http://localhost",
      accountId: "default",
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

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Bob",
          timestamp: 1700000001000,
          dataMessage: {
            message: "Love this photo!",
            attachments: [],
            quote: {
              id: 1700000000000,
              authorNumber: "+15550002222",
              text: null, // No text in quoted message (was an attachment)
            },
          },
        },
      }),
    });

    expect(capturedCtx).toBeTruthy();
    const body = String(capturedCtx?.Body ?? "");

    // Should contain quote marker even without text
    expect(body).toContain("[Replying to");
    expect(body).toContain("+15550002222");

    // Should show placeholder for missing text
    expect(body).toContain("<no text>");
  });

  it("handles messages without quotes normally", async () => {
    capturedCtx = undefined;

    const handler = createSignalEventHandler({
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: { log: () => {}, error: () => {} } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
      baseUrl: "http://localhost",
      accountId: "default",
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

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Bob",
          timestamp: 1700000001000,
          dataMessage: {
            message: "Just a regular message",
            attachments: [],
          },
        },
      }),
    });

    expect(capturedCtx).toBeTruthy();
    const body = String(capturedCtx?.Body ?? "");

    // Should not contain quote markers
    expect(body).not.toContain("[Replying to");
    expect(body).not.toContain("[/Replying]");

    // Should contain the message
    expect(body).toContain("Just a regular message");
  });
});
