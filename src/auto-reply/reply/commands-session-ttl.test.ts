import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => {
  const getThreadBindingManagerMock = vi.fn();
  const setThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  return {
    getThreadBindingManagerMock,
    setThreadBindingIdleTimeoutBySessionKeyMock,
  };
});

vi.mock("../../discord/monitor/thread-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../discord/monitor/thread-bindings.js")>();
  return {
    ...actual,
    getThreadBindingManager: hoisted.getThreadBindingManagerMock,
    setThreadBindingIdleTimeoutBySessionKey: hoisted.setThreadBindingIdleTimeoutBySessionKeyMock,
  };
});

const { handleSessionCommand } = await import("./commands-session.js");
const { buildCommandTestParams } = await import("./commands.test-harness.js");

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

type FakeBinding = {
  threadId: string;
  targetSessionKey: string;
  idleTimeoutMs?: number;
  lastActivityAt?: number;
  boundBy?: string;
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

function createFakeThreadBindingManager(binding: FakeBinding | null) {
  return {
    getByThreadId: vi.fn((_threadId: string) => binding),
    getIdleTimeoutMs: () => 24 * 60 * 60 * 1000,
    getMaxAgeMs: () => 0,
  };
}

describe("/session idle", () => {
  beforeEach(() => {
    hoisted.getThreadBindingManagerMock.mockClear();
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockClear();
    vi.useRealTimers();
  });

  it("sets idle timeout for the focused session", async () => {
    const binding: FakeBinding = {
      threadId: "thread-1",
      targetSessionKey: "agent:main:subagent:child",
    };
    hoisted.getThreadBindingManagerMock.mockReturnValue(createFakeThreadBindingManager(binding));
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        ...binding,
        boundAt: Date.now(),
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
  });

  it("shows active idle timeout when no value is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const binding: FakeBinding = {
      threadId: "thread-1",
      targetSessionKey: "agent:main:subagent:child",
      idleTimeoutMs: 2 * 60 * 60 * 1000,
      lastActivityAt: new Date("2026-02-20T00:00:00.000Z").getTime(),
    };
    hoisted.getThreadBindingManagerMock.mockReturnValue(createFakeThreadBindingManager(binding));

    const result = await handleSessionCommand(createDiscordCommandParams("/session idle"), true);
    expect(result?.reply?.text).toContain("Idle timeout active (2h");
  });

  it("disables idle timeout when set to off", async () => {
    const binding: FakeBinding = {
      threadId: "thread-1",
      targetSessionKey: "agent:main:subagent:child",
      idleTimeoutMs: 2 * 60 * 60 * 1000,
      lastActivityAt: Date.now(),
    };
    hoisted.getThreadBindingManagerMock.mockReturnValue(createFakeThreadBindingManager(binding));
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      { ...binding, boundAt: Date.now(), idleTimeoutMs: 0 },
    ]);

    const result = await handleSessionCommand(
      createDiscordCommandParams("/session idle off"),
      true,
    );

    expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      idleTimeoutMs: 0,
    });
    expect(result?.reply?.text).toContain("Idle timeout disabled");
  });

  it("is unavailable outside discord", async () => {
    const params = buildCommandTestParams("/session idle 2h", baseCfg);
    const result = await handleSessionCommand(params, true);
    expect(result?.reply?.text).toContain("currently available for Discord thread-bound sessions");
  });

  it("requires binding owner for updates", async () => {
    const binding: FakeBinding = {
      threadId: "thread-1",
      targetSessionKey: "agent:main:subagent:child",
      boundBy: "owner-1",
    };
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
