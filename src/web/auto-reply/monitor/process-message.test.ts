import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendReactionWhatsAppMock = vi.fn(async (..._args: unknown[]) => {});
const maybeSendAckReactionMock = vi.fn();
const resolveWhatsAppAckReactionDecisionMock = vi.fn();

let dispatchImpl: (params: {
  dispatcherOptions: {
    onReplyStart?: () => Promise<void>;
    onError?: (err: unknown, info: { kind: "tool" | "block" | "final" }) => void;
  };
  replyOptions?: {
    onReasoningStream?: (payload: { text?: string }) => Promise<void>;
    onToolStart?: (payload: { name?: string }) => Promise<void>;
  };
}) => Promise<{ queuedFinal: boolean }>;

vi.mock("../../outbound.js", () => ({
  sendReactionWhatsApp: (
    chatJid: string,
    messageId: string,
    emoji: string,
    options: {
      verbose: boolean;
      fromMe?: boolean;
      participant?: string;
      accountId?: string;
    },
  ) => sendReactionWhatsAppMock(chatJid, messageId, emoji, options),
}));

vi.mock("./ack-reaction.js", () => ({
  maybeSendAckReaction: (params: unknown) => maybeSendAckReactionMock(params),
  resolveWhatsAppAckReactionDecision: (params: unknown) =>
    resolveWhatsAppAckReactionDecisionMock(params),
}));

vi.mock("../../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: (params: unknown) => dispatchImpl(params as never),
}));

vi.mock("./last-route.js", () => ({
  trackBackgroundTask: (tasks: Set<Promise<unknown>>, task: Promise<unknown>) => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  },
  updateLastRouteInBackground: vi.fn(),
}));

import { processMessage } from "./process-message.js";

type Config = ReturnType<typeof import("../../../config/config.js").loadConfig>;

let sessionDir: string | undefined;
let sessionStorePath: string;
let backgroundTasks: Set<Promise<unknown>>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeProcessMessageArgs(overrides?: {
  cfg?: Config;
  route?: Partial<ReturnType<typeof import("../../../routing/resolve-route.js").resolveAgentRoute>>;
  lifecycleOwnerAgentId?: string;
}) {
  return {
    cfg:
      overrides?.cfg ??
      ({
        channels: {
          whatsapp: {
            ackReaction: {
              emoji: "👀",
              direct: true,
              group: "mentions",
            },
          },
        },
        messages: {
          statusReactions: {
            enabled: true,
            timing: { debounceMs: 0, stallSoftMs: 60_000, stallHardMs: 120_000 },
          },
        },
        session: { store: sessionStorePath },
      } as unknown as Config),
    msg: {
      id: "msg-1",
      from: "+15550001",
      conversationId: "+15550001",
      to: "+15550002",
      accountId: "default",
      body: "hello",
      chatType: "direct",
      chatId: "direct:+15550001",
      senderJid: "15550001@s.whatsapp.net",
      senderE164: "+15550001",
      sendComposing: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
      sendMedia: vi.fn(async () => {}),
    } as import("../types.js").WebInboundMsg,
    route: {
      agentId: "alfred",
      accountId: "default",
      sessionKey: "agent:alfred:whatsapp:direct:+15550001",
      mainSessionKey: "agent:alfred:main",
      ...overrides?.route,
    } as ReturnType<typeof import("../../../routing/resolve-route.js").resolveAgentRoute>,
    groupHistoryKey: "agent:alfred:whatsapp:direct:+15550001",
    groupHistories: new Map<string, Array<{ sender: string; body: string }>>(),
    groupMemberNames: new Map<string, Map<string, string>>(),
    connectionId: "conn",
    verbose: false,
    maxMediaBytes: 1,
    replyResolver: (async () =>
      undefined) as unknown as typeof import("../../../auto-reply/reply.js").getReplyFromConfig,
    replyLogger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as ReturnType<(typeof import("../../../logging.js"))["getChildLogger"]>,
    backgroundTasks,
    rememberSentText: (_text: string | undefined, _opts: unknown) => {},
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: () => "echo-key",
    lifecycleOwnerAgentId: overrides?.lifecycleOwnerAgentId,
  } as Parameters<typeof processMessage>[0];
}

describe("web processMessage lifecycle status reactions", () => {
  beforeEach(async () => {
    sendReactionWhatsAppMock.mockReset();
    maybeSendAckReactionMock.mockReset();
    resolveWhatsAppAckReactionDecisionMock.mockReset();
    resolveWhatsAppAckReactionDecisionMock.mockReturnValue({
      shouldReact: true,
      emoji: "👀",
      target: {
        chatId: "direct:+15550001",
        messageId: "msg-1",
        participant: "15550001@s.whatsapp.net",
        accountId: "default",
      },
    });
    dispatchImpl = async () => ({ queuedFinal: true });
    backgroundTasks = new Set();
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-process-message-status-"));
    sessionStorePath = path.join(sessionDir, "sessions.json");
  });

  afterEach(async () => {
    await Promise.allSettled(Array.from(backgroundTasks));
    if (sessionDir) {
      await fs.rm(sessionDir, { recursive: true, force: true });
      sessionDir = undefined;
    }
  });

  it("updates queued -> thinking -> tool -> done and skips one-shot ack when lifecycle is enabled", async () => {
    dispatchImpl = async (params) => {
      await params.dispatcherOptions.onReplyStart?.();
      await params.replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_step_" });
      await sleep(0);
      await params.replyOptions?.onToolStart?.({ name: "web_search" });
      await sleep(0);
      return { queuedFinal: true };
    };

    await processMessage(makeProcessMessageArgs());

    const emojis = sendReactionWhatsAppMock.mock.calls.map((call) => String(call[2]));
    expect(emojis).toContain("👀");
    expect(emojis).toContain("🤔");
    expect(emojis).toContain("⚡");
    expect(emojis.at(-1)).toBe("👍");
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
  });

  it("sets error lifecycle reaction when dispatch throws", async () => {
    dispatchImpl = async (params) => {
      await params.dispatcherOptions.onReplyStart?.();
      throw new Error("dispatch failed");
    };

    await expect(processMessage(makeProcessMessageArgs())).rejects.toThrow("dispatch failed");
    const emojis = sendReactionWhatsAppMock.mock.calls.map((call) => String(call[2]));
    expect(emojis).toContain("😱");
    expect(emojis.at(-1)).toBe("😱");
  });

  it("sets error lifecycle reaction when final delivery fails", async () => {
    dispatchImpl = async (params) => {
      await params.dispatcherOptions.onReplyStart?.();
      params.dispatcherOptions.onError?.(new Error("final failed"), { kind: "final" });
      return { queuedFinal: true };
    };

    await processMessage(makeProcessMessageArgs());

    const emojis = sendReactionWhatsAppMock.mock.calls.map((call) => String(call[2]));
    expect(emojis).toContain("😱");
    expect(emojis.at(-1)).toBe("😱");
  });

  it("still terminalizes to done when no final reply was queued", async () => {
    dispatchImpl = async (params) => {
      await params.dispatcherOptions.onReplyStart?.();
      return { queuedFinal: false };
    };

    const didSend = await processMessage(makeProcessMessageArgs());

    expect(didSend).toBe(false);
    const emojis = sendReactionWhatsAppMock.mock.calls.map((call) => String(call[2]));
    expect(emojis.at(-1)).toBe("👍");
  });

  it("suppresses all reaction writes for non-owner broadcast agents in lifecycle mode", async () => {
    dispatchImpl = async (params) => {
      await params.dispatcherOptions.onReplyStart?.();
      await params.replyOptions?.onToolStart?.({ name: "web_search" });
      return { queuedFinal: true };
    };

    await processMessage(
      makeProcessMessageArgs({
        route: { agentId: "baerbel" },
        lifecycleOwnerAgentId: "alfred",
      }),
    );

    expect(sendReactionWhatsAppMock).not.toHaveBeenCalled();
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
  });
});
