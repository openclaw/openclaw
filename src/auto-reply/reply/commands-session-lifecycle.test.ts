import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";

function resolveThreadBindingIdleTimeoutMs(params: {
  record: { idleTimeoutMs?: number };
  defaultIdleTimeoutMs: number;
}): number {
  return typeof params.record.idleTimeoutMs === "number"
    ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
    : params.defaultIdleTimeoutMs;
}

function resolveThreadBindingInactivityExpiresAt(params: {
  record: { boundAt: number; lastActivityAt: number; idleTimeoutMs?: number };
  defaultIdleTimeoutMs: number;
}): number | undefined {
  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMs(params);
  return idleTimeoutMs > 0
    ? Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
    : undefined;
}

function resolveThreadBindingMaxAgeMs(params: {
  record: { maxAgeMs?: number };
  defaultMaxAgeMs: number;
}): number {
  return typeof params.record.maxAgeMs === "number"
    ? Math.max(0, Math.floor(params.record.maxAgeMs))
    : params.defaultMaxAgeMs;
}

function resolveThreadBindingMaxAgeExpiresAt(params: {
  record: { boundAt: number; maxAgeMs?: number };
  defaultMaxAgeMs: number;
}): number | undefined {
  const maxAgeMs = resolveThreadBindingMaxAgeMs(params);
  return maxAgeMs > 0 ? params.record.boundAt + maxAgeMs : undefined;
}

const hoisted = vi.hoisted(() => {
  const getThreadBindingManagerMock = vi.fn();
  const setThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const setMatrixThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setMatrixThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const setTelegramThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setTelegramThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  return {
    getThreadBindingManagerMock,
    setThreadBindingIdleTimeoutBySessionKeyMock,
    setThreadBindingMaxAgeBySessionKeyMock,
    setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
    setMatrixThreadBindingMaxAgeBySessionKeyMock,
    setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
    setTelegramThreadBindingMaxAgeBySessionKeyMock,
    sessionBindingResolveByConversationMock,
  };
});

vi.mock("../../plugins/runtime/index.js", () => {
  return {
    createPluginRuntime: () => ({
      channel: {
        threadBindings: {
          setIdleTimeoutBySessionKey: ({ channelId, ...params }: Record<string, unknown>) => {
            if (channelId === "telegram") {
              return hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock(params);
            }
            if (channelId === "matrix") {
              return hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock(params);
            }
            return hoisted.setThreadBindingIdleTimeoutBySessionKeyMock(params);
          },
          setMaxAgeBySessionKey: ({ channelId, ...params }: Record<string, unknown>) => {
            if (channelId === "telegram") {
              return hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock(params);
            }
            if (channelId === "matrix") {
              return hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock(params);
            }
            return hoisted.setThreadBindingMaxAgeBySessionKeyMock(params);
          },
        },
        discord: {
          threadBindings: {
            getManager: hoisted.getThreadBindingManagerMock,
            resolveIdleTimeoutMs: resolveThreadBindingIdleTimeoutMs,
            resolveInactivityExpiresAt: resolveThreadBindingInactivityExpiresAt,
            resolveMaxAgeMs: resolveThreadBindingMaxAgeMs,
            resolveMaxAgeExpiresAt: resolveThreadBindingMaxAgeExpiresAt,
            setIdleTimeoutBySessionKey: hoisted.setThreadBindingIdleTimeoutBySessionKeyMock,
            setMaxAgeBySessionKey: hoisted.setThreadBindingMaxAgeBySessionKeyMock,
            unbindBySessionKey: vi.fn(),
          },
        },
        matrix: {
          threadBindings: {
            setIdleTimeoutBySessionKey: hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
            setMaxAgeBySessionKey: hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock,
          },
        },
      },
    }),
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", () => {
  return {
    getSessionBindingService: () => ({
      bind: vi.fn(),
      getCapabilities: vi.fn(),
      listBySession: vi.fn(),
      resolveByConversation: (ref: unknown) => hoisted.sessionBindingResolveByConversationMock(ref),
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

type FakeBinding = {
  accountId: string;
  channelId: string;
  threadId: string;
  targetKind: "subagent" | "acp";
  targetSessionKey: string;
  agentId: string;
  boundBy: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

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

function createMatrixThreadCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildCommandTestParams(commandBody, baseCfg, {
    Provider: "matrix",
    Surface: "matrix",
    OriginatingChannel: "matrix",
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    MessageThreadId: "$thread-1",
    ...overrides,
  });
}

function createMatrixTriggerThreadCommandParams(
  commandBody: string,
  overrides?: Record<string, unknown>,
) {
  return buildCommandTestParams(commandBody, baseCfg, {
    Provider: "matrix",
    Surface: "matrix",
    OriginatingChannel: "matrix",
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    MessageThreadId: "$root",
    ...overrides,
  });
}

function createMatrixRoomCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildCommandTestParams(commandBody, baseCfg, {
    Provider: "matrix",
    Surface: "matrix",
    OriginatingChannel: "matrix",
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    ...overrides,
  });
}

function createFakeBinding(overrides: Partial<FakeBinding> = {}): FakeBinding {
  const now = Date.now();
  return {
    accountId: "default",
    channelId: "parent-1",
    threadId: "thread-1",
    targetKind: "subagent",
    targetSessionKey: "agent:main:subagent:child",
    agentId: "main",
    boundBy: "user-1",
    boundAt: now,
    lastActivityAt: now,
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
    bindingId: "default:$thread-1",
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation: {
      channel: "matrix",
      accountId: "default",
      conversationId: "$thread-1",
      parentConversationId: "!room:example.org",
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

function createMatrixTriggerBinding(
  overrides?: Partial<SessionBindingRecord>,
): SessionBindingRecord {
  return createMatrixBinding({
    bindingId: "default:$root",
    conversation: {
      channel: "matrix",
      accountId: "default",
      conversationId: "$root",
      parentConversationId: "!room:example.org",
    },
    ...overrides,
  });
}

function expectIdleTimeoutSetReply(
  mock: ReturnType<typeof vi.fn>,
  text: string,
  idleTimeoutMs: number,
  idleTimeoutLabel: string,
) {
  expect(mock).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:subagent:child",
    accountId: "default",
    idleTimeoutMs,
  });
  expect(text).toContain(`Idle timeout set to ${idleTimeoutLabel}`);
  expect(text).toContain("2026-02-20T02:00:00.000Z");
}

function createFakeThreadBindingManager(binding: FakeBinding | null) {
  return {
    getByThreadId: vi.fn((_threadId: string) => binding),
    getIdleTimeoutMs: vi.fn(() => 24 * 60 * 60 * 1000),
    getMaxAgeMs: vi.fn(() => 0),
  };
}

describe("/session idle and /session max-age", () => {
  beforeEach(() => {
    hoisted.getThreadBindingManagerMock.mockReset();
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    vi.useRealTimers();
  });

  it("sets idle timeout for the focused Discord session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const binding = createFakeBinding();
    hoisted.getThreadBindingManagerMock.mockReturnValue(createFakeThreadBindingManager(binding));
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        ...binding,
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(createDiscordCommandParams("/session idle 2h"), true);
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("shows active idle timeout when no value is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const binding = createFakeBinding({
      idleTimeoutMs: 2 * 60 * 60 * 1000,
      lastActivityAt: Date.now(),
    });
    hoisted.getThreadBindingManagerMock.mockReturnValue(createFakeThreadBindingManager(binding));

    const result = await handleSessionCommand(createDiscordCommandParams("/session idle"), true);
    expect(result?.reply?.text).toContain("Idle timeout active (2h");
    expect(result?.reply?.text).toContain("2026-02-20T02:00:00.000Z");
  });

  it("sets max age for the focused Discord session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const binding = createFakeBinding();
    hoisted.getThreadBindingManagerMock.mockReturnValue(createFakeThreadBindingManager(binding));
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        ...binding,
        boundAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
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
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createTelegramCommandParams("/session idle 2h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets idle timeout for focused Matrix threads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createMatrixBinding());
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createMatrixThreadCommandParams("/session idle 2h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets idle timeout for the triggering Matrix always-thread turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createMatrixTriggerBinding());
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createMatrixTriggerThreadCommandParams("/session idle 2h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.sessionBindingResolveByConversationMock).toHaveBeenCalledWith({
      channel: "matrix",
      accountId: "default",
      conversationId: "$root",
      parentConversationId: "!room:example.org",
    });
    expectIdleTimeoutSetReply(
      hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets max age for focused Matrix threads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const boundAt = Date.parse("2026-02-19T22:00:00.000Z");
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createMatrixBinding({ boundAt }),
    );
    hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt,
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createMatrixThreadCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T01:00:00.000Z");
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
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
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

  it("disables max age when set to off", async () => {
    const binding = createFakeBinding({ maxAgeMs: 2 * 60 * 60 * 1000 });
    hoisted.getThreadBindingManagerMock.mockReturnValue(createFakeThreadBindingManager(binding));
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([{ ...binding, maxAgeMs: 0 }]);

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

  it("requires a focused Matrix thread for lifecycle updates", async () => {
    const result = await handleSessionCommand(
      createMatrixRoomCommandParams("/session idle 2h"),
      true,
    );

    expect(result?.reply?.text).toContain("must be run inside a focused Matrix thread");
    expect(hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
  });

  it("requires binding owner for lifecycle updates", async () => {
    const binding = createFakeBinding({ boundBy: "owner-1" });
    hoisted.getThreadBindingManagerMock.mockReturnValue(createFakeThreadBindingManager(binding));

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
