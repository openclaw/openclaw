import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { MaybeBroadcastTelegramMessageParams } from "./broadcast.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dispatchMock = vi.hoisted(() => vi.fn(async (_params?: any) => {}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage: dispatchMock,
}));

// Suppress logVerbose output during tests.
vi.mock("../globals.js", () => ({
  logVerbose: () => {},
  shouldLogVerbose: () => false,
  danger: (s: string) => s,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

import { maybeBroadcastTelegramMessage } from "./broadcast.js";

type DispatchCall = { context: TelegramMessageContext };

/** Type-safe accessor for dispatch mock call args. */
function getDispatchContext(callIndex: number): TelegramMessageContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (dispatchMock.mock.calls[callIndex] as any)[0].context;
}

function getAllDispatchContexts(): TelegramMessageContext[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dispatchMock.mock.calls.map((call: any) => (call[0] as DispatchCall).context);
}

function buildFakeContext(overrides?: Partial<TelegramMessageContext>): TelegramMessageContext {
  const defaults: TelegramMessageContext = {
    ctxPayload: {
      Body: "hello",
      From: "telegram:1234567890",
      SessionKey: "agent:main:telegram:default:direct:1234567890",
      ChatType: "direct",
    } as TelegramMessageContext["ctxPayload"],
    primaryCtx: {} as TelegramMessageContext["primaryCtx"],
    msg: {
      message_id: 1,
      chat: { id: 1234567890 },
      date: Date.now(),
    } as TelegramMessageContext["msg"],
    chatId: 1234567890,
    isGroup: false,
    resolvedThreadId: undefined,
    threadSpec: { scope: "none" } as TelegramMessageContext["threadSpec"],
    replyThreadId: undefined,
    isForum: false,
    historyKey: undefined,
    historyLimit: 0,
    groupHistories: new Map(),
    route: {
      agentId: "main",
      channel: "telegram",
      sessionKey: "agent:main:telegram:default:direct:1234567890",
      mainSessionKey: "agent:main:main",
      accountId: "default",
      matchedBy: "default" as const,
    },
    skillFilter: undefined,
    sendTyping: async () => {},
    sendRecordVoice: async () => {},
    ackReactionPromise: null,
    reactionApi: null,
    removeAckAfterReply: false,
    statusReactionController: null,
    accountId: "default",
  };
  return { ...defaults, ...overrides };
}

function buildParams(
  cfg: OpenClawConfig,
  context: TelegramMessageContext,
): MaybeBroadcastTelegramMessageParams {
  return {
    cfg,
    context,
    bot: {} as MaybeBroadcastTelegramMessageParams["bot"],
    runtime: {} as MaybeBroadcastTelegramMessageParams["runtime"],
    replyToMode: "off",
    streamMode: "off",
    textLimit: 4096,
    telegramCfg: {} as MaybeBroadcastTelegramMessageParams["telegramCfg"],
    opts: { token: "test-token" },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("maybeBroadcastTelegramMessage", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
  });

  it("returns false when no broadcast config exists", async () => {
    const cfg: OpenClawConfig = {};
    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("returns false when peer ID is not in broadcast config", async () => {
    const cfg: OpenClawConfig = {
      broadcast: {
        "telegram:9999999999": ["agent-a"],
      },
    };
    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("dispatches to all agents using prefixed peer ID key", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        "telegram:1234567890": ["alfred", "baerbel"],
      },
    };
    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(2);

    // Verify each dispatch received a different agentId in the route.
    const agents = getAllDispatchContexts().map((ctx) => ctx.route.agentId);
    expect(agents).toContain("alfred");
    expect(agents).toContain("baerbel");
  });

  it("dispatches to all agents using raw (unprefixed) peer ID key", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }],
      },
      broadcast: {
        "1234567890": ["alfred"],
      },
    };
    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("prefers prefixed key over raw key", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        "telegram:1234567890": ["alfred"],
        "1234567890": ["baerbel"],
      },
    };
    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    // Should use the prefixed key (alfred), not the raw key (baerbel).
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const agent = getDispatchContext(0).route.agentId;
    expect(agent).toBe("alfred");
  });

  it("skips unknown agent IDs when agents.list is present", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }],
      },
      broadcast: {
        "telegram:1234567890": ["alfred", "ghost"],
      },
    };
    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    // Only alfred should be dispatched; ghost is not in agents.list.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const agent = getDispatchContext(0).route.agentId;
    expect(agent).toBe("alfred");
  });

  it("broadcasts sequentially in configured order", async () => {
    const order: string[] = [];
    dispatchMock.mockImplementation(async (params: unknown) => {
      const p = params as { context: TelegramMessageContext };
      order.push(p.context.route.agentId);
    });

    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "telegram:1234567890": ["alfred", "baerbel"],
      },
    };
    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["alfred", "baerbel"]);
  });

  it("broadcasts in parallel by default", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    dispatchMock.mockImplementation(async () => {
      started += 1;
      if (started < 2) {
        await gate;
      } else {
        release?.();
      }
    });

    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "parallel",
        "telegram:1234567890": ["alfred", "baerbel"],
      },
    };
    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    // Both agents must have started (gate only resolves when both are in-flight).
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("clears group history after broadcast", async () => {
    const groupHistories = new Map<string, Array<{ sender: string; body: string }>>();
    groupHistories.set("-100123456", [{ sender: "Alice", body: "hi" }]);

    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }],
      },
      broadcast: {
        "telegram:-100123456": ["alfred"],
      },
    };
    const context = buildFakeContext({
      chatId: -100123456,
      isGroup: true,
      historyKey: "-100123456",
      groupHistories: groupHistories as TelegramMessageContext["groupHistories"],
    });
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    expect(groupHistories.get("-100123456")).toEqual([]);
  });

  it("account-scoped key takes precedence over generic telegram key", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        "telegram:myaccount:1234567890": ["alfred"],
        "telegram:1234567890": ["baerbel"],
      },
    };
    const context = buildFakeContext({ accountId: "myaccount" });
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    // Should use the account-scoped key (alfred), not the generic key (baerbel).
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const agent = getDispatchContext(0).route.agentId;
    expect(agent).toBe("alfred");
  });

  it("forum topic message with broadcast gives each agent thread-scoped routing", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        "telegram:-1001234567890": ["alfred", "baerbel"],
      },
    };
    const context = buildFakeContext({
      chatId: -1001234567890,
      isGroup: true,
      isForum: true,
      resolvedThreadId: 42,
      historyKey: "-1001234567890:42",
      ctxPayload: {
        Body: "hello",
        From: "telegram:-1001234567890:42",
        SessionKey: "agent:main:telegram:default:group:-1001234567890:42",
        ChatType: "group",
      } as TelegramMessageContext["ctxPayload"],
      route: {
        agentId: "main",
        channel: "telegram",
        sessionKey: "agent:main:telegram:default:group:-1001234567890:42",
        mainSessionKey: "agent:main:main",
        accountId: "default",
        matchedBy: "default" as const,
      },
    });
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(2);

    // Each agent should get the thread-scoped peer ID in its session key.
    const contexts = getAllDispatchContexts();
    for (const ctx of contexts) {
      // The resolvedThreadId should flow through unchanged.
      expect(ctx.resolvedThreadId).toBe(42);
      expect(ctx.isForum).toBe(true);
    }
    // The two agents should have different session keys.
    const keys = contexts.map((ctx) => ctx.route.sessionKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("ack reaction is only sent to the first/primary broadcast agent", async () => {
    const fakeAckPromise = Promise.resolve(true);
    const fakeReactionApi = vi.fn();
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "telegram:1234567890": ["alfred", "baerbel"],
      },
    };
    const context = buildFakeContext({
      ackReactionPromise: fakeAckPromise,
      reactionApi: fakeReactionApi as TelegramMessageContext["reactionApi"],
    });
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(2);

    const firstCtx = getDispatchContext(0);
    const secondCtx = getDispatchContext(1);

    // First agent keeps ack reaction.
    expect(firstCtx.ackReactionPromise).toBe(fakeAckPromise);
    expect(firstCtx.reactionApi).toBe(fakeReactionApi);

    // Second agent has ack nulled out.
    expect(secondCtx.ackReactionPromise).toBeNull();
    expect(secondCtx.reactionApi).toBeNull();
  });

  it("statusReactionController is only active for the primary broadcast agent", async () => {
    const fakeController = {
      setQueued: vi.fn(),
    } as unknown as TelegramMessageContext["statusReactionController"];
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "telegram:1234567890": ["alfred", "baerbel"],
      },
    };
    const context = buildFakeContext({
      statusReactionController: fakeController,
    });
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(2);

    const firstCtx = getDispatchContext(0);
    const secondCtx = getDispatchContext(1);

    expect(firstCtx.statusReactionController).toBe(fakeController);
    expect(secondCtx.statusReactionController).toBeNull();
  });

  it("removeAckAfterReply is only true for the primary broadcast agent", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "telegram:1234567890": ["alfred", "baerbel"],
      },
    };
    const context = buildFakeContext({
      removeAckAfterReply: true,
    });
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(2);

    const firstCtx = getDispatchContext(0);
    const secondCtx = getDispatchContext(1);

    expect(firstCtx.removeAckAfterReply).toBe(true);
    expect(secondCtx.removeAckAfterReply).toBe(false);
  });

  it("handles large negative group chat IDs correctly", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }],
      },
      broadcast: {
        "telegram:-1001234567890": ["alfred"],
      },
    };
    const context = buildFakeContext({
      chatId: -1001234567890,
      isGroup: true,
      historyKey: "-1001234567890",
      ctxPayload: {
        Body: "hello",
        From: "telegram:-1001234567890",
        SessionKey: "agent:main:telegram:default:group:-1001234567890",
        ChatType: "group",
      } as TelegramMessageContext["ctxPayload"],
    });
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    expect(getDispatchContext(0).route.agentId).toBe("alfred");
  });

  // ── Stress Tests ──────────────────────────────────────────────────────────

  it("handles 10 agents in parallel without deadlock or lost dispatches", async () => {
    const agentIds = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
    const cfg: OpenClawConfig = {
      agents: { list: agentIds.map((id) => ({ id })) },
      broadcast: {
        strategy: "parallel",
        "telegram:1234567890": agentIds,
      },
    };

    // Each agent takes a random delay (0-50ms) to simulate real LLM latency variance.
    dispatchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 50));
    });

    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(10);

    // Verify all 10 agents received unique routes.
    const dispatched = getAllDispatchContexts().map((ctx) => ctx.route.agentId);
    expect(new Set(dispatched).size).toBe(10);
  });

  it("rapid-fire: 20 concurrent broadcast calls don't interfere", async () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "alfred" }, { id: "baerbel" }] },
      broadcast: {
        strategy: "parallel",
        "telegram:1234567890": ["alfred", "baerbel"],
      },
    };

    dispatchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 20));
    });

    // Simulate 20 messages arriving nearly simultaneously.
    const promises = Array.from({ length: 20 }, () => {
      const context = buildFakeContext();
      return maybeBroadcastTelegramMessage(buildParams(cfg, context));
    });

    const results = await Promise.all(promises);

    // All 20 should succeed.
    expect(results.every((r) => r)).toBe(true);
    // 20 messages × 2 agents each = 40 dispatches.
    expect(dispatchMock).toHaveBeenCalledTimes(40);
  });

  it("mixed failures: some agents throw, others succeed, all are attempted", async () => {
    const agentIds = Array.from({ length: 5 }, (_, i) => `agent-${i}`);
    const cfg: OpenClawConfig = {
      agents: { list: agentIds.map((id) => ({ id })) },
      broadcast: {
        strategy: "parallel",
        "telegram:1234567890": agentIds,
      },
    };

    // Agents 1 and 3 throw; 0, 2, 4 succeed.
    dispatchMock.mockImplementation(async (params: unknown) => {
      const p = params as { context: TelegramMessageContext };
      const idx = Number(p.context.route.agentId.split("-")[1]);
      if (idx % 2 === 1) {
        throw new Error(`agent-${idx} failed`);
      }
    });

    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    // All 5 attempted despite failures.
    expect(dispatchMock).toHaveBeenCalledTimes(5);
  });

  it("sequential with slow agents: maintains strict ordering", async () => {
    const order: string[] = [];
    const agentIds = Array.from({ length: 5 }, (_, i) => `agent-${i}`);
    const cfg: OpenClawConfig = {
      agents: { list: agentIds.map((id) => ({ id })) },
      broadcast: {
        strategy: "sequential",
        "telegram:1234567890": agentIds,
      },
    };

    dispatchMock.mockImplementation(async (params: unknown) => {
      const p = params as { context: TelegramMessageContext };
      // Random delay to verify sequential isn't accidentally parallel.
      await new Promise((r) => setTimeout(r, Math.random() * 30));
      order.push(p.context.route.agentId);
    });

    const context = buildFakeContext();
    await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(order).toEqual(agentIds);
  });

  it("isFirstAgent flag is correct even under parallel dispatch race", async () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "alfred" }, { id: "baerbel" }, { id: "charlie" }] },
      broadcast: {
        strategy: "parallel",
        "telegram:1234567890": ["alfred", "baerbel", "charlie"],
      },
    };

    const context = buildFakeContext({
      ackReactionPromise: Promise.resolve(true),
      reactionApi: vi.fn() as TelegramMessageContext["reactionApi"],
      removeAckAfterReply: true,
      statusReactionController: {
        setQueued: vi.fn(),
      } as unknown as TelegramMessageContext["statusReactionController"],
    });

    await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(dispatchMock).toHaveBeenCalledTimes(3);

    const contexts = getAllDispatchContexts();

    // Exactly one agent should have non-null ack reaction (the primary).
    const withAck = contexts.filter((c) => c.ackReactionPromise !== null);
    const withoutAck = contexts.filter((c) => c.ackReactionPromise === null);
    expect(withAck.length).toBe(1);
    expect(withoutAck.length).toBe(2);

    // The primary should also keep statusReactionController and removeAckAfterReply.
    expect(withAck[0].statusReactionController).not.toBeNull();
    expect(withAck[0].removeAckAfterReply).toBe(true);
    for (const ctx of withoutAck) {
      expect(ctx.statusReactionController).toBeNull();
      expect(ctx.removeAckAfterReply).toBe(false);
    }
  });

  it("empty broadcast array returns false (no dispatch)", async () => {
    const cfg: OpenClawConfig = {
      broadcast: { "telegram:1234567890": [] },
    };
    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("catches dispatch errors and continues to next agent", async () => {
    let callCount = 0;
    dispatchMock.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("boom");
      }
    });

    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "telegram:1234567890": ["alfred", "baerbel"],
      },
    };
    const context = buildFakeContext();
    const result = await maybeBroadcastTelegramMessage(buildParams(cfg, context));

    expect(result).toBe(true);
    // Both agents attempted even though first threw.
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });
});
