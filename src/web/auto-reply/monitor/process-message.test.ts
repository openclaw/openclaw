import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sessionDir: string | undefined;
let sessionStorePath: string;
let backgroundTasks: Set<Promise<unknown>>;

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
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    connectionId: "conn",
    verbose: false,
    maxMediaBytes: 1,
    // oxlint-disable-next-line typescript/no-explicit-any
    replyResolver: (async () => undefined) as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    replyLogger: defaultReplyLogger as any,
    backgroundTasks,
    rememberSentText: (_text: string | undefined, _opts: unknown) => {},
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: () => "echo",
    groupHistory: [],
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

let dispatchCalled = false;

vi.mock("../../../auto-reply/reply/provider-dispatcher.js", () => ({
  // oxlint-disable-next-line typescript/no-explicit-any
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (_params: any) => {
    dispatchCalled = true;
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

describe("processMessage send-policy gating", () => {
  beforeEach(async () => {
    dispatchCalled = false;
    backgroundTasks = new Set();
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pm-sendpol-"));
    sessionStorePath = path.join(sessionDir, "sessions.json");
  });

  afterEach(async () => {
    await Promise.allSettled(Array.from(backgroundTasks));
    if (sessionDir) {
      await fs.rm(sessionDir, { recursive: true, force: true });
      sessionDir = undefined;
    }
  });

  const baseMsg = {
    id: "msg1",
    from: "+15550001111",
    to: "+15550002222",
    chatType: "direct",
    body: "hello",
    senderE164: "+15550001111",
  };

  it("returns false and skips dispatch when sendPolicy denies the session", async () => {
    const result = await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:direct:+15550001111",
        groupHistoryKey: "+15550001111",
        cfg: {
          messages: {},
          session: {
            store: sessionStorePath,
            sendPolicy: {
              default: "allow",
              rules: [{ action: "deny", match: { channel: "whatsapp" } }],
            },
          },
        },
        msg: baseMsg,
      }),
    );

    expect(result).toBe(false);
    expect(dispatchCalled).toBe(false);
  });

  it("proceeds to dispatch when sendPolicy allows the session", async () => {
    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:direct:+15550001111",
        groupHistoryKey: "+15550001111",
        cfg: {
          messages: {},
          session: {
            store: sessionStorePath,
            sendPolicy: {
              default: "allow",
              rules: [{ action: "deny", match: { channel: "discord" } }],
            },
          },
        },
        msg: baseMsg,
      }),
    );

    // The dispatcher was called (reply was attempted)
    expect(dispatchCalled).toBe(true);
  });

  it("proceeds to dispatch when no sendPolicy is configured", async () => {
    await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:direct:+15550001111",
        groupHistoryKey: "+15550001111",
        cfg: {
          messages: {},
          session: { store: sessionStorePath },
        },
        msg: baseMsg,
      }),
    );

    expect(dispatchCalled).toBe(true);
  });

  it("denies group chat when rule targets whatsapp groups", async () => {
    const result = await processMessage(
      makeProcessMessageArgs({
        routeSessionKey: "agent:main:whatsapp:group:123@g.us",
        groupHistoryKey: "whatsapp:default:group:123@g.us",
        cfg: {
          messages: {},
          session: {
            store: sessionStorePath,
            sendPolicy: {
              default: "allow",
              rules: [{ action: "deny", match: { channel: "whatsapp", chatType: "group" } }],
            },
          },
        },
        msg: {
          ...baseMsg,
          from: "123@g.us",
          chatType: "group",
          senderName: "Alice",
          groupSubject: "Test Group",
          groupParticipants: [],
        },
      }),
    );

    expect(result).toBe(false);
    expect(dispatchCalled).toBe(false);
  });
});
