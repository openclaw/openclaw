import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnv } from "../test-utils/env.js";
import {
  buildGroupDisplayName,
  deriveSessionKey,
  resolveSessionKey,
  updateLastRoute,
} from "./sessions.js";
import {
  createSqliteSessionTranscriptLocator,
  parseSqliteSessionTranscriptLocator,
  resolveSessionTranscriptLocator,
} from "./sessions/paths.js";
import {
  deleteSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  upsertSessionEntry,
} from "./sessions/store.js";
import type { SessionEntry } from "./sessions/types.js";

describe("sessions", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  const createCaseDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-suite-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  const withStateDir = <T>(stateDir: string, fn: () => T): T =>
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, fn);

  async function createSessionStoreFixture(params: {
    prefix: string;
    entries: Record<string, Record<string, unknown>>;
  }): Promise<{ agentId: string; sessionsDir: string }> {
    const stateDir = await createCaseDir(params.prefix);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const agentId = "main";
    const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
    for (const [sessionKey, entry] of Object.entries(params.entries)) {
      upsertSessionEntry({ agentId, sessionKey, entry: entry as SessionEntry });
    }
    return { agentId, sessionsDir };
  }

  function readSessionEntries(agentId = "main"): Record<string, SessionEntry> {
    return Object.fromEntries(
      listSessionEntries({ agentId }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
  }

  function buildMainSessionEntry(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: "sess-1",
      updatedAt: 123,
      ...overrides,
    };
  }

  const deriveSessionKeyCases = [
    {
      name: "returns normalized per-sender key",
      scope: "per-sender" as const,
      ctx: { From: "chat:+1555" },
      expected: "+1555",
    },
    {
      name: "falls back to unknown when sender missing",
      scope: "per-sender" as const,
      ctx: {},
      expected: "unknown",
    },
    {
      name: "global scope returns global",
      scope: "global" as const,
      ctx: { From: "+1" },
      expected: "global",
    },
    {
      name: "keeps group chats distinct",
      scope: "per-sender" as const,
      ctx: { From: "room-123", ChatType: "group", Provider: "demo-chat" },
      expected: "demo-chat:group:room-123",
    },
    {
      name: "prefixes group keys with provider when available",
      scope: "per-sender" as const,
      ctx: { From: "room-456", ChatType: "group", Provider: "demo-chat" },
      expected: "demo-chat:group:room-456",
    },
  ] as const;

  for (const testCase of deriveSessionKeyCases) {
    it(testCase.name, () => {
      expect(deriveSessionKey(testCase.scope, testCase.ctx)).toBe(testCase.expected);
    });
  }

  it("builds discord display name with guild+channel slugs", () => {
    expect(
      buildGroupDisplayName({
        provider: "discord",
        groupChannel: "#general",
        space: "friends-of-openclaw",
        id: "123",
        key: "discord:group:123",
      }),
    ).toBe("discord:friends-of-openclaw#general");
  });

  const resolveSessionKeyCases = [
    {
      name: "keeps explicit provider when provided in group key",
      scope: "per-sender" as const,
      ctx: { From: "discord:group:12345", ChatType: "group" },
      mainKey: "main",
      expected: "agent:main:discord:group:12345",
    },
    {
      name: "collapses direct chats to main by default",
      scope: "per-sender" as const,
      ctx: { From: "+1555" },
      mainKey: undefined,
      expected: "agent:main:main",
    },
    {
      name: "collapses direct chats to main even when sender missing",
      scope: "per-sender" as const,
      ctx: {},
      mainKey: undefined,
      expected: "agent:main:main",
    },
    {
      name: "maps direct chats to main key when provided",
      scope: "per-sender" as const,
      ctx: { From: "chat:+1555" },
      mainKey: "main",
      expected: "agent:main:main",
    },
    {
      name: "uses custom main key when provided",
      scope: "per-sender" as const,
      ctx: { From: "+1555" },
      mainKey: "primary",
      expected: "agent:main:primary",
    },
    {
      name: "keeps global scope untouched",
      scope: "global" as const,
      ctx: { From: "+1555" },
      mainKey: undefined,
      expected: "global",
    },
    {
      name: "leaves groups untouched even with main key",
      scope: "per-sender" as const,
      ctx: { From: "room-123", ChatType: "group", Provider: "demo-chat" },
      mainKey: "main",
      expected: "agent:main:demo-chat:group:room-123",
    },
  ] as const;

  for (const testCase of resolveSessionKeyCases) {
    it(testCase.name, () => {
      expect(resolveSessionKey(testCase.scope, testCase.ctx, testCase.mainKey)).toBe(
        testCase.expected,
      );
    });
  }

  it("updateLastRoute persists channel and target", async () => {
    const mainSessionKey = "agent:main:main";
    await createSessionStoreFixture({
      prefix: "updateLastRoute",
      entries: {
        [mainSessionKey]: buildMainSessionEntry({
          systemSent: true,
          thinkingLevel: "low",
          responseUsage: "on",
          queueDebounceMs: 1234,
          reasoningLevel: "on",
          elevatedLevel: "on",
          authProfileOverride: "auth-1",
          compactionCount: 2,
        }),
      },
    });

    await updateLastRoute({
      agentId: "main",
      sessionKey: mainSessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "  12345  ",
      },
    });

    const store = readSessionEntries();
    expect(store[mainSessionKey]?.sessionId).toBe("sess-1");
    // updateLastRoute must preserve existing updatedAt (activity timestamp)
    expect(store[mainSessionKey]?.updatedAt).toBe(123);
    expect(store[mainSessionKey]?.lastChannel).toBe("telegram");
    expect(store[mainSessionKey]?.lastTo).toBe("12345");
    expect(store[mainSessionKey]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "12345",
    });
    expect(store[mainSessionKey]?.responseUsage).toBe("on");
    expect(store[mainSessionKey]?.queueDebounceMs).toBe(1234);
    expect(store[mainSessionKey]?.reasoningLevel).toBe("on");
    expect(store[mainSessionKey]?.elevatedLevel).toBe("on");
    expect(store[mainSessionKey]?.authProfileOverride).toBe("auth-1");
    expect(store[mainSessionKey]?.compactionCount).toBe(2);
  });

  it("updateLastRoute prefers explicit deliveryContext", async () => {
    const mainSessionKey = "agent:main:main";
    await createSessionStoreFixture({
      prefix: "updateLastRoute",
      entries: {},
    });

    await updateLastRoute({
      agentId: "main",
      sessionKey: mainSessionKey,
      channel: "demo-chat",
      to: "111",
      accountId: "legacy",
      deliveryContext: {
        channel: "telegram",
        to: "222",
        accountId: "primary",
      },
    });

    const store = readSessionEntries();
    expect(store[mainSessionKey]?.lastChannel).toBe("telegram");
    expect(store[mainSessionKey]?.lastTo).toBe("222");
    expect(store[mainSessionKey]?.lastAccountId).toBe("primary");
    expect(store[mainSessionKey]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "222",
      accountId: "primary",
    });
  });

  it("updateLastRoute clears threadId when explicit route omits threadId", async () => {
    const mainSessionKey = "agent:main:main";
    await createSessionStoreFixture({
      prefix: "updateLastRoute",
      entries: {
        [mainSessionKey]: buildMainSessionEntry({
          deliveryContext: {
            channel: "telegram",
            to: "222",
            threadId: "42",
          },
          lastChannel: "telegram",
          lastTo: "222",
          lastThreadId: "42",
        }),
      },
    });

    await updateLastRoute({
      agentId: "main",
      sessionKey: mainSessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "222",
      },
    });

    const store = readSessionEntries();
    expect(store[mainSessionKey]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "222",
    });
    expect(store[mainSessionKey]?.lastThreadId).toBeUndefined();
  });

  it("updateLastRoute records origin + group metadata when ctx is provided", async () => {
    const sessionKey = "agent:main:demo-chat:group:room-123";
    await createSessionStoreFixture({
      prefix: "updateLastRoute",
      entries: {},
    });

    await updateLastRoute({
      agentId: "main",
      sessionKey,
      deliveryContext: {
        channel: "demo-chat",
        to: "room-123",
      },
      ctx: {
        Provider: "demo-chat",
        ChatType: "group",
        GroupSubject: "Family",
        From: "room-123",
      },
    });

    const store = readSessionEntries();
    expect(store[sessionKey]?.subject).toBe("Family");
    expect(store[sessionKey]?.channel).toBe("demo-chat");
    expect(store[sessionKey]?.groupId).toBe("room-123");
    expect(store[sessionKey]?.origin?.label).toBe("Family");
    expect(store[sessionKey]?.origin?.provider).toBe("demo-chat");
    expect(store[sessionKey]?.origin?.chatType).toBe("group");
  });

  it("updateLastRoute skips missing sessions when creation is disabled", async () => {
    const sessionKey = "agent:main:demo-chat:group:room-123";
    await createSessionStoreFixture({
      prefix: "updateLastRoute-no-create",
      entries: {},
    });

    const result = await updateLastRoute({
      agentId: "main",
      sessionKey,
      deliveryContext: {
        channel: "demo-chat",
        to: "room-123",
      },
      createIfMissing: false,
    });

    const store = readSessionEntries();
    expect(result).toBeNull();
    expect(store[sessionKey]).toBeUndefined();
  });

  it("updateLastRoute updates existing sessions when creation is disabled", async () => {
    const sessionKey = "agent:main:demo-chat:group:room-123";
    await createSessionStoreFixture({
      prefix: "updateLastRoute-existing-no-create",
      entries: {
        [sessionKey]: buildMainSessionEntry(),
      },
    });

    await updateLastRoute({
      agentId: "main",
      sessionKey,
      deliveryContext: {
        channel: "demo-chat",
        to: "room-123",
      },
      createIfMissing: false,
    });

    const store = readSessionEntries();
    expect(store[sessionKey]?.lastChannel).toBe("demo-chat");
    expect(store[sessionKey]?.lastTo).toBe("room-123");
  });

  it("updateLastRoute does not bump updatedAt on existing sessions (#49515)", async () => {
    const mainSessionKey = "agent:main:main";
    const frozenUpdatedAt = 1000;
    await createSessionStoreFixture({
      prefix: "updateLastRoute-preserve-activity",
      entries: {
        [mainSessionKey]: buildMainSessionEntry({
          updatedAt: frozenUpdatedAt,
        }),
      },
    });

    await updateLastRoute({
      agentId: "main",
      sessionKey: mainSessionKey,
      deliveryContext: {
        channel: "telegram",
        to: "99999",
      },
    });

    const store = readSessionEntries();
    // Route updates must not refresh activity timestamps; idle/daily reset
    // evaluation relies on updatedAt from actual session turns.
    expect(store[mainSessionKey]?.updatedAt).toBe(frozenUpdatedAt);
    // Routing fields should still be updated
    expect(store[mainSessionKey]?.lastChannel).toBe("telegram");
    expect(store[mainSessionKey]?.lastTo).toBe("99999");
  });

  it("patchSessionEntry preserves existing fields when patching", async () => {
    const sessionKey = "agent:main:main";
    await createSessionStoreFixture({
      prefix: "patchSessionEntry",
      entries: {
        [sessionKey]: {
          sessionId: "sess-1",
          updatedAt: 100,
          reasoningLevel: "on",
        },
      },
    });

    await patchSessionEntry({
      agentId: "main",
      sessionKey,
      update: async () => ({ updatedAt: 200 }),
    });

    const store = readSessionEntries();
    expect(store[sessionKey]?.updatedAt).toBeGreaterThanOrEqual(200);
    expect(store[sessionKey]?.reasoningLevel).toBe("on");
  });

  it("patchSessionEntry returns null when session key does not exist", async () => {
    await createSessionStoreFixture({
      prefix: "patchSessionEntry-missing",
      entries: {},
    });
    const update = async () => ({ thinkingLevel: "high" as const });
    const result = await patchSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:missing",
      update,
    });
    expect(result).toBeNull();
  });

  it("patchSessionEntry keeps existing entry when patch callback returns null", async () => {
    const sessionKey = "agent:main:main";
    await createSessionStoreFixture({
      prefix: "patchSessionEntry-noop",
      entries: {
        [sessionKey]: {
          sessionId: "sess-1",
          updatedAt: 123,
          thinkingLevel: "low",
        },
      },
    });

    const result = await patchSessionEntry({
      agentId: "main",
      sessionKey,
      update: async () => null,
    });
    expect(result).toEqual(expect.objectContaining({ sessionId: "sess-1", thinkingLevel: "low" }));

    const store = readSessionEntries();
    expect(store[sessionKey]?.thinkingLevel).toBe("low");
  });

  it("session row upserts preserve concurrent additions", async () => {
    await createSessionStoreFixture({
      prefix: "session-row-upserts",
      entries: {},
    });

    await Promise.all([
      Promise.resolve().then(() => {
        upsertSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:one",
          entry: { sessionId: "sess-1", updatedAt: Date.now() },
        });
      }),
      Promise.resolve().then(() => {
        upsertSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:two",
          entry: { sessionId: "sess-2", updatedAt: Date.now() },
        });
      }),
    ]);

    const store = readSessionEntries();
    expect(store["agent:main:one"]?.sessionId).toBe("sess-1");
    expect(store["agent:main:two"]?.sessionId).toBe("sess-2");
  });

  it("creates SQLite session stores without writing sessions.json", async () => {
    const { sessionsDir } = await createSessionStoreFixture({
      prefix: "session-row-upsert",
      entries: {},
    });

    upsertSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      entry: { sessionId: "sess-1", updatedAt: Date.now() },
    });

    const store = readSessionEntries();
    expect(store["agent:main:main"]?.sessionId).toBe("sess-1");
    await expect(fs.stat(path.join(sessionsDir, "sessions.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("normalizes last route fields on write", async () => {
    await createSessionStoreFixture({
      prefix: "session-row-upsert",
      entries: {},
    });

    upsertSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      entry: {
        sessionId: "sess-normalized",
        updatedAt: Date.now(),
        lastChannel: " Demo Chat ",
        lastTo: " +1555 ",
        lastAccountId: " acct-1 ",
      },
    });

    const store = readSessionEntries();
    expect(store["agent:main:main"]?.lastChannel).toBe("demo chat");
    expect(store["agent:main:main"]?.lastTo).toBe("+1555");
    expect(store["agent:main:main"]?.lastAccountId).toBe("acct-1");
    expect(store["agent:main:main"]?.deliveryContext).toEqual({
      channel: "demo chat",
      to: "+1555",
      accountId: "acct-1",
    });
  });

  it("session row delete keeps concurrent writes", async () => {
    await createSessionStoreFixture({
      prefix: "session-row-delete",
      entries: {
        "agent:main:old": { sessionId: "sess-old", updatedAt: Date.now() },
        "agent:main:keep": { sessionId: "sess-keep", updatedAt: Date.now() },
      },
    });

    await Promise.all([
      Promise.resolve().then(() => {
        deleteSessionEntry({ agentId: "main", sessionKey: "agent:main:old" });
      }),
      Promise.resolve().then(() => {
        upsertSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:new",
          entry: { sessionId: "sess-new", updatedAt: Date.now() },
        });
      }),
    ]);

    const store = readSessionEntries();
    expect(store["agent:main:old"]).toBeUndefined();
    expect(store["agent:main:keep"]?.sessionId).toBe("sess-keep");
    expect(store["agent:main:new"]?.sessionId).toBe("sess-new");
  });

  it("session row reads preserve normalized channel route keys", async () => {
    const mainSessionKey = "agent:main:main";
    await createSessionStoreFixture({
      prefix: "session-row-read",
      entries: {
        [mainSessionKey]: {
          sessionId: "sess-legacy",
          updatedAt: 123,
          channel: "slack",
          lastChannel: "telegram",
          lastTo: "user:U123",
        },
      },
    });

    const store = readSessionEntries() as unknown as Record<string, Record<string, unknown>>;
    const entry = store[mainSessionKey] ?? {};
    expect(entry.channel).toBe("slack");
    expect(entry.provider).toBeUndefined();
    expect(entry.lastChannel).toBe("telegram");
    expect(entry.lastProvider).toBeUndefined();
  });

  it("uses agent id when resolving transcript locator fallback paths", () => {
    withStateDir("/custom/state", () => {
      const transcriptLocator = resolveSessionTranscriptLocator("sess-2", {
        agentId: "codex",
      });
      expect(transcriptLocator).toBe(
        createSqliteSessionTranscriptLocator({ agentId: "codex", sessionId: "sess-2" }),
      );
    });
  });

  it("derives transcript locators from the requested agent", () => {
    withStateDir(path.resolve("/different/state"), () => {
      const transcriptLocator = resolveSessionTranscriptLocator("sess-1", { agentId: "bot1" });
      expect(transcriptLocator).toBe(
        createSqliteSessionTranscriptLocator({ agentId: "bot1", sessionId: "sess-1" }),
      );
    });
  });

  it("parses SQLite transcript locators with topic ids", () => {
    const locator = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "sess-topic",
      topicId: "thread/42",
    });

    expect(parseSqliteSessionTranscriptLocator(locator)).toEqual({
      agentId: "main",
      sessionId: "sess-topic",
      topicId: "thread/42",
    });
  });

  it("derives stable matching SQLite transcript locators", () => {
    withStateDir(path.resolve("/different/state"), () => {
      const locator = createSqliteSessionTranscriptLocator({
        agentId: "bot1",
        sessionId: "sess-1",
      });
      const transcriptLocator = resolveSessionTranscriptLocator("sess-1", { agentId: "bot1" });
      expect(transcriptLocator).toBe(locator);
    });
  });

  it("does not consult a previous SQLite transcript locator for a different agent", () => {
    withStateDir(path.resolve("/different/state"), () => {
      const transcriptLocator = resolveSessionTranscriptLocator("sess-1", { agentId: "bot1" });
      expect(transcriptLocator).toBe(
        createSqliteSessionTranscriptLocator({ agentId: "bot1", sessionId: "sess-1" }),
      );
    });
  });

  it("patchSessionEntry merges concurrent patches", async () => {
    const mainSessionKey = "agent:main:main";
    await createSessionStoreFixture({
      prefix: "patchSessionEntry",
      entries: {
        [mainSessionKey]: {
          sessionId: "sess-1",
          updatedAt: 123,
          thinkingLevel: "low",
        },
      },
    });

    const createDeferred = <T>() => {
      let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
      let reject: ((reason?: unknown) => void) | undefined;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      if (!resolve || !reject) {
        throw new Error("Expected deferred callbacks to be initialized");
      }
      return { promise, resolve, reject };
    };
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    const p1 = patchSessionEntry({
      agentId: "main",
      sessionKey: mainSessionKey,
      update: async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return { modelOverride: "anthropic/claude-opus-4-6" };
      },
    });
    const p2 = patchSessionEntry({
      agentId: "main",
      sessionKey: mainSessionKey,
      update: async () => {
        await firstStarted.promise;
        return { thinkingLevel: "high" };
      },
    });

    await firstStarted.promise;
    releaseFirst.resolve();
    await Promise.all([p1, p2]);

    const store = readSessionEntries();
    expect(store[mainSessionKey]?.modelOverride).toBe("anthropic/claude-opus-4-6");
    expect(store[mainSessionKey]?.thinkingLevel).toBe("high");
  });

  it("patchSessionEntry reads the latest SQLite row before patching", async () => {
    const mainSessionKey = "agent:main:main";
    await createSessionStoreFixture({
      prefix: "patchSessionEntry-cache-bypass",
      entries: {
        [mainSessionKey]: {
          sessionId: "sess-1",
          updatedAt: 123,
          thinkingLevel: "low",
        },
      },
    });

    // Prime the row read path with the original entry.
    expect(readSessionEntries()[mainSessionKey]?.thinkingLevel).toBe("low");
    upsertSessionEntry({
      agentId: "main",
      sessionKey: mainSessionKey,
      entry: {
        sessionId: "sess-1",
        updatedAt: 124,
        thinkingLevel: "low",
        providerOverride: "anthropic",
      },
    });

    await patchSessionEntry({
      agentId: "main",
      sessionKey: mainSessionKey,
      update: async () => ({ thinkingLevel: "high" }),
    });

    const store = readSessionEntries();
    expect(store[mainSessionKey]?.providerOverride).toBe("anthropic");
    expect(store[mainSessionKey]?.thinkingLevel).toBe("high");
  });

  it("patchSessionEntry reads SQLite rows before mutation", async () => {
    const mainSessionKey = "agent:main:main";
    await createSessionStoreFixture({
      prefix: "patchSessionEntry-mutable-cache",
      entries: {
        [mainSessionKey]: {
          sessionId: "sess-1",
          updatedAt: 123,
          thinkingLevel: "low",
        },
      },
    });

    expect(readSessionEntries()[mainSessionKey]?.thinkingLevel).toBe("low");

    await patchSessionEntry({
      agentId: "main",
      sessionKey: mainSessionKey,
      update: (existing) => ({
        thinkingLevel: "high",
        updatedAt: existing.updatedAt,
      }),
    });

    const store = readSessionEntries();
    expect(store[mainSessionKey]?.thinkingLevel).toBe("high");
  });

  it("patchSessionEntry does not persist callback changes when the callback throws", async () => {
    const mainSessionKey = "agent:main:main";
    await createSessionStoreFixture({
      prefix: "patchSessionEntry-mutable-cache-throw",
      entries: {
        [mainSessionKey]: {
          sessionId: "sess-1",
          updatedAt: 123,
          thinkingLevel: "low",
        },
      },
    });

    expect(readSessionEntries()[mainSessionKey]?.thinkingLevel).toBe("low");

    await expect(
      patchSessionEntry({
        agentId: "main",
        sessionKey: mainSessionKey,
        update: (existing) => {
          existing.thinkingLevel = "mutated-before-throw";
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    const store = readSessionEntries();
    expect(store[mainSessionKey]?.thinkingLevel).toBe("low");
  });
});
