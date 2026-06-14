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
const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;

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
    if (originalOpenClawStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
    }
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
    expect(performReset).toHaveBeenCalledWith(
      sessionKey,
      {
        sessionId: "old-session",
        updatedAt: beforeReset,
      },
      { agentId: "main" },
    );
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

  it("does not use idle expiry to reset daily sessions before the next daily boundary", async () => {
    const sessionStartedAt = new Date(2026, 4, 18, 13, 0, 0, 0).getTime();
    const lastInteractionAt = new Date(2026, 4, 18, 13, 30, 0, 0).getTime();
    const beforeNoonReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const sessionKey = "agent:main:telegram:direct:user-1";
    const { cfg } = await makeStore({
      [sessionKey]: {
        sessionId: "idle-expired-session",
        updatedAt: lastInteractionAt,
        sessionStartedAt,
        lastInteractionAt,
      },
    });
    cfg.session = {
      ...cfg.session,
      reset: {
        mode: "daily",
        atHour: 12,
        idleMinutes: 30,
      },
    };
    const performReset = vi.fn(async () => ({ ok: true }));

    const result = await resetStaleDailySessions({
      cfg,
      nowMs: beforeNoonReset,
      performReset,
    });

    expect(result).toEqual({ checked: 1, reset: 0, errors: 0 });
    expect(performReset).not.toHaveBeenCalled();
  });

  it("uses session start, not post-boundary metadata writes, for scheduled daily staleness", async () => {
    const beforeReset = new Date(2026, 4, 18, 23, 0, 0, 0).getTime();
    const afterReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const sessionKey = "agent:main:telegram:direct:user-1";
    const { cfg } = await makeStore({
      [sessionKey]: {
        sessionId: "old-session",
        updatedAt: afterReset,
        sessionStartedAt: beforeReset,
        lastInteractionAt: afterReset,
      },
    });
    const performReset = vi.fn(async () => ({ ok: true }));

    const result = await resetStaleDailySessions({
      cfg,
      nowMs: afterReset,
      performReset,
    });

    expect(result).toEqual({ checked: 1, reset: 1, errors: 0 });
    expect(performReset).toHaveBeenCalledWith(
      sessionKey,
      {
        sessionId: "old-session",
        updatedAt: afterReset,
      },
      { agentId: "main" },
    );
  });

  it("evaluates duplicate session rows as one freshest alias group", async () => {
    const beforeReset = new Date(2026, 4, 18, 23, 0, 0, 0).getTime();
    const afterReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const canonicalKey = "agent:main:telegram:direct:user-1";
    const legacyCaseKey = "agent:main:Telegram:Direct:User-1";
    const { cfg } = await makeStore({
      [legacyCaseKey]: {
        sessionId: "old-legacy-session",
        updatedAt: beforeReset,
        sessionStartedAt: beforeReset,
      },
      [canonicalKey]: {
        sessionId: "fresh-canonical-session",
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

  it("skips stale duplicate rows from non-authoritative discovered stores", async () => {
    const beforeReset = new Date(2026, 4, 18, 23, 0, 0, 0).getTime();
    const afterReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const sessionKey = "agent:main:telegram:direct:user-1";
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-reset-"));
    tmpDirs.push(rootDir);
    const configuredStorePath = path.join(
      rootDir,
      "configured",
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    const discoveredStorePath = path.join(
      rootDir,
      "state",
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    await fs.mkdir(path.dirname(configuredStorePath), { recursive: true });
    await fs.mkdir(path.dirname(discoveredStorePath), { recursive: true });
    await fs.writeFile(
      configuredStorePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "fresh-canonical-session",
          updatedAt: afterReset,
          sessionStartedAt: afterReset,
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      discoveredStorePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "old-discovered-session",
          updatedAt: beforeReset,
          sessionStartedAt: beforeReset,
        },
      }),
      "utf8",
    );
    process.env.OPENCLAW_STATE_DIR = path.join(rootDir, "state");
    const cfg = {
      session: {
        store: path.join(rootDir, "configured", "agents", "{agentId}", "sessions", "sessions.json"),
        reset: {
          mode: "daily",
          atHour: 4,
        },
      },
      agents: {
        list: [{ id: "main" }],
      },
    } as OpenClawConfig;
    const performReset = vi.fn(async () => ({ ok: true }));

    const result = await resetStaleDailySessions({
      cfg,
      nowMs: afterReset,
      performReset,
    });

    expect(result).toEqual({ checked: 1, reset: 0, errors: 0 });
    expect(performReset).not.toHaveBeenCalled();
  });

  it("respects active-run guards for any duplicate session row", async () => {
    const beforeReset = new Date(2026, 4, 18, 23, 0, 0, 0).getTime();
    const afterReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const canonicalKey = "agent:main:telegram:direct:user-1";
    const legacyCaseKey = "agent:main:Telegram:Direct:User-1";
    const { cfg } = await makeStore({
      [canonicalKey]: {
        sessionId: "old-canonical-session",
        updatedAt: beforeReset,
        sessionStartedAt: beforeReset,
      },
      [legacyCaseKey]: {
        sessionId: "old-legacy-session",
        updatedAt: beforeReset,
        sessionStartedAt: beforeReset,
      },
    });
    const performReset = vi.fn(async () => ({ ok: true }));

    const result = await resetStaleDailySessions({
      cfg,
      nowMs: afterReset,
      activeSessionKeys: new Set([legacyCaseKey]),
      performReset,
    });

    expect(result).toEqual({ checked: 0, reset: 0, errors: 0 });
    expect(performReset).not.toHaveBeenCalled();
  });

  it("skips a stale selection when a fresh session is written before reset mutation", async () => {
    const beforeReset = new Date(2026, 4, 18, 23, 0, 0, 0).getTime();
    const afterReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const sessionKey = "agent:main:telegram:direct:user-1";
    const { cfg, storePath } = await makeStore({
      [sessionKey]: {
        sessionId: "old-session",
        updatedAt: beforeReset,
        sessionStartedAt: beforeReset,
      },
    });
    const performReset = vi.fn(async (_key, expected) => {
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "fresh-session",
            updatedAt: afterReset,
            sessionStartedAt: afterReset,
          },
        }),
        "utf8",
      );
      const current = JSON.parse(await fs.readFile(storePath, "utf8"))[sessionKey];
      return current.sessionId === expected?.sessionId && current.updatedAt === expected.updatedAt
        ? { ok: true }
        : { ok: false, skipped: true };
    });

    const result = await resetStaleDailySessions({
      cfg,
      nowMs: afterReset,
      performReset,
    });

    expect(result).toEqual({ checked: 1, reset: 0, errors: 0 });
    expect(performReset).toHaveBeenCalledWith(
      sessionKey,
      {
        sessionId: "old-session",
        updatedAt: beforeReset,
      },
      { agentId: "main" },
    );
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

    expect(performReset).toHaveBeenCalledWith(
      sessionKey,
      {
        sessionId: "old-session",
        updatedAt: beforeReset,
      },
      { agentId: "main" },
    );
    clearInterval(timer);
  });

  it("passes the selected agent when resetting a non-default global session", async () => {
    const beforeReset = new Date(2026, 4, 18, 23, 0, 0, 0).getTime();
    const afterReset = new Date(2026, 4, 19, 8, 0, 0, 0).getTime();
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-daily-reset-"));
    tmpDirs.push(rootDir);
    const mainStorePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const workStorePath = path.join(rootDir, "agents", "work", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(mainStorePath), { recursive: true });
    await fs.mkdir(path.dirname(workStorePath), { recursive: true });
    await fs.writeFile(mainStorePath, JSON.stringify({}), "utf8");
    await fs.writeFile(
      workStorePath,
      JSON.stringify({
        global: {
          sessionId: "work-old-session",
          updatedAt: beforeReset,
          sessionStartedAt: beforeReset,
        },
      }),
      "utf8",
    );
    const cfg = {
      session: {
        scope: "global",
        store: path.join(rootDir, "agents", "{agentId}", "sessions", "sessions.json"),
        reset: {
          mode: "daily",
          atHour: 4,
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "work" }],
      },
    } as OpenClawConfig;
    const performReset = vi.fn(async () => ({ ok: true }));

    const result = await resetStaleDailySessions({
      cfg,
      nowMs: afterReset,
      performReset,
    });

    expect(result).toEqual({ checked: 1, reset: 1, errors: 0 });
    expect(performReset).toHaveBeenCalledWith(
      "global",
      {
        sessionId: "work-old-session",
        updatedAt: beforeReset,
      },
      { agentId: "work" },
    );
  });

  it("notifies successful scheduled daily resets with the canonical session key", async () => {
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
    const onSuccessfulReset = vi.fn();

    const result = await resetStaleDailySessions({
      cfg,
      nowMs: afterReset,
      performReset,
      onSuccessfulReset,
    });

    expect(result).toEqual({ checked: 1, reset: 1, errors: 0 });
    expect(onSuccessfulReset).toHaveBeenCalledWith({
      sessionKey,
      agentId: "main",
    });
  });
});
