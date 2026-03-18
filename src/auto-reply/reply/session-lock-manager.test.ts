import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalSessionLockManager,
  RedisSessionLockManager,
  getAcpSessionLockManager,
  resetAcpSessionLockManagerForTests,
  resolveAcpSessionLockTtlMs,
} from "./session-lock-manager.js";

describe("LocalSessionLockManager", () => {
  it("acquires and releases session locks", async () => {
    const manager = new LocalSessionLockManager();

    const first = await manager.acquire("session-1", 5_000);
    expect(first.acquired).toBe(true);
    if (!first.acquired) {
      throw new Error("expected first lock to be acquired");
    }
    const second = await manager.acquire("session-1", 5_000);
    expect(second).toEqual({ acquired: false });

    await manager.release("session-1", first.ownerId);
    const third = await manager.acquire("session-1", 5_000);
    expect(third.acquired).toBe(true);
  });

  it("blocks concurrent acquire for the same session key", async () => {
    const manager = new LocalSessionLockManager();
    const [a, b] = await Promise.all([
      manager.acquire("session-2", 5_000),
      manager.acquire("session-2", 5_000),
    ]);
    expect([a.acquired, b.acquired].toSorted((x, y) => Number(x) - Number(y))).toEqual([
      false,
      true,
    ]);
  });

  it("only allows the current owner to release", async () => {
    const manager = new LocalSessionLockManager();
    const first = await manager.acquire("session-3", 5_000);
    expect(first.acquired).toBe(true);
    if (!first.acquired) {
      throw new Error("expected lock to be acquired");
    }

    await manager.release("session-3", "wrong-owner");
    const blocked = await manager.acquire("session-3", 5_000);
    expect(blocked).toEqual({ acquired: false });

    await manager.release("session-3", first.ownerId);
    const reopened = await manager.acquire("session-3", 5_000);
    expect(reopened.acquired).toBe(true);
  });

  it("renews lock ttl only for the current owner", async () => {
    vi.useFakeTimers();
    try {
      const manager = new LocalSessionLockManager();
      const first = await manager.acquire("session-4", 1_000);
      expect(first.acquired).toBe(true);
      if (!first.acquired) {
        throw new Error("expected lock to be acquired");
      }

      vi.advanceTimersByTime(700);
      const wrongOwnerRenewed = await manager.renew("session-4", "wrong-owner", 1_000);
      expect(wrongOwnerRenewed).toBe(false);

      const renewed = await manager.renew("session-4", first.ownerId, 1_000);
      expect(renewed).toBe(true);

      vi.advanceTimersByTime(700);
      const blocked = await manager.acquire("session-4", 1_000);
      expect(blocked).toEqual({ acquired: false });

      vi.advanceTimersByTime(400);
      const afterExpiry = await manager.acquire("session-4", 1_000);
      expect(afterExpiry.acquired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RedisSessionLockManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("acquire uses NX+PX and returns false when lock exists", async () => {
    const values = new Map<string, string>();
    const runRedisCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "SET") {
        const [_, key, value] = args;
        if (values.has(key)) {
          return null;
        }
        values.set(key, value);
        return "OK";
      }
      throw new Error(`unsupported command: ${args.join(" ")}`);
    });
    const manager = new RedisSessionLockManager({
      runRedisCommand,
      ownerIdFactory: () => "owner-1",
    });

    const acquired = await manager.acquire("session-5", 9_000);
    expect(acquired).toEqual({ acquired: true, ownerId: "owner-1" });
    const blocked = await manager.acquire("session-5", 9_000);
    expect(blocked).toEqual({ acquired: false });
    expect(runRedisCommand).toHaveBeenCalledWith([
      "SET",
      "lock:acp:session:session-5",
      "owner-1",
      "NX",
      "PX",
      "9000",
    ]);
  });

  it("only owner can release and renew", async () => {
    const values = new Map<string, string>();
    const runRedisCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "SET") {
        const [_, key, value] = args;
        if (values.has(key)) {
          return null;
        }
        values.set(key, value);
        return "OK";
      }
      if (args[0] === "EVAL") {
        const [_, script, __, key, ownerId] = args;
        if (script.includes("DEL")) {
          if (values.get(key) === ownerId) {
            values.delete(key);
            return 1;
          }
          return 0;
        }
        if (script.includes("PEXPIRE")) {
          const ttl = Number.parseInt(args[5] ?? "", 10);
          expect(ttl).toBe(7_000);
          return values.get(key) === ownerId ? 1 : 0;
        }
      }
      throw new Error(`unsupported command: ${args.join(" ")}`);
    });
    const manager = new RedisSessionLockManager({
      runRedisCommand,
      ownerIdFactory: () => "owner-2",
    });
    const acquired = await manager.acquire("session-6", 7_000);
    expect(acquired).toEqual({ acquired: true, ownerId: "owner-2" });

    const wrongOwnerRenew = await manager.renew("session-6", "wrong-owner", 7_000);
    expect(wrongOwnerRenew).toBe(false);
    const ownerRenew = await manager.renew("session-6", "owner-2", 7_000);
    expect(ownerRenew).toBe(true);

    await manager.release("session-6", "wrong-owner");
    const stillBlocked = await manager.acquire("session-6", 7_000);
    expect(stillBlocked).toEqual({ acquired: false });

    await manager.release("session-6", "owner-2");
    const reopened = await manager.acquire("session-6", 7_000);
    expect(reopened).toEqual({ acquired: true, ownerId: "owner-2" });
  });
});

describe("session lock manager selection", () => {
  beforeEach(() => {
    resetAcpSessionLockManagerForTests();
  });

  it("defaults to local lock manager when Redis is not configured", () => {
    const manager = getAcpSessionLockManager({});
    expect(manager).toBeInstanceOf(LocalSessionLockManager);
  });

  it("fails closed when Redis is configured but initialization fails", async () => {
    const manager = getAcpSessionLockManager({
      OPENCLAW_ACP_SESSION_LOCK_REDIS_URL: "http://redis.example",
    });
    expect(manager).not.toBeInstanceOf(LocalSessionLockManager);
    await expect(manager.acquire("session-7", 1_000)).rejects.toThrow(
      "Redis ACP session lock manager unavailable",
    );
  });

  it("uses default ttl when env is missing or invalid", () => {
    expect(resolveAcpSessionLockTtlMs({})).toBe(120_000);
    expect(resolveAcpSessionLockTtlMs({ OPENCLAW_ACP_SESSION_LOCK_TTL_MS: "nope" })).toBe(120_000);
    expect(resolveAcpSessionLockTtlMs({ OPENCLAW_ACP_SESSION_LOCK_TTL_MS: "2000" })).toBe(2_000);
  });
});
