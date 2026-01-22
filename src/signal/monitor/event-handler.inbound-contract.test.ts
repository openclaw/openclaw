import { describe, expect, it, vi } from "vitest";

import type { MsgContext } from "../../auto-reply/templating.js";
import { expectInboundContextContract } from "../../../test/helpers/inbound-contract.js";

let capturedCtx: MsgContext | undefined;

vi.mock("../../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: vi.fn(async (params: { ctx: MsgContext }) => {
    capturedCtx = params.ctx;
    return { queuedFinal: false, counts: { tool: 0, block: 0 } };
  }),
}));

import { createSignalEventHandler } from "./event-handler.js";

describe("signal createSignalEventHandler inbound contract", () => {
  it("passes a finalized MsgContext to dispatchReplyFromConfig", async () => {
    capturedCtx = undefined;

    const handler = createSignalEventHandler({
      runtime: { log: () => {}, error: () => {} } as any,
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
      isSignalReactionMessage: () => false as any,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "reaction",
    });

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hi",
            attachments: [],
            groupInfo: { groupId: "g1", groupName: "Test Group" },
          },
        },
      }),
    });

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);
    // Sender should appear as prefix in group messages (no redundant [from:] suffix)
    expect(String(capturedCtx?.Body ?? "")).toContain("Alice");
    expect(String(capturedCtx?.Body ?? "")).toMatch(/Alice.*:/);
    expect(String(capturedCtx?.Body ?? "")).not.toContain("[from:");
  });
});
