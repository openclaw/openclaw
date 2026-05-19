import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resetStaleDailySessions,
  startDailySessionResetScheduler,
} from "./session-daily-reset-scheduler.js";

const tmpDirs: string[] = [];

async function makeStore(entries: Record<string, unknown>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-reset-"));
  tmpDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(entries), "utf8");
  const cfg = {
    session: {
      store: storePath,
      reset: {
        mode: "daily",
        atHour: 4,
      },
    },
    agents: {
      list: [{ id: "main" }],
    },
  } as OpenClawConfig;
  return { cfg, storePath };
}

describe("daily session reset scheduler", () => {
  afterEach(async () => {
    vi.useRealTimers();
    for (const dir of tmpDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resets stale daily sessions without waiting for an inbound message", async () => {
    const beforeReset = new Date(2026, 4, 18, 23, 0, 0, 0).getTime();
    const afterReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const sessionKey = "agent:main:telegram:direct:user-1";
    const { cfg } = await makeStore({
      [sessionKey]: {
        sessionId: "old-session",
        updatedAt: beforeReset,
        sessionStartedAt: beforeReset,
      },
    });
    const performReset = vi.fn(async () => ({ ok: true }));

    const result = await resetStaleDailySessions({
      cfg,
      nowMs: afterReset,
      performReset,
    });

    expect(result).toEqual({ checked: 1, reset: 1, errors: 0 });
    expect(performReset).toHaveBeenCalledWith(sessionKey);
  });

  it("does not reset fresh daily sessions before the next reset boundary", async () => {
    const afterReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const sessionKey = "agent:main:telegram:direct:user-1";
    const { cfg } = await makeStore({
      [sessionKey]: {
        sessionId: "fresh-session",
        updatedAt: afterReset,
        sessionStartedAt: afterReset,
      },
    });
    const performReset = vi.fn(async () => ({ ok: true }));

    const result = await resetStaleDailySessions({
      cfg,
      nowMs: afterReset,
      performReset,
    });

    expect(result).toEqual({ checked: 1, reset: 0, errors: 0 });
    expect(performReset).not.toHaveBeenCalled();
  });

  it("preserves provider-owned CLI sessions when reset policy is implicit", async () => {
    const beforeReset = new Date(2026, 4, 18, 23, 0, 0, 0).getTime();
    const afterReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const sessionKey = "agent:main:main";
    const { cfg } = await makeStore({
      [sessionKey]: {
        sessionId: "old-session",
        updatedAt: beforeReset,
        sessionStartedAt: beforeReset,
        providerOverride: "claude-cli",
        modelProvider: "claude-cli",
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "provider-session",
          },
        },
      },
    });
    cfg.session = {
      store: cfg.session?.store,
    };
    const performReset = vi.fn(async () => ({ ok: true }));

    const result = await resetStaleDailySessions({
      cfg,
      nowMs: afterReset,
      performReset,
    });

    expect(result).toEqual({ checked: 0, reset: 0, errors: 0 });
    expect(performReset).not.toHaveBeenCalled();
  });

  it("skips sessions with active runs", async () => {
    const beforeReset = new Date(2026, 4, 18, 23, 0, 0, 0).getTime();
    const afterReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const sessionKey = "agent:main:telegram:direct:user-1";
    const { cfg } = await makeStore({
      [sessionKey]: {
        sessionId: "old-session",
        updatedAt: beforeReset,
        sessionStartedAt: beforeReset,
      },
    });
    const performReset = vi.fn(async () => ({ ok: true }));

    const result = await resetStaleDailySessions({
      cfg,
      nowMs: afterReset,
      activeSessionKeys: new Set([sessionKey]),
      performReset,
    });

    expect(result).toEqual({ checked: 0, reset: 0, errors: 0 });
    expect(performReset).not.toHaveBeenCalled();
  });

  it("uses current runtime config on each scheduler sweep", async () => {
    vi.useFakeTimers();
    const beforeReset = new Date(2026, 4, 18, 23, 0, 0, 0).getTime();
    const afterReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const sessionKey = "agent:main:telegram:direct:user-1";
    const { cfg: staleAtFour } = await makeStore({
      [sessionKey]: {
        sessionId: "old-session",
        updatedAt: beforeReset,
        sessionStartedAt: beforeReset,
      },
    });
    const freshUntilNoon = {
      ...staleAtFour,
      session: {
        ...staleAtFour.session,
        reset: {
          mode: "daily",
          atHour: 12,
        },
      },
    } as OpenClawConfig;
    let currentConfig = freshUntilNoon;
    const performReset = vi.fn(async () => ({ ok: true }));

    const timer = startDailySessionResetScheduler({
      cfg: staleAtFour,
      getConfig: () => currentConfig,
      getNowMs: () => afterReset,
      intervalMs: 60_000,
      performReset,
    });
    await vi.runOnlyPendingTimersAsync();

    expect(performReset).not.toHaveBeenCalled();

    currentConfig = staleAtFour;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(performReset).toHaveBeenCalledWith(sessionKey);
    clearInterval(timer);
  });
});
