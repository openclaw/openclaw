import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const getThreadBindingManagerMock = vi.fn();
  const setThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  return {
    getThreadBindingManagerMock,
    setThreadBindingIdleTimeoutBySessionKeyMock,
    setThreadBindingMaxAgeBySessionKeyMock,
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

function createFakeThreadBindingManager(binding: FakeBinding | null) {
  return {
    getByThreadId: vi.fn((_threadId: string) => binding),
    getIdleTimeoutMs: vi.fn(() => 24 * 60 * 60 * 1000),
    getMaxAgeMs: vi.fn(() => 0),
  };
}

describe("/session idle and /session max-age", () => {
  beforeEach(() => {
    hoisted.getThreadBindingManagerMock.mockClear();
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockClear();
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockClear();
    vi.useRealTimers();
  });

  it("sets idle timeout for the focused session", async () => {
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

    const binding = createFakeBinding({
      idleTimeoutMs: 2 * 60 * 60 * 1000,
      lastActivityAt: Date.now(),
    });
    hoisted.getThreadBindingManagerMock.mockReturnValue(createFakeThreadBindingManager(binding));

    const result = await handleSessionCommand(createDiscordCommandParams("/session idle"), true);
    expect(result?.reply?.text).toContain("Idle timeout active (2h");
    expect(result?.reply?.text).toContain("2026-02-20T02:00:00.000Z");
  });

  it("sets max age for the focused session", async () => {
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

  it("is unavailable outside discord", async () => {
    const params = buildCommandTestParams("/session idle 2h", baseCfg);
    const result = await handleSessionCommand(params, true);
    expect(result?.reply?.text).toContain("currently available for Discord thread-bound sessions");
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
