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
const { deliverWebReplyMock } = vi.hoisted(() => ({
  deliverWebReplyMock: vi.fn(async () => {}),
}));

const defaultReplyLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeProcessMessageArgs(params: {
  msg: Record<string, unknown>;
  routeSessionKey: string;
  groupHistoryKey: string;
  cfg?: unknown;
  groupHistories?: Map<string, Array<{ sender: string; body: string }>>;
  groupHistory?: Array<{ sender: string; body: string }>;
  rememberSentText?: (text: string | undefined, opts: unknown) => void;
}) {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    cfg: (params.cfg ?? { messages: {}, session: { store: sessionStorePath } }) as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    msg: params.msg as any,
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: params.routeSessionKey,
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any,
    groupHistoryKey: params.groupHistoryKey,
    groupHistories: params.groupHistories ?? new Map(),
    groupMemberNames: new Map(),
    connectionId: "conn",
    verbose: false,
    maxMediaBytes: 1,
    // oxlint-disable-next-line typescript/no-explicit-any
    replyResolver: (async () => undefined) as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    replyLogger: defaultReplyLogger as any,
    backgroundTasks,
    rememberSentText:
      params.rememberSentText ?? ((_text: string | undefined, _opts: unknown) => {}),
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: () => "echo",
    ...(params.groupHistory ? { groupHistory: params.groupHistory } : {}),
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

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

vi.mock("../deliver-reply.js", () => ({
  deliverWebReply: deliverWebReplyMock,
}));

import { processMessage } from "./process-message.js";

describe("web processMessage inbound contract", () => {
  beforeEach(async () => {
    capturedCtx = undefined;
    capturedDispatchParams = undefined;
    backgroundTasks = new Set();
    deliverWebReplyMock.mockClear();
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
    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:group:123",
        groupHistoryKey: "123@g.us",
        groupHistory: [],
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
        },
      }),
    );

    expect(capturedCtx).toBeTruthy();
    // oxlint-disable-next-line typescript/no-explicit-any
    expectInboundContextContract(capturedCtx as any);
  });

  it("falls back SenderId to SenderE164 when senderJid is empty", async () => {
    capturedCtx = undefined;

    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:direct:+1000",
        groupHistoryKey: "+1000",
        msg: {
          id: "msg1",
          from: "+1000",
          to: "+2000",
          chatType: "direct",
          body: "hi",
          senderJid: "",
          senderE164: "+1000",
        },
      }),
    );

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

    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:direct:+1555",
        groupHistoryKey: "+1555",
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
        },
      }),
    );

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

    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:group:123@g.us",
        groupHistoryKey: "whatsapp:default:group:123@g.us",
        groupHistories,
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
        },
      }),
    );

    expect(groupHistories.get("whatsapp:default:group:123@g.us") ?? []).toHaveLength(0);
  });

  it("suppresses non-final WhatsApp payload delivery", async () => {
    const rememberSentText = vi.fn();
    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:direct:+1555",
        groupHistoryKey: "+1555",
        rememberSentText,
        cfg: {
          channels: { whatsapp: { blockStreaming: true } },
          messages: {},
          session: { store: sessionStorePath },
        } as unknown as ReturnType<typeof import("../../../config/config.js").loadConfig>,
        msg: {
          id: "msg1",
          from: "+1555",
          to: "+2000",
          chatType: "direct",
          body: "hi",
        },
      }),
    );

    // oxlint-disable-next-line typescript/no-explicit-any
    const deliver = (capturedDispatchParams as any)?.dispatcherOptions?.deliver as
      | ((payload: { text?: string }, info: { kind: "tool" | "block" | "final" }) => Promise<void>)
      | undefined;
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "tool payload" }, { kind: "tool" });
    await deliver?.({ text: "block payload" }, { kind: "block" });
    expect(deliverWebReplyMock).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();

    await deliver?.({ text: "final payload" }, { kind: "final" });
    expect(deliverWebReplyMock).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });

  it("forces disableBlockStreaming for WhatsApp dispatch", async () => {
    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:direct:+1555",
        groupHistoryKey: "+1555",
        cfg: {
          channels: { whatsapp: { blockStreaming: true } },
          messages: {},
          session: { store: sessionStorePath },
        } as unknown as ReturnType<typeof import("../../../config/config.js").loadConfig>,
        msg: {
          id: "msg1",
          from: "+1555",
          to: "+2000",
          chatType: "direct",
          body: "hi",
        },
      }),
    );

    // oxlint-disable-next-line typescript/no-explicit-any
    const replyOptions = (capturedDispatchParams as any)?.replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(true);
  });
});
