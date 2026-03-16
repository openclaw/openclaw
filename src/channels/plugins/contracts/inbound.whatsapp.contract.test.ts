import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processMessage } from "../../../../extensions/whatsapp/src/auto-reply/monitor/process-message.js";
import type { MsgContext } from "../../../auto-reply/templating.js";
import { expectChannelInboundContextContract } from "./suites.js";

const capture = vi.hoisted(() => ({
  ctx: undefined as MsgContext | undefined,
}));

vi.mock("../../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (params: { ctx: MsgContext }) => {
    capture.ctx = params.ctx;
    return { queuedFinal: false };
  }),
}));

vi.mock("../../../../extensions/whatsapp/src/auto-reply/monitor/last-route.js", () => ({
  trackBackgroundTask: (tasks: Set<Promise<unknown>>, task: Promise<unknown>) => {
    tasks.add(task);
    void task.finally(() => {
      tasks.delete(task);
    });
  },
  updateLastRouteInBackground: vi.fn(),
}));

vi.mock("../../../../extensions/whatsapp/src/auto-reply/deliver-reply.js", () => ({
  deliverWebReply: vi.fn(async () => {}),
}));

function makeProcessArgs(sessionStorePath: string) {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    cfg: { messages: {}, session: { store: sessionStorePath } } as any,
    // oxlint-disable-next-line typescript/no-explicit-any
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
    } as unknown as Record<string, unknown>,
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
    backgroundTasks: new Set<Promise<unknown>>(),
    rememberSentText: () => {},
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: () => "echo",
    groupHistory: [],
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

describe("whatsapp inbound contract", () => {
  let sessionDir = "";

  afterEach(async () => {
    capture.ctx = undefined;
    if (sessionDir) {
      await fs.rm(sessionDir, { recursive: true, force: true });
      sessionDir = "";
    }
  });

  it("keeps inbound context finalized", async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-contract-"));
    const sessionStorePath = path.join(sessionDir, "sessions.json");

    await processMessage(makeProcessArgs(sessionStorePath));

    expect(capture.ctx).toBeTruthy();
    expectChannelInboundContextContract(capture.ctx!);
  });
});
