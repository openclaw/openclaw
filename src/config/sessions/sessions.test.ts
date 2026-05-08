import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import type { OpenClawConfig } from "../config.js";
import type { SessionConfig } from "../types.base.js";
import { resolveSessionLifecycleTimestamps } from "./lifecycle.js";
import {
  createSqliteSessionTranscriptLocator,
  resolveSessionTranscriptLocator,
  validateSessionId,
} from "./paths.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "./reset.js";
import { resolveAndPersistSessionTranscriptLocator } from "./session-locator.js";
import {
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  upsertSessionEntry,
} from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { replaceSqliteSessionTranscriptEvents } from "./transcript-store.sqlite.js";
import { mergeSessionEntry, mergeSessionEntryWithPolicy, type SessionEntry } from "./types.js";

describe("session path safety", () => {
  it("rejects unsafe session IDs", () => {
    const unsafeSessionIds = [
      "../etc/passwd",
      "a/b",
      "a\\b",
      "/abs",
      "sess.checkpoint.11111111-1111-4111-8111-111111111111",
    ];
    for (const sessionId of unsafeSessionIds) {
      expect(() => validateSessionId(sessionId), sessionId).toThrow(/Invalid session ID/);
    }
  });

  it("ignores legacy sessionFile paths", () => {
    const resolved = resolveSessionTranscriptLocator("sess-1", {
      sessionFile: "/tmp/openclaw/agents/work/not-sessions/abc-123.jsonl",
    });
    expect(resolved).toBe(createSqliteSessionTranscriptLocator({ sessionId: "sess-1" }));
  });

  it("uses SQLite transcript locators instead of runtime JSONL paths by default", () => {
    expect(
      resolveSessionTranscriptLocator("sess-1", {
        sessionFile: "/tmp/openclaw/agents/main/sessions/legacy.jsonl",
      }),
    ).toBe(createSqliteSessionTranscriptLocator({ sessionId: "sess-1" }));
  });
});

describe("resolveSessionResetPolicy", () => {
  describe("backward compatibility: resetByType.dm -> direct", () => {
    it("does not use dm fallback for group/thread types", () => {
      const sessionCfg = {
        resetByType: {
          dm: { mode: "idle" as const, idleMinutes: 45 },
        },
      } as unknown as SessionConfig;

      const groupPolicy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "group",
      });

      expect(groupPolicy.mode).toBe("daily");
    });
  });

  it("defaults to daily resets at 4am local time", () => {
    const policy = resolveSessionResetPolicy({
      resetType: "direct",
    });

    expect(policy).toMatchObject({
      mode: "daily",
      atHour: 4,
    });
  });

  it("treats idleMinutes=0 as never expiring by inactivity", () => {
    const freshness = evaluateSessionFreshness({
      updatedAt: 1_000,
      now: 60 * 60 * 1_000,
      policy: {
        mode: "idle",
        atHour: 4,
        idleMinutes: 0,
      },
    });

    expect(freshness).toEqual({
      fresh: true,
      dailyResetAt: undefined,
      idleExpiresAt: undefined,
    });
  });

  it("uses sessionStartedAt, not updatedAt, for daily reset freshness", () => {
    const now = new Date(2026, 3, 25, 12, 0, 0, 0).getTime();
    const freshness = evaluateSessionFreshness({
      updatedAt: now,
      sessionStartedAt: now - 25 * 60 * 60_000,
      now,
      policy: {
        mode: "daily",
        atHour: 4,
      },
    });

    expect(freshness.fresh).toBe(false);
  });

  it("uses lastInteractionAt, not updatedAt, for idle reset freshness", () => {
    const now = 60 * 60_000;
    const freshness = evaluateSessionFreshness({
      updatedAt: now,
      lastInteractionAt: 0,
      now,
      policy: {
        mode: "idle",
        atHour: 4,
        idleMinutes: 5,
      },
    });

    expect(freshness).toMatchObject({
      fresh: false,
      idleExpiresAt: 5 * 60_000,
    });
  });

  it("falls back to sessionStartedAt, not updatedAt, for legacy idle freshness", () => {
    const now = 60 * 60_000;
    const freshness = evaluateSessionFreshness({
      updatedAt: now,
      sessionStartedAt: 0,
      now,
      policy: {
        mode: "idle",
        atHour: 4,
        idleMinutes: 5,
      },
    });

    expect(freshness).toMatchObject({
      fresh: false,
      idleExpiresAt: 5 * 60_000,
    });
  });

  it("does not let future legacy updatedAt values keep daily sessions fresh", () => {
    const now = new Date(2026, 3, 25, 12, 0, 0, 0).getTime();
    const freshness = evaluateSessionFreshness({
      updatedAt: now + 30 * 24 * 60 * 60_000,
      now,
      policy: {
        mode: "daily",
        atHour: 4,
      },
    });

    expect(freshness.fresh).toBe(false);
  });

  it("does not let future legacy updatedAt values keep idle sessions fresh", () => {
    const now = 60 * 60_000;
    const freshness = evaluateSessionFreshness({
      updatedAt: now + 30 * 24 * 60 * 60_000,
      now,
      policy: {
        mode: "idle",
        atHour: 4,
        idleMinutes: 5,
      },
    });

    expect(freshness).toMatchObject({
      fresh: false,
      idleExpiresAt: 5 * 60_000,
    });
  });
});

describe("session lifecycle timestamps", () => {
  it("falls back to the SQLite transcript header for session start time", async () => {
    const dir = await fsPromises.mkdtemp("/tmp/openclaw-lifecycle-test-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = dir;
    try {
      const sessionsDir = path.join(dir, "agents", "main", "sessions");
      const sessionFile = path.join(sessionsDir, "legacy-session.jsonl");
      const headerTimestamp = "2026-04-20T04:30:00.000Z";
      replaceSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "legacy-session",
        transcriptPath: sessionFile,
        events: [
          {
            type: "session",
            version: 3,
            id: "legacy-session",
            timestamp: headerTimestamp,
            cwd: dir,
          },
        ],
      });

      const timestamps = resolveSessionLifecycleTimestamps({
        agentId: "main",
        entry: {
          sessionId: "legacy-session",
          sessionFile,
          updatedAt: Date.parse("2026-04-25T08:00:00.000Z"),
        },
      });

      expect(timestamps.sessionStartedAt).toBe(Date.parse(headerTimestamp));
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores legacy transcript files that were not imported", async () => {
    const dir = await fsPromises.mkdtemp("/tmp/openclaw-lifecycle-test-");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = dir;
    try {
      const sessionsDir = path.join(dir, "agents", "main", "sessions");
      const sessionFile = path.join(sessionsDir, "legacy-session.jsonl");
      await fsPromises.mkdir(path.dirname(sessionFile), { recursive: true });
      await fsPromises.writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "legacy-session",
          timestamp: "2026-04-20T04:30:00.000Z",
          cwd: dir,
        })}\n`,
        "utf8",
      );

      const timestamps = resolveSessionLifecycleTimestamps({
        agentId: "main",
        entry: {
          sessionId: "legacy-session",
          sessionFile,
          updatedAt: Date.parse("2026-04-25T08:00:00.000Z"),
        },
      });

      expect(timestamps.sessionStartedAt).toBeUndefined();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("SQLite session store patch retries", () => {
  const patchFixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-patch-test-" });
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  async function makeTmpStore(
    initial: Record<string, unknown> = {},
    options: { agentId?: string } = {},
  ): Promise<{ dir: string; agentId: string; sessionsDir: string }> {
    const dir = await patchFixtureRootTracker.make("case");
    process.env.OPENCLAW_STATE_DIR = dir;
    const agentId = options.agentId ?? "main";
    const sessionsDir = path.join(dir, "agents", agentId, "sessions");
    for (const [sessionKey, entry] of Object.entries(initial)) {
      upsertSessionEntry({ agentId, sessionKey, entry: entry as SessionEntry });
    }
    return { dir, agentId, sessionsDir };
  }

  function readSessionEntries(agentId = "main"): Record<string, SessionEntry> {
    return Object.fromEntries(
      listSessionEntries({ agentId }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
  }

  beforeAll(async () => {
    await patchFixtureRootTracker.setup();
  });

  afterAll(async () => {
    await patchFixtureRootTracker.cleanup();
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("serializes concurrent patchSessionEntry calls without data loss", async () => {
    const key = "agent:main:test";
    const { agentId } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: Date.now(), heartbeatTaskState: { counter: 0 } },
    });

    const N = 4;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        patchSessionEntry({
          agentId,
          sessionKey: key,
          update: async (entry) => {
            const current = entry.heartbeatTaskState?.counter ?? 0;
            await Promise.resolve();
            return {
              heartbeatTaskState: { counter: current + 1, [`patch-${i}`]: i },
            };
          },
        }),
      ),
    );

    const store = readSessionEntries(agentId);
    expect(store[key]?.heartbeatTaskState?.counter).toBe(N);
  });

  it("keeps SQLite rows when a patch returns no changes", async () => {
    const key = "agent:main:no-op-save";
    const { agentId } = await makeTmpStore({
      [key]: { sessionId: "s-noop", updatedAt: Date.now() },
    });

    await patchSessionEntry({
      agentId,
      sessionKey: key,
      update: async () => {
        // Intentionally no-op mutation.
        return null;
      },
    });
    expect(getSessionEntry({ agentId, sessionKey: key })?.sessionId).toBe("s-noop");
  });

  it("multiple consecutive errors do not block later writes", async () => {
    const key = "agent:main:multi-err";
    const { agentId } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: Date.now() },
    });

    const errors = Array.from({ length: 3 }, (_, i) =>
      patchSessionEntry({
        agentId,
        sessionKey: key,
        update: async () => {
          throw new Error(`fail-${i}`);
        },
      }),
    );

    const success = patchSessionEntry({
      agentId,
      sessionKey: key,
      update: async () => ({ modelOverride: "recovered" }),
    });

    for (const [index, p] of errors.entries()) {
      await expect(p).rejects.toThrow(`fail-${index}`);
    }
    await success;

    const store = readSessionEntries(agentId);
    expect(store[key]?.modelOverride).toBe("recovered");
  });

  it("clears stale runtime provider when model is patched without provider", () => {
    const merged = mergeSessionEntry(
      {
        sessionId: "sess-runtime",
        updatedAt: 100,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
      },
      {
        model: "gpt-5.4",
      },
    );
    expect(merged.model).toBe("gpt-5.4");
    expect(merged.modelProvider).toBeUndefined();
  });

  it("caps future updatedAt values at the session merge boundary", () => {
    const now = 1_000;
    const merged = mergeSessionEntryWithPolicy(
      {
        sessionId: "sess-future",
        updatedAt: now + 10_000,
      },
      {
        updatedAt: now + 20_000,
      },
      { now },
    );

    expect(merged.updatedAt).toBe(now);
  });

  it("caps future updatedAt values while preserving activity", () => {
    const now = 1_000;
    const merged = mergeSessionEntryWithPolicy(
      {
        sessionId: "sess-preserve-future",
        updatedAt: now + 10_000,
      },
      {},
      { now, policy: "preserve-activity" },
    );

    expect(merged.updatedAt).toBe(now);
  });

  it("normalizes orphan modelProvider fields at store write boundary", async () => {
    const key = "agent:main:orphan-provider";
    const { agentId } = await makeTmpStore({
      [key]: {
        sessionId: "sess-orphan",
        updatedAt: 100,
        modelProvider: "anthropic",
      },
    });

    const store = readSessionEntries(agentId);
    expect(store[key]?.modelProvider).toBeUndefined();
    expect(store[key]?.model).toBeUndefined();
  });

  it("preserves ACP metadata when patching a session entry", async () => {
    const key = "agent:codex:acp:binding:discord:default:feedface";
    const acp = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "codex-discord",
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 100,
    };
    const { agentId } = await makeTmpStore({
      [key]: {
        sessionId: "sess-acp",
        updatedAt: Date.now(),
        acp,
      },
    });

    await patchSessionEntry({
      agentId,
      sessionKey: key,
      update: () => {
        return {
          updatedAt: Date.now(),
          modelProvider: "openai-codex",
          model: "gpt-5.4",
        };
      },
    });

    const store = readSessionEntries(agentId);
    expect(store[key]?.acp).toEqual(acp);
    expect(store[key]?.modelProvider).toBe("openai-codex");
    expect(store[key]?.model).toBe("gpt-5.4");
  });

  it("allows explicit ACP metadata removal through the ACP session helper", async () => {
    const key = "agent:codex:acp:binding:discord:default:deadbeef";
    const { agentId } = await makeTmpStore(
      {
        [key]: {
          sessionId: "sess-acp-clear",
          updatedAt: 100,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "codex-discord",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 100,
          },
        },
      },
      { agentId: "codex" },
    );
    const cfg = {
      session: {},
    } as OpenClawConfig;

    const result = await upsertAcpSessionMeta({
      cfg,
      sessionKey: key,
      mutate: () => null,
    });

    expect(result?.acp).toBeUndefined();
    expect(getSessionEntry({ agentId, sessionKey: key })?.acp).toBeUndefined();
  });
});

describe("resolveAndPersistSessionTranscriptLocator", () => {
  const fixture = useTempSessionsFixture("session-locator-test-");

  function readFixtureSessionEntries(): Record<string, SessionEntry> {
    return Object.fromEntries(
      listSessionEntries({ agentId: "main" }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
  }

  function seedFixtureSessionEntries(store: Record<string, SessionEntry>): void {
    for (const [sessionKey, entry] of Object.entries(store)) {
      upsertSessionEntry({ agentId: "main", sessionKey, entry });
    }
  }

  it("persists fallback topic transcript locators for sessions without sessionFile", async () => {
    const sessionId = "topic-session-id";
    const sessionKey = "agent:main:telegram:group:123:topic:456";
    const store = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    seedFixtureSessionEntries(store);
    const sessionStore = readFixtureSessionEntries();
    const fallbackTranscriptLocator = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId,
      topicId: 456,
    });

    const result = await resolveAndPersistSessionTranscriptLocator({
      sessionId,
      sessionKey,
      sessionEntry: sessionStore[sessionKey],
      agentId: "main",
      fallbackTranscriptLocator,
    });

    expect(result.transcriptLocator).toBe(fallbackTranscriptLocator);

    const saved = readFixtureSessionEntries();
    expect(saved[sessionKey]?.sessionFile).toBe(fallbackTranscriptLocator);
  });

  it("creates and persists a SQLite locator when session is not yet present", async () => {
    const sessionId = "new-session-id";
    const sessionKey = "agent:main:telegram:group:123";
    const legacyFallbackPath = path.join(fixture.sessionsDir(), `${sessionId}.jsonl`);
    const expectedTranscriptLocator = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId,
    });

    const result = await resolveAndPersistSessionTranscriptLocator({
      sessionId,
      sessionKey,
      agentId: "main",
      fallbackTranscriptLocator: legacyFallbackPath,
    });

    expect(result.transcriptLocator).toBe(expectedTranscriptLocator);
    expect(result.sessionEntry.sessionId).toBe(sessionId);
    const saved = readFixtureSessionEntries();
    expect(saved[sessionKey]?.sessionFile).toBe(expectedTranscriptLocator);
  });

  it("normalizes legacy stored transcript paths to SQLite locators", async () => {
    const sessionId = "legacy-path-session-id";
    const sessionKey = "agent:main:telegram:group:456";
    const legacySessionFile = path.join(fixture.sessionsDir(), `${sessionId}.jsonl`);
    const expectedTranscriptLocator = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId,
    });
    seedFixtureSessionEntries({
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        sessionFile: legacySessionFile,
      },
    });
    const sessionStore = readFixtureSessionEntries();

    const result = await resolveAndPersistSessionTranscriptLocator({
      sessionId,
      sessionKey,
      sessionEntry: sessionStore[sessionKey],
      agentId: "main",
    });

    expect(result.transcriptLocator).toBe(expectedTranscriptLocator);
    expect(result.sessionEntry.sessionFile).toBe(expectedTranscriptLocator);
    expect(readFixtureSessionEntries()[sessionKey]?.sessionFile).toBe(expectedTranscriptLocator);
  });

  it("rotates to a new SQLite locator when sessionId changes on the same session key", async () => {
    const previousSessionId = "old-session-id";
    const nextSessionId = "new-session-id";
    const sessionKey = "agent:main:telegram:group:123";
    const previousSessionFile = path.join(fixture.sessionsDir(), `${previousSessionId}.jsonl`);
    const expectedNextTranscriptLocator = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: nextSessionId,
    });
    const store = {
      [sessionKey]: {
        sessionId: previousSessionId,
        updatedAt: Date.now(),
        sessionFile: previousSessionFile,
      },
    };
    seedFixtureSessionEntries(store);
    const sessionStore = readFixtureSessionEntries();

    const result = await resolveAndPersistSessionTranscriptLocator({
      sessionId: nextSessionId,
      sessionKey,
      sessionEntry: sessionStore[sessionKey],
      agentId: "main",
    });

    expect(result.transcriptLocator).toBe(expectedNextTranscriptLocator);
    expect(result.transcriptLocator).not.toBe(previousSessionFile);
    expect(result.sessionEntry.sessionFile).toBe(expectedNextTranscriptLocator);

    const saved = readFixtureSessionEntries();
    expect(saved[sessionKey]?.sessionFile).toBe(expectedNextTranscriptLocator);
  });
});
