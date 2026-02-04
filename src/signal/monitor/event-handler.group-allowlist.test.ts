import { describe, expect, it, vi } from "vitest";

import type { MsgContext } from "../../auto-reply/templating.js";

let capturedCtx: MsgContext | undefined;
let dispatchCalled = false;

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  const dispatchInboundMessage = vi.fn(async (params: { ctx: MsgContext }) => {
    capturedCtx = params.ctx;
    dispatchCalled = true;
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

describe("signal group-level allowlist (groups config)", () => {
  const makeHandler = (cfg: Record<string, unknown>) =>
    createSignalEventHandler({
      runtime: { log: () => {}, error: () => {} } as any,
      cfg: { messages: { inbound: { debounceMs: 0 } }, ...cfg } as any,
      baseUrl: "http://localhost",
      accountId: "default",
      historyLimit: 0,
      groupHistories: new Map(),
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: ["+15559999999"],
      groupAllowFrom: [],
      groupPolicy: "allowlist",
      reactionMode: "off",
      reactionAllowlist: [],
      mediaMaxBytes: 1024,
      ignoreAttachments: true,
      sendReadReceipts: false,
      readReceiptsViaDaemon: false,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: () => [],
      isSignalReactionMessage: () => false as any,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "reaction",
    });

  const sendGroupMessage = async (
    handler: ReturnType<typeof makeHandler>,
    groupId: string,
    sender = "+15550001111",
  ) => {
    capturedCtx = undefined;
    dispatchCalled = false;
    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: sender,
          sourceName: "Alice",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hi",
            attachments: [],
            groupInfo: { groupId, groupName: "Test Group" },
          },
        },
      }),
    });
  };

  it("allows group messages when group is in channels.signal.groups config", async () => {
    const handler = makeHandler({
      channels: {
        signal: {
          groups: {
            "allowed-group-id": {},
          },
        },
      },
    });

    await sendGroupMessage(handler, "allowed-group-id");

    expect(dispatchCalled).toBe(true);
    expect(capturedCtx).toBeTruthy();
  });

  it("blocks group messages when group is not in channels.signal.groups config", async () => {
    const handler = makeHandler({
      channels: {
        signal: {
          groups: {
            "allowed-group-id": {},
          },
        },
      },
    });

    await sendGroupMessage(handler, "not-allowed-group-id");

    expect(dispatchCalled).toBe(false);
  });

  it("allows all groups when groups config has wildcard entry", async () => {
    const handler = makeHandler({
      channels: {
        signal: {
          groups: {
            "*": {},
          },
        },
      },
    });

    await sendGroupMessage(handler, "any-group-id");

    expect(dispatchCalled).toBe(true);
  });

  it("bypasses sender-level groupAllowFrom check when group is explicitly allowed", async () => {
    // groupAllowFrom is empty, which would normally block all senders
    // But the group is explicitly allowed via groups config, so it should pass
    const handler = makeHandler({
      channels: {
        signal: {
          groups: {
            "family-chat": {},
          },
        },
      },
    });

    // Sender +15550001111 is NOT in groupAllowFrom (which is empty)
    // But the group "family-chat" is in groups config, so message should pass
    await sendGroupMessage(handler, "family-chat", "+15550001111");

    expect(dispatchCalled).toBe(true);
    expect(capturedCtx).toBeTruthy();
  });

  it("falls back to sender-level check when groups config is not set", async () => {
    // No groups config, groupPolicy is allowlist, groupAllowFrom is empty
    // Should block because sender is not in allowlist
    const handler = makeHandler({});

    await sendGroupMessage(handler, "any-group");

    expect(dispatchCalled).toBe(false);
  });
});
