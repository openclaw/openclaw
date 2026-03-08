import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

import {
  baseTelegramMessageContextConfig,
  buildTelegramMessageContextForTest,
} from "./bot-message-context.test-harness.js";

const recordInboundSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../channels/session.js", () => ({
  recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
}));

describe("buildTelegramMessageContext DM topic threadId in deliveryContext (#8891, #40005)", () => {
  async function buildCtx(params: {
    message: Record<string, unknown>;
    options?: Record<string, unknown>;
    cfg?: Record<string, unknown>;
    resolveGroupActivation?: () => boolean | undefined;
  }) {
    return await buildTelegramMessageContextForTest({
      message: params.message,
      options: params.options,
      cfg: params.cfg,
      resolveGroupActivation: params.resolveGroupActivation,
    });
  }

  function getUpdateLastRoute(): unknown {
    const callArgs = recordInboundSessionMock.mock.calls[0]?.[0] as { updateLastRoute?: unknown };
    return callArgs?.updateLastRoute;
  }

  beforeEach(() => {
    recordInboundSessionMock.mockClear();
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue(baseTelegramMessageContextConfig);
  });

  it("passes threadId to updateLastRoute for DM topics", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        message_thread_id: 42,
      },
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    const updateLastRoute = getUpdateLastRoute() as { threadId?: string; to?: string } | undefined;
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.to).toBe("telegram:1234");
    expect(updateLastRoute?.threadId).toBe("42");
  });

  it("does not pass threadId for regular DM without topic", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
      },
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    const updateLastRoute = getUpdateLastRoute() as { threadId?: string; to?: string } | undefined;
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.to).toBe("telegram:1234");
    expect(updateLastRoute?.threadId).toBeUndefined();
  });

  it("does not set updateLastRoute for group messages", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        text: "@bot hello",
        message_thread_id: 99,
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();
    expect(getUpdateLastRoute()).toBeUndefined();
  });

  it("writes lastRoute to the isolated Telegram DM session under per-channel-peer dmScope", async () => {
    const isolatedCfg = {
      ...(baseTelegramMessageContextConfig as Record<string, unknown>),
      session: { dmScope: "per-channel-peer" },
    };
    loadConfigMock.mockReturnValue(isolatedCfg);

    const ctx = await buildCtx({
      cfg: isolatedCfg,
      message: {
        chat: { id: 1234, type: "private" },
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:direct:42");
    expect(recordInboundSessionMock).toHaveBeenCalled();

    const updateLastRoute = getUpdateLastRoute() as
      | { sessionKey?: string; to?: string; threadId?: string }
      | undefined;
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.sessionKey).toBe("agent:main:telegram:direct:42");
    expect(updateLastRoute?.to).toBe("telegram:1234");
    expect(updateLastRoute?.threadId).toBeUndefined();
  });

  it("keeps writing lastRoute to agent:main:main when dmScope resolves to the main session", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
    expect(recordInboundSessionMock).toHaveBeenCalled();

    const updateLastRoute = getUpdateLastRoute() as
      | { sessionKey?: string; to?: string }
      | undefined;
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.sessionKey).toBe("agent:main:main");
    expect(updateLastRoute?.to).toBe("telegram:1234");
  });
});
