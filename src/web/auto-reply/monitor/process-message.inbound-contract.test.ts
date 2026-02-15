import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectInboundContextContract } from "../../../../test/helpers/inbound-contract.js";

let capturedCtx: unknown;
let capturedDispatchParams: unknown;
let sessionDir: string | undefined;
let sessionStorePath: string;
let backgroundTasks: Set<Promise<unknown>>;

vi.mock("../../../auto-reply/reply/provider-dispatcher.js", () => ({
  // oxlint-disable-next-line typescript/no-explicit-any
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (params: any) => {
    capturedDispatchParams = params;
    capturedCtx = params.ctx;
    return { queuedFinal: false };
  }),
}));

vi.mock("./last-route.js", () => ({
  trackBackgroundTask: (tasks: Set<Promise<unknown>>, task: Promise<unknown>) => {
    tasks.add(task);
    void task.finally(() => {
      tasks.delete(task);
    });
  },
  updateLastRouteInBackground: vi.fn(),
}));

import { processMessage } from "./process-message.js";

describe("web processMessage inbound contract", () => {
  beforeEach(async () => {
    capturedCtx = undefined;
    capturedDispatchParams = undefined;
    backgroundTasks = new Set();
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-process-message-"));
    sessionStorePath = path.join(sessionDir, "sessions.json");
  });

  afterEach(async () => {
    await Promise.allSettled(Array.from(backgroundTasks));
    if (sessionDir) {
      await fs.rm(sessionDir, { recursive: true, force: true });
      sessionDir = undefined;
    }
  });

  it("passes a finalized MsgContext to the dispatcher", async () => {
    await processMessage({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: {}, session: { store: sessionStorePath } } as any,
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
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:whatsapp:group:123",
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      groupHistoryKey: "123@g.us",
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      connectionId: "conn",
      verbose: false,
      maxMediaBytes: 1,
      // oxlint-disable-next-line typescript/no-explicit-any
      replyResolver: (async () => undefined) as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      backgroundTasks,
      rememberSentText: (_text: string | undefined, _opts: unknown) => {},
      echoHas: () => false,
      echoForget: () => {},
      buildCombinedEchoKey: () => "echo",
      groupHistory: [],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    expect(capturedCtx).toBeTruthy();
    // oxlint-disable-next-line typescript/no-explicit-any
    expectInboundContextContract(capturedCtx as any);
  });

  it("falls back SenderId to SenderE164 when senderJid is empty", async () => {
    capturedCtx = undefined;

    await processMessage({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: { messages: {}, session: { store: sessionStorePath } } as any,
      msg: {
        id: "msg1",
        from: "+1000",
        to: "+2000",
        chatType: "direct",
        body: "hi",
        senderJid: "",
        senderE164: "+1000",
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:whatsapp:direct:+1000",
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      groupHistoryKey: "+1000",
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      connectionId: "conn",
      verbose: false,
      maxMediaBytes: 1,
      // oxlint-disable-next-line typescript/no-explicit-any
      replyResolver: (async () => undefined) as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      backgroundTasks,
      rememberSentText: (_text: string | undefined, _opts: unknown) => {},
      echoHas: () => false,
      echoForget: () => {},
      buildCombinedEchoKey: () => "echo",
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    expect(capturedCtx).toBeTruthy();
    // oxlint-disable-next-line typescript/no-explicit-any
    const ctx = capturedCtx as any;
    expect(ctx.SenderId).toBe("+1000");
    expect(ctx.SenderE164).toBe("+1000");
    expect(ctx.OriginatingChannel).toBe("whatsapp");
    expect(ctx.OriginatingTo).toBe("+1000");
    expect(ctx.To).toBe("+2000");
    expect(ctx.OriginatingTo).not.toBe(ctx.To);
  });

  it("defaults responsePrefix to identity name in self-chats when unset", async () => {
    capturedDispatchParams = undefined;

    await processMessage({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: {
        agents: {
          list: [
            {
              id: "main",
              default: true,
              identity: { name: "Mainbot", emoji: "🦞", theme: "space lobster" },
            },
          ],
        },
        messages: {},
        session: { store: sessionStorePath },
      } as unknown as ReturnType<typeof import("../../../config/config.js").loadConfig>,
      msg: {
        id: "msg1",
        from: "+1555",
        to: "+1555",
        selfE164: "+1555",
        chatType: "direct",
        body: "hi",
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:whatsapp:direct:+1555",
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      groupHistoryKey: "+1555",
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      connectionId: "conn",
      verbose: false,
      maxMediaBytes: 1,
      // oxlint-disable-next-line typescript/no-explicit-any
      replyResolver: (async () => undefined) as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      backgroundTasks,
      rememberSentText: (_text: string | undefined, _opts: unknown) => {},
      echoHas: () => false,
      echoForget: () => {},
      buildCombinedEchoKey: () => "echo",
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    // oxlint-disable-next-line typescript/no-explicit-any
    const dispatcherOptions = (capturedDispatchParams as any)?.dispatcherOptions;
    expect(dispatcherOptions?.responsePrefix).toBe("[Mainbot]");
  });

  it("clears pending group history when the dispatcher does not queue a final reply", async () => {
    capturedCtx = undefined;
    const groupHistories = new Map<string, Array<{ sender: string; body: string }>>([
      [
        "whatsapp:default:group:123@g.us",
        [
          {
            sender: "Alice (+111)",
            body: "first",
          },
        ],
      ],
    ]);

    await processMessage({
      // oxlint-disable-next-line typescript/no-explicit-any
      cfg: {
        messages: {},
        session: { store: sessionStorePath },
      } as unknown as ReturnType<typeof import("../../../config/config.js").loadConfig>,
      msg: {
        id: "g1",
        from: "123@g.us",
        conversationId: "123@g.us",
        to: "+2000",
        chatType: "group",
        chatId: "123@g.us",
        body: "second",
        senderName: "Bob",
        senderE164: "+222",
        selfE164: "+999",
        sendComposing: async () => {},
        reply: async () => {},
        sendMedia: async () => {},
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      route: {
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:whatsapp:group:123@g.us",
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      groupHistoryKey: "whatsapp:default:group:123@g.us",
      groupHistories: groupHistories as never,
      groupMemberNames: new Map(),
      connectionId: "conn",
      verbose: false,
      maxMediaBytes: 1,
      // oxlint-disable-next-line typescript/no-explicit-any
      replyResolver: (async () => undefined) as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
      backgroundTasks,
      rememberSentText: (_text: string | undefined, _opts: unknown) => {},
      echoHas: () => false,
      echoForget: () => {},
      buildCombinedEchoKey: () => "echo",
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    expect(groupHistories.get("whatsapp:default:group:123@g.us") ?? []).toHaveLength(0);
  });
});
