import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  saveSessionStore,
  updateSessionStoreEntry,
} from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { MsgContext } from "../templating.js";
import { initSessionState } from "./session.js";

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

describe("initSessionState - compaction metadata preserves reset freshness", () => {
  let tempDir: string;
  let storePath: string;

  const sessionKey = "main:user123";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp("/tmp/openclaw-test-compaction-reset-");
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const createConfig = (session: OpenClawConfig["session"]): OpenClawConfig => ({
    agents: {
      defaults: { workspace: tempDir },
      list: [{ id: "main", workspace: tempDir }],
    },
    session: {
      store: storePath,
      ...session,
    },
    channels: {},
    gateway: {
      port: 18789,
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: "test" },
    },
    plugins: { entries: {} },
  });

  const createCtx = (overrides?: Partial<MsgContext>): MsgContext => ({
    Body: "test message",
    From: "user123",
    To: "bot123",
    SessionKey: sessionKey,
    Provider: "quietchat",
    Surface: "quietchat",
    ChatType: "direct",
    CommandAuthorized: true,
    ...overrides,
  });

  const saveLegacySession = async (
    sessionId: string,
    updatedAt: number,
    overrides: Partial<SessionEntry> = {},
  ): Promise<void> => {
    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt,
        systemSent: true,
        ...overrides,
      },
    });
  };

  const persistFlushMetadata = async (memoryFlushAt: number): Promise<void> => {
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      preserveActivity: true,
      update: async () => ({
        memoryFlushAt,
        memoryFlushCompactionCount: 2,
      }),
    });
  };

  it("resets a legacy daily session after post-boundary compaction metadata", async () => {
    const boundary = new Date(2026, 3, 28, 4, 0, 0, 0).getTime();
    const lastRealActivity = boundary - 60 * 60_000;
    const memoryFlushAt = boundary + 30 * 60_000;
    await saveLegacySession("legacy-daily-session", lastRealActivity);
    await persistFlushMetadata(memoryFlushAt);

    const storeAfterFlush = loadSessionStore(storePath);
    expect(storeAfterFlush[sessionKey]?.updatedAt).toBe(lastRealActivity);
    expect(storeAfterFlush[sessionKey]?.memoryFlushAt).toBe(memoryFlushAt);

    vi.useFakeTimers();
    vi.setSystemTime(boundary + 31 * 60_000);
    const result = await initSessionState({
      ctx: createCtx({ Body: "good morning" }),
      cfg: createConfig({ reset: { mode: "daily", atHour: 4 } }),
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe("legacy-daily-session");
  });

  it("resets a legacy idle session after recent compaction metadata", async () => {
    const lastRealActivity = new Date(2026, 3, 28, 10, 0, 0, 0).getTime();
    const memoryFlushAt = lastRealActivity + 9.5 * 60_000;
    const now = lastRealActivity + 10 * 60_000;
    await saveLegacySession("legacy-idle-session", lastRealActivity);
    await persistFlushMetadata(memoryFlushAt);

    const storeAfterFlush = loadSessionStore(storePath);
    expect(storeAfterFlush[sessionKey]?.updatedAt).toBe(lastRealActivity);
    expect(storeAfterFlush[sessionKey]?.memoryFlushAt).toBe(memoryFlushAt);

    vi.useFakeTimers();
    vi.setSystemTime(now);
    const result = await initSessionState({
      ctx: createCtx({ Body: "hello again" }),
      cfg: createConfig({ reset: { mode: "idle", idleMinutes: 5 } }),
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe("legacy-idle-session");
  });

  it("keeps a modern idle session fresh based on lastInteractionAt", async () => {
    const lastRealActivity = new Date(2026, 3, 28, 10, 0, 0, 0).getTime();
    const memoryFlushAt = lastRealActivity + 9.5 * 60_000;
    const now = lastRealActivity + 10 * 60_000;
    await saveLegacySession("modern-idle-session", lastRealActivity, {
      sessionStartedAt: lastRealActivity - 60 * 60_000,
      lastInteractionAt: memoryFlushAt,
    });
    await persistFlushMetadata(memoryFlushAt);

    vi.useFakeTimers();
    vi.setSystemTime(now);
    const result = await initSessionState({
      ctx: createCtx({ Body: "hello again" }),
      cfg: createConfig({ reset: { mode: "idle", idleMinutes: 5 } }),
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("modern-idle-session");
  });
});
