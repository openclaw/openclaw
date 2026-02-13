import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
} from "../sessions/store.js";
import {
  ThreadBindingRegistry,
  bindSessionToThread,
  buildThreadKey,
  findSessionsByThread,
  getSessionThreadBinding,
  getThreadRegistry,
  parseThreadKey,
  resetThreadRegistry,
  unbindSessionFromThread,
  type ThreadBinding,
} from "../thread-registry.js";

// ---------------------------------------------------------------------------
// buildThreadKey / parseThreadKey
// ---------------------------------------------------------------------------

describe("buildThreadKey / parseThreadKey", () => {
  it("round-trips with accountId", () => {
    const key = buildThreadKey({ channel: "slack", accountId: "T123", threadId: "1234567890.123" });
    expect(key).toBe("slack:T123:1234567890.123");

    const parsed = parseThreadKey(key);
    expect(parsed).toEqual({
      channel: "slack",
      accountId: "T123",
      threadId: "1234567890.123",
    });
  });

  it("round-trips without accountId", () => {
    const key = buildThreadKey({ channel: "discord", threadId: "987654321" });
    expect(key).toBe("discord::987654321");

    const parsed = parseThreadKey(key);
    expect(parsed).toEqual({
      channel: "discord",
      accountId: undefined,
      threadId: "987654321",
    });
  });

  it("handles threadId containing colons", () => {
    const key = buildThreadKey({ channel: "telegram", accountId: "bot1", threadId: "a:b:c" });
    expect(key).toBe("telegram:bot1:a:b:c");

    const parsed = parseThreadKey(key);
    expect(parsed).toEqual({
      channel: "telegram",
      accountId: "bot1",
      threadId: "a:b:c",
    });
  });

  it("returns null for malformed keys", () => {
    expect(parseThreadKey("")).toBeNull();
    expect(parseThreadKey("slack")).toBeNull();
    expect(parseThreadKey("slack:only")).toBeNull();
  });

  it("returns null when channel or threadId segment is empty", () => {
    // empty channel
    expect(parseThreadKey(":acct:thread")).toBeNull();
    // empty threadId (trailing colon)
    expect(parseThreadKey("slack:acct:")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ThreadBindingRegistry
// ---------------------------------------------------------------------------

describe("ThreadBindingRegistry", () => {
  let registry: ThreadBindingRegistry;

  afterEach(() => {
    resetThreadRegistry();
  });

  // Fresh instance for each test
  const fresh = () => {
    registry = new ThreadBindingRegistry();
    return registry;
  };

  // -- bind / unbind / lookup lifecycle ------------------------------------

  describe("bind / unbind / lookup lifecycle", () => {
    it("binds a session to a thread and looks it up", () => {
      const r = fresh();
      r.bind("session-1", "slack:T1:ts1");

      expect(r.lookup("slack:T1:ts1")).toEqual(["session-1"]);
      expect(r.getBinding("session-1")).toBe("slack:T1:ts1");
      expect(r.isBound("session-1")).toBe(true);
    });

    it("unbinds a session", () => {
      const r = fresh();
      r.bind("session-1", "slack:T1:ts1");

      const result = r.unbind("session-1");
      expect(result).toBe(true);
      expect(r.lookup("slack:T1:ts1")).toEqual([]);
      expect(r.getBinding("session-1")).toBeUndefined();
      expect(r.isBound("session-1")).toBe(false);
    });

    it("returns false when unbinding an unbound session", () => {
      const r = fresh();
      expect(r.unbind("nonexistent")).toBe(false);
    });

    it("lookup returns empty array for unknown thread", () => {
      const r = fresh();
      expect(r.lookup("unknown:thread:key")).toEqual([]);
    });
  });

  // -- multi-session bindings (multiple agents → one thread) ---------------

  describe("multi-session bindings", () => {
    it("allows multiple sessions bound to one thread", () => {
      const r = fresh();
      r.bind("session-a", "slack:T1:ts1");
      r.bind("session-b", "slack:T1:ts1");
      r.bind("session-c", "slack:T1:ts1");

      const bound = r.lookup("slack:T1:ts1");
      expect(bound).toHaveLength(3);
      expect(new Set(bound)).toEqual(new Set(["session-a", "session-b", "session-c"]));
    });

    it("unbinding one session does not affect others", () => {
      const r = fresh();
      r.bind("session-a", "slack:T1:ts1");
      r.bind("session-b", "slack:T1:ts1");

      r.unbind("session-a");

      expect(r.lookup("slack:T1:ts1")).toEqual(["session-b"]);
      expect(r.isBound("session-a")).toBe(false);
      expect(r.isBound("session-b")).toBe(true);
    });

    it("cleans up thread entry when last session is unbound", () => {
      const r = fresh();
      r.bind("session-a", "slack:T1:ts1");
      r.unbind("session-a");

      // Internal map should not retain empty Sets
      expect(r.lookup("slack:T1:ts1")).toEqual([]);
    });
  });

  // -- re-bind to different thread -----------------------------------------

  describe("re-bind", () => {
    it("unbinds from old thread when binding to a new one", () => {
      const r = fresh();
      r.bind("session-1", "slack:T1:ts1");
      r.bind("session-1", "discord::thread-2");

      expect(r.getBinding("session-1")).toBe("discord::thread-2");
      expect(r.lookup("slack:T1:ts1")).toEqual([]);
      expect(r.lookup("discord::thread-2")).toEqual(["session-1"]);
    });

    it("binding to the same thread again is a no-op", () => {
      const r = fresh();
      r.bind("session-1", "slack:T1:ts1");
      r.bind("session-1", "slack:T1:ts1");

      expect(r.lookup("slack:T1:ts1")).toEqual(["session-1"]);
    });
  });

  // -- rebuildFromSessions --------------------------------------------------

  describe("rebuildFromSessions", () => {
    const makeBinding = (overrides: Partial<ThreadBinding> = {}): ThreadBinding => ({
      channel: "slack",
      threadId: "ts-default",
      mode: "thread-only",
      boundAt: Date.now(),
      ...overrides,
    });

    it("indexes sessions that have threadBinding", () => {
      const r = fresh();
      const sessions: Record<string, { threadBinding?: ThreadBinding }> = {
        "agent:main:sub:aaa": {
          threadBinding: makeBinding({ channel: "slack", accountId: "T1", threadId: "ts1" }),
        },
        "agent:main:sub:bbb": {
          threadBinding: makeBinding({ channel: "discord", threadId: "ch1" }),
        },
        "agent:main:main": {}, // no binding
      };

      r.rebuildFromSessions(sessions);

      expect(r.lookup("slack:T1:ts1")).toEqual(["agent:main:sub:aaa"]);
      expect(r.lookup("discord::ch1")).toEqual(["agent:main:sub:bbb"]);
      expect(r.isBound("agent:main:main")).toBe(false);
    });

    it("clears previous state before rebuilding", () => {
      const r = fresh();
      r.bind("old-session", "old:thread:key");

      r.rebuildFromSessions({
        "new-session": {
          threadBinding: makeBinding({ channel: "telegram", threadId: "42" }),
        },
      });

      expect(r.isBound("old-session")).toBe(false);
      expect(r.lookup("telegram::42")).toEqual(["new-session"]);
    });

    it("handles multiple sessions bound to the same thread", () => {
      const r = fresh();
      const binding = makeBinding({ channel: "slack", accountId: "T1", threadId: "shared" });
      r.rebuildFromSessions({
        "session-x": { threadBinding: binding },
        "session-y": { threadBinding: { ...binding } },
      });

      const bound = r.lookup("slack:T1:shared");
      expect(bound).toHaveLength(2);
      expect(new Set(bound)).toEqual(new Set(["session-x", "session-y"]));
    });

    it("handles empty session store", () => {
      const r = fresh();
      r.bind("something", "thread:key:1");
      r.rebuildFromSessions({});

      expect(r.isBound("something")).toBe(false);
    });
  });

  // -- singleton ------------------------------------------------------------

  describe("singleton", () => {
    it("getThreadRegistry returns the same instance", () => {
      const a = getThreadRegistry();
      const b = getThreadRegistry();
      expect(a).toBe(b);
    });

    it("resetThreadRegistry clears the singleton", () => {
      const before = getThreadRegistry();
      resetThreadRegistry();
      const after = getThreadRegistry();
      expect(before).not.toBe(after);
    });
  });
});

// ---------------------------------------------------------------------------
// Binding lifecycle helpers (Phase 2)
// ---------------------------------------------------------------------------

describe("binding lifecycle helpers", () => {
  let tmpDir: string;
  let storePath: string;

  const makeBinding = (overrides: Partial<ThreadBinding> = {}): ThreadBinding => ({
    channel: "slack",
    threadId: "ts-default",
    mode: "thread-only",
    boundAt: Date.now(),
    ...overrides,
  });

  beforeEach(async () => {
    resetThreadRegistry();
    clearSessionStoreCacheForTest();
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thread-reg-lifecycle-"));
    storePath = path.join(tmpDir, "sessions.json");
    // Seed with an empty store
    await saveSessionStore(storePath, {});
  });

  afterEach(async () => {
    resetThreadRegistry();
    clearSessionStoreCacheForTest();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("bindSessionToThread", () => {
    it("creates a new entry with threadBinding if session did not exist", async () => {
      const binding = makeBinding({ channel: "slack", accountId: "T1", threadId: "ts1" });
      await bindSessionToThread({ storePath, sessionKey: "agent:main:sub:aaa", binding });

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store["agent:main:sub:aaa"]).toBeDefined();
      expect(store["agent:main:sub:aaa"].threadBinding).toEqual(binding);

      // Registry should be updated
      const registry = getThreadRegistry();
      expect(registry.lookup("slack:T1:ts1")).toContain("agent:main:sub:aaa");
    });

    it("adds threadBinding to an existing session entry", async () => {
      // Seed a session
      await saveSessionStore(storePath, {
        "agent:main:sub:bbb": {
          sessionId: "bbb",
          updatedAt: Date.now(),
          label: "existing",
        } as any,
      });

      const binding = makeBinding({ channel: "discord", threadId: "ch1" });
      await bindSessionToThread({ storePath, sessionKey: "agent:main:sub:bbb", binding });

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store["agent:main:sub:bbb"].threadBinding).toEqual(binding);
      expect(store["agent:main:sub:bbb"].label).toBe("existing"); // preserved
    });
  });

  describe("unbindSessionFromThread", () => {
    it("removes threadBinding from a bound session", async () => {
      const binding = makeBinding({ channel: "slack", accountId: "T2", threadId: "ts2" });
      await saveSessionStore(storePath, {
        "agent:main:sub:ccc": {
          sessionId: "ccc",
          updatedAt: Date.now(),
          threadBinding: binding,
        } as any,
      });
      // Force registry rebuild
      loadSessionStore(storePath, { skipCache: true });

      const result = await unbindSessionFromThread({ storePath, sessionKey: "agent:main:sub:ccc" });
      expect(result).toBe(true);

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store["agent:main:sub:ccc"].threadBinding).toBeUndefined();

      // Registry should also be updated
      expect(getThreadRegistry().isBound("agent:main:sub:ccc")).toBe(false);
    });

    it("returns false when session has no binding", async () => {
      await saveSessionStore(storePath, {
        "agent:main:sub:ddd": {
          sessionId: "ddd",
          updatedAt: Date.now(),
        } as any,
      });

      const result = await unbindSessionFromThread({ storePath, sessionKey: "agent:main:sub:ddd" });
      expect(result).toBe(false);
    });

    it("returns false when session does not exist", async () => {
      const result = await unbindSessionFromThread({ storePath, sessionKey: "nonexistent" });
      expect(result).toBe(false);
    });
  });

  describe("findSessionsByThread", () => {
    it("returns bound sessions from registry", async () => {
      const binding = makeBinding({ channel: "slack", accountId: "T1", threadId: "ts-shared" });
      await saveSessionStore(storePath, {
        "session-1": { sessionId: "s1", updatedAt: Date.now(), threadBinding: binding } as any,
        "session-2": {
          sessionId: "s2",
          updatedAt: Date.now(),
          threadBinding: { ...binding },
        } as any,
      });
      // Force registry rebuild
      loadSessionStore(storePath, { skipCache: true });

      const result = findSessionsByThread({
        channel: "slack",
        accountId: "T1",
        threadId: "ts-shared",
      });
      expect(result).toHaveLength(2);
      expect(new Set(result)).toEqual(new Set(["session-1", "session-2"]));
    });

    it("returns empty array when no sessions are bound", () => {
      const result = findSessionsByThread({ channel: "slack", threadId: "unknown" });
      expect(result).toEqual([]);
    });
  });

  describe("getSessionThreadBinding", () => {
    it("returns the binding from a session entry", async () => {
      const binding = makeBinding({ channel: "telegram", threadId: "42" });
      await saveSessionStore(storePath, {
        "agent:dev:sub:eee": {
          sessionId: "eee",
          updatedAt: Date.now(),
          threadBinding: binding,
        } as any,
      });

      const result = await getSessionThreadBinding({ storePath, sessionKey: "agent:dev:sub:eee" });
      expect(result).toEqual(binding);
    });

    it("returns undefined when session has no binding", async () => {
      await saveSessionStore(storePath, {
        "agent:dev:sub:fff": { sessionId: "fff", updatedAt: Date.now() } as any,
      });

      const result = await getSessionThreadBinding({ storePath, sessionKey: "agent:dev:sub:fff" });
      expect(result).toBeUndefined();
    });

    it("returns undefined when session does not exist", async () => {
      const result = await getSessionThreadBinding({ storePath, sessionKey: "nonexistent" });
      expect(result).toBeUndefined();
    });
  });
});
