import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  prepareOutboundMirrorRoute,
  resolveAndApplyOutboundThreadId,
} from "./message-action-threading.js";

const ensureOutboundSessionEntry = vi.fn(async () => undefined);
const resolveOutboundSessionRoute = vi.fn();

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
    },
  },
} as OpenClawConfig;

const telegramConfig = {
  channels: {
    telegram: {
      botToken: "telegram-test",
    },
  },
} as OpenClawConfig;

const defaultTelegramToolContext = {
  currentChannelId: "telegram:123",
  currentThreadTs: "42",
} as const;

describe("message action threading helpers", () => {
  beforeEach(() => {
    ensureOutboundSessionEntry.mockClear();
    resolveOutboundSessionRoute.mockReset();
  });

  it.each([
    {
      name: "exact channel id",
      target: "channel:C123",
      threadTs: "111.222",
      expectedSessionKey: "agent:main:slack:channel:c123:thread:111.222",
    },
    {
      name: "case-insensitive channel id",
      target: "channel:c123",
      threadTs: "333.444",
      expectedSessionKey: "agent:main:slack:channel:c123:thread:333.444",
    },
  ] as const)("prepares outbound routes for slack using $name", async (testCase) => {
    const actionParams: Record<string, unknown> = {
      channel: "slack",
      target: testCase.target,
      message: "hi",
    };
    resolveOutboundSessionRoute.mockResolvedValue({
      sessionKey: testCase.expectedSessionKey,
      baseSessionKey: "base",
      peer: { id: "peer", kind: "channel" },
      chatType: "channel",
      from: "from",
      to: testCase.target,
      threadId: testCase.threadTs,
    });

    const result = await prepareOutboundMirrorRoute({
      cfg: slackConfig,
      channel: "slack",
      to: testCase.target,
      actionParams,
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: testCase.threadTs,
        replyToMode: "all",
      },
      agentId: "main",
      resolveAutoThreadId: ({ toolContext }) => toolContext?.currentThreadTs,
      resolveOutboundSessionRoute,
      ensureOutboundSessionEntry,
    });

    expect(result.outboundRoute?.sessionKey).toBe(testCase.expectedSessionKey);
    expect(actionParams.__sessionKey).toBe(testCase.expectedSessionKey);
    expect(actionParams.__agentId).toBe("main");
    expect(ensureOutboundSessionEntry).toHaveBeenCalledTimes(1);
  });

  it("preserves currentSessionKey for outbound mirroring when present", async () => {
    const actionParams: Record<string, unknown> = {
      channel: "qqbot",
      target: "qqbot:c2c:3939A3986EAE03D9FC2E266CAF10F997",
      message: "hi",
    };
    resolveOutboundSessionRoute.mockResolvedValue({
      sessionKey: "agent:technical_architect:qqbot:group:c2c:3939a3986eae03d9fc2e266caf10f997",
      baseSessionKey: "agent:technical_architect:qqbot:group:c2c:3939a3986eae03d9fc2e266caf10f997",
      peer: { id: "c2c:3939a3986eae03d9fc2e266caf10f997", kind: "group" },
      chatType: "group",
      from: "qqbot:group:c2c:3939A3986EAE03D9FC2E266CAF10F997",
      to: "channel:c2c:3939A3986EAE03D9FC2E266CAF10F997",
    });

    const result = await prepareOutboundMirrorRoute({
      cfg: {} as OpenClawConfig,
      channel: "qqbot",
      to: "qqbot:c2c:3939A3986EAE03D9FC2E266CAF10F997",
      actionParams,
      agentId: "technical_architect",
      currentSessionKey: "agent:technical_architect:main",
      resolveOutboundSessionRoute,
      ensureOutboundSessionEntry,
    });

    expect(result.outboundRoute?.sessionKey).toBe("agent:technical_architect:main");
    expect(result.outboundRoute?.baseSessionKey).toBe("agent:technical_architect:main");
    expect(actionParams.__sessionKey).toBe("agent:technical_architect:main");
    expect(ensureOutboundSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({
          sessionKey: "agent:technical_architect:main",
          baseSessionKey: "agent:technical_architect:main",
        }),
      }),
    );
  });

  it.each([
    {
      name: "injects threadId for matching target",
      target: "telegram:123",
      expectedThreadId: "42",
    },
    {
      name: "injects threadId for prefixed group target",
      target: "telegram:group:123",
      expectedThreadId: "42",
    },
    {
      name: "skips threadId when target chat differs",
      target: "telegram:999",
      expectedThreadId: undefined,
    },
  ] as const)("telegram auto-threading: $name", (testCase) => {
    const actionParams: Record<string, unknown> = {
      channel: "telegram",
      target: testCase.target,
      message: "hi",
    };

    const resolved = resolveAndApplyOutboundThreadId(actionParams, {
      cfg: telegramConfig,
      to: testCase.target,
      toolContext: defaultTelegramToolContext,
      resolveAutoThreadId: ({ to, toolContext }) =>
        to.includes("123") ? toolContext?.currentThreadTs : undefined,
    });

    expect(actionParams.threadId).toBe(testCase.expectedThreadId);
    expect(resolved).toBe(testCase.expectedThreadId);
  });

  it("uses explicit telegram threadId when provided", () => {
    const actionParams: Record<string, unknown> = {
      channel: "telegram",
      target: "telegram:123",
      message: "hi",
      threadId: "999",
    };

    const resolved = resolveAndApplyOutboundThreadId(actionParams, {
      cfg: telegramConfig,
      to: "telegram:123",
      toolContext: defaultTelegramToolContext,
      resolveAutoThreadId: () => "42",
    });

    expect(actionParams.threadId).toBe("999");
    expect(resolved).toBe("999");
  });

  it("passes explicit replyTo into auto-thread resolution", () => {
    const resolveAutoThreadId = vi.fn(() => "thread-777");
    const actionParams: Record<string, unknown> = {
      channel: "telegram",
      target: "telegram:123",
      message: "hi",
      replyTo: "777",
    };

    const resolved = resolveAndApplyOutboundThreadId(actionParams, {
      cfg: telegramConfig,
      to: "telegram:123",
      toolContext: defaultTelegramToolContext,
      resolveAutoThreadId,
    });

    expect(resolveAutoThreadId).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToId: "777",
      }),
    );
    expect(resolved).toBe("thread-777");
    expect(actionParams.threadId).toBe("thread-777");
  });
});
