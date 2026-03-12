import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";

const hoisted = vi.hoisted(() => {
  const getThreadBindingManagerMock = vi.fn();
  const setThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const setTelegramThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setTelegramThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  return {
    getThreadBindingManagerMock,
    setThreadBindingIdleTimeoutBySessionKeyMock,
    setThreadBindingMaxAgeBySessionKeyMock,
    setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
    setTelegramThreadBindingMaxAgeBySessionKeyMock,
    sessionBindingResolveByConversationMock,
  };
});

vi.mock("../../discord/monitor/thread-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../discord/monitor/thread-bindings.js")>();
  return {
    ...actual,
    getThreadBindingManager: hoisted.getThreadBindingManagerMock,
    setThreadBindingIdleTimeoutBySessionKey: hoisted.setThreadBindingIdleTimeoutBySessionKeyMock,
    setThreadBindingMaxAgeBySessionKey: hoisted.setThreadBindingMaxAgeBySessionKeyMock,
  };
});

vi.mock("../../telegram/thread-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../telegram/thread-bindings.js")>();
  return {
    ...actual,
    setTelegramThreadBindingIdleTimeoutBySessionKey:
      hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
    setTelegramThreadBindingMaxAgeBySessionKey:
      hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock,
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/session-binding-service.js")>();
  return {
    ...actual,
    getSessionBindingService: () => ({
      bind: vi.fn(),
      getCapabilities: vi.fn(() => ({
        adapterAvailable: true,
        bindSupported: true,
        unbindSupported: true,
        placements: ["current", "child"],
      })),
      listBySession: vi.fn(),
      resolveByConversation: (ref: unknown) => hoisted.sessionBindingResolveByConversationMock(ref),
      setIdleTimeoutBySession: ({
        channel,
        targetSessionKey,
        accountId,
        idleTimeoutMs,
      }: {
        channel: string;
        targetSessionKey: string;
        accountId: string;
        idleTimeoutMs: number;
      }) =>
        Promise.resolve(
          channel === "telegram"
            ? hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock({
                targetSessionKey,
                accountId,
                idleTimeoutMs,
              })
            : hoisted.setThreadBindingIdleTimeoutBySessionKeyMock({
                targetSessionKey,
                accountId,
                idleTimeoutMs,
              }),
        ),
      setMaxAgeBySession: ({
        channel,
        targetSessionKey,
        accountId,
        maxAgeMs,
      }: {
        channel: string;
        targetSessionKey: string;
        accountId: string;
        maxAgeMs: number;
      }) =>
        Promise.resolve(
          channel === "telegram"
            ? hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock({
                targetSessionKey,
                accountId,
                maxAgeMs,
              })
            : hoisted.setThreadBindingMaxAgeBySessionKeyMock({
                targetSessionKey,
                accountId,
                maxAgeMs,
              }),
        ),
      touch: vi.fn(),
      unbind: vi.fn(),
    }),
  };
});

const { handleSessionCommand } = await import("./commands-session.js");
const { buildCommandTestParams } = await import("./commands.test-harness.js");

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function createDiscordCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildCommandTestParams(commandBody, baseCfg, {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:thread-1",
    AccountId: "default",
    MessageThreadId: "thread-1",
    ...overrides,
  });
}

function createTelegramCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildCommandTestParams(commandBody, baseCfg, {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "-100200300:topic:77",
    AccountId: "default",
    MessageThreadId: "77",
    ...overrides,
  });
}

function createMatrixCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildCommandTestParams(commandBody, baseCfg, {
    Provider: "matrix",
    Surface: "matrix",
    OriginatingChannel: "matrix",
    OriginatingTo: "room:!room:example",
    To: "room:!room:example",
    AccountId: "default",
    MessageThreadId: "$thread-1",
    ...overrides,
  });
}

function createDiscordBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:thread-1",
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      boundBy: "user-1",
      lastActivityAt: Date.now(),
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    },
    ...overrides,
  };
}

function createTelegramBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:-100200300:topic:77",
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation: {
      channel: "telegram",
      accountId: "default",
      conversationId: "-100200300:topic:77",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      boundBy: "user-1",
      lastActivityAt: Date.now(),
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    },
    ...overrides,
  };
}

function createMatrixBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:!room:example:$thread-1",
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation: {
      channel: "matrix",
      accountId: "default",
      conversationId: "$thread-1",
      parentConversationId: "!room:example",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      boundBy: "user-1",
      lastActivityAt: Date.now(),
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    },
    ...overrides,
  };
}

describe("/session idle and /session max-age", () => {
  beforeEach(() => {
    hoisted.getThreadBindingManagerMock.mockReset();
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    vi.useRealTimers();
  });

  it("sets idle timeout for the focused Discord session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const binding = createDiscordBinding();
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(binding);
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: binding.targetSessionKey,
        boundAt: Date.now(),
        metadata: {
          lastActivityAt: Date.now(),
          idleTimeoutMs: 2 * 60 * 60 * 1000,
        },
      },
    ]);

    const result = await handleSessionCommand(createDiscordCommandParams("/session idle 2h"), true);
    const text = result?.reply?.text ?? "";

    expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    });
    expect(text).toContain("Idle timeout set to 2h");
    expect(text).toContain("2026-02-20T02:00:00.000Z");
  });

  it("shows active idle timeout when no value is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const binding = createDiscordBinding({
      metadata: {
        boundBy: "user-1",
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
        maxAgeMs: 0,
      },
    });
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(binding);

    const result = await handleSessionCommand(createDiscordCommandParams("/session idle"), true);
    expect(result?.reply?.text).toContain("Idle timeout active (2h");
    expect(result?.reply?.text).toContain("2026-02-20T02:00:00.000Z");
  });

  it("sets max age for the focused Discord session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const binding = createDiscordBinding();
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(binding);
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: binding.targetSessionKey,
        boundAt: Date.now(),
        metadata: {
          maxAgeMs: 3 * 60 * 60 * 1000,
        },
      },
    ]);

    const result = await handleSessionCommand(
      createDiscordCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T03:00:00.000Z");
  });

  it("sets idle timeout for focused Telegram conversations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createTelegramBinding());
    hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        metadata: {
          lastActivityAt: Date.now(),
          idleTimeoutMs: 2 * 60 * 60 * 1000,
        },
      },
    ]);

    const result = await handleSessionCommand(
      createTelegramCommandParams("/session idle 2h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    });
    expect(text).toContain("Idle timeout set to 2h");
    expect(text).toContain("2026-02-20T02:00:00.000Z");
  });

  it("reports Telegram max-age expiry from the original bind time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const boundAt = Date.parse("2026-02-19T22:00:00.000Z");
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createTelegramBinding({ boundAt }),
    );
    hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt,
        metadata: {
          lastActivityAt: Date.now(),
          maxAgeMs: 3 * 60 * 60 * 1000,
        },
      },
    ]);

    const result = await handleSessionCommand(
      createTelegramCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T01:00:00.000Z");
  });

  it("sets idle timeout for focused Matrix threads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createMatrixBinding());
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        metadata: {
          lastActivityAt: Date.now(),
          idleTimeoutMs: 2 * 60 * 60 * 1000,
        },
      },
    ]);

    const result = await handleSessionCommand(createMatrixCommandParams("/session idle 2h"), true);
    const text = result?.reply?.text ?? "";

    expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    });
    expect(text).toContain("Idle timeout set to 2h");
    expect(text).toContain("2026-02-20T02:00:00.000Z");
  });

  it("disables max age when set to off", async () => {
    const binding = createDiscordBinding({
      metadata: {
        boundBy: "user-1",
        lastActivityAt: Date.now(),
        idleTimeoutMs: 24 * 60 * 60 * 1000,
        maxAgeMs: 2 * 60 * 60 * 1000,
      },
    });
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(binding);
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: binding.targetSessionKey,
        boundAt: binding.boundAt,
        maxAgeMs: 0,
      },
    ]);

    const result = await handleSessionCommand(
      createDiscordCommandParams("/session max-age off"),
      true,
    );

    expect(hoisted.setThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 0,
    });
    expect(result?.reply?.text).toContain("Max age disabled");
  });

  it("is unavailable outside discord and telegram", async () => {
    const params = buildCommandTestParams("/session idle 2h", baseCfg);
    const result = await handleSessionCommand(params, true);
    expect(result?.reply?.text).toContain(
      "currently available for Discord, Matrix, and Telegram bound sessions",
    );
  });

  it("requires binding owner for lifecycle updates", async () => {
    const binding = createDiscordBinding({
      metadata: {
        boundBy: "owner-1",
        lastActivityAt: Date.now(),
        idleTimeoutMs: 24 * 60 * 60 * 1000,
        maxAgeMs: 0,
      },
    });
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(binding);

    const result = await handleSessionCommand(
      createDiscordCommandParams("/session idle 2h", {
        SenderId: "other-user",
      }),
      true,
    );

    expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Only owner-1 can update session lifecycle settings");
  });
});
