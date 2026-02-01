import { describe, expect, it, vi } from "vitest";
import { expectInboundContextContract } from "../../../../test/helpers/inbound-contract.js";

let capturedCtx: unknown;

vi.mock("../../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (params: { ctx: unknown }) => {
    capturedCtx = params.ctx;
    return { queuedFinal: false };
  }),
}));

import { processMessage } from "./process-message.js";

describe("web processMessage inbound contract", () => {
  it("passes a finalized MsgContext to the dispatcher", async () => {
    capturedCtx = undefined;

    await processMessage({
      cfg: { messages: {} } as any,
      msg: {
        id: "msg1",
        from: "123@g.us",
        to: "+15550001111",
        chatType: "group",
        body: "hi",
        senderName: "Alice",
        senderJid: "alice@s.whatsapp.net",
        senderE164: "+15550002222",
        groupSubject: "Test Group",
        groupParticipants: [],
      } as any,
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:whatsapp:group:123",
      } as any,
      groupHistoryKey: "123@g.us",
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      connectionId: "conn",
      verbose: false,
      maxMediaBytes: 1,
      replyResolver: (async () => undefined) as any,
      replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      backgroundTasks: new Set(),
      rememberSentText: (_text: string | undefined, _opts: unknown) => {},
      echoHas: () => false,
      echoForget: () => {},
      buildCombinedEchoKey: () => "echo",
      groupHistory: [],
    } as any);

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx as any);
  });
});
