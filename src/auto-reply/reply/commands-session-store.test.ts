import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { persistAbortTargetEntry, persistCommandSession } from "./commands-session-store.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-command-session-store-");

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "command-session", updatedAt: 1, ...overrides };
}

function commandFixture(entry: SessionEntry, sessionKey = "agent:main:command") {
  const storePath = path.join(sessionDirs.make(), "sessions.json");
  const sessionStore = { [sessionKey]: entry };
  return {
    storePath,
    sessionStore,
    read: () => loadSessionEntry({ storePath, sessionKey }),
    replace: (next: SessionEntry) => replaceSessionEntry({ storePath, sessionKey }, next),
    persist: (overrides: Partial<Parameters<typeof persistCommandSession>[0]> = {}) =>
      persistCommandSession({
        sessionEntry: entry,
        sessionStore,
        sessionKey,
        storePath,
        ...overrides,
      }),
    abort: (abortCutoff?: Parameters<typeof persistAbortTargetEntry>[0]["abortCutoff"]) =>
      persistAbortTargetEntry({ entry, key: sessionKey, sessionStore, storePath, abortCutoff }),
    expectCurrent: (expected: SessionEntry) => {
      expect(sessionStore[sessionKey]).toEqual(expected);
      expect(loadSessionEntry({ storePath, sessionKey })).toEqual(expected);
    },
  };
}

describe("commands session store persistence", () => {
  it("does not recreate a missing row without explicit create ownership", async () => {
    const fixture = commandFixture(makeEntry({ responseUsage: "tokens" }));
    await expect(fixture.persist({ touchedFields: ["responseUsage"] })).resolves.toBe(false);
    expect(fixture.read()).toBeUndefined();
  });

  it("persists command state without reverting concurrent session management", async () => {
    const sessionKey = "agent:main:command";
    const otherKey = "agent:main:other";
    const entry = makeEntry({
      model: "gpt-5.5",
      label: "Before rename",
      pinnedAt: 100,
    });
    const { storePath, sessionStore, persist, read } = commandFixture(entry);
    const otherEntry = makeEntry({
      sessionId: "other-session",
      updatedAt: 2,
      delivery: { kind: "none" },
    });
    const concurrentUpdatedAt = 300;
    const concurrentEntry = {
      ...entry,
      updatedAt: concurrentUpdatedAt,
      label: "After rename",
      pinnedAt: undefined,
    };
    await persist({
      allowCreateSessionEntry: true,
      sessionEntry: concurrentEntry,
      sessionStore: { [sessionKey]: concurrentEntry },
    });
    await replaceSessionEntry({ storePath, sessionKey: otherKey }, { ...otherEntry });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValue(400);

    try {
      await expect(persist()).resolves.toBe(true);
    } finally {
      nowSpy.mockRestore();
    }

    expect(entry.updatedAt).not.toBe(1);
    for (const current of [sessionStore[sessionKey], read()]) {
      expect(current).toMatchObject({
        sessionId: "command-session",
        label: "After rename",
        model: "gpt-5.5",
      });
      expect(current?.updatedAt).toBeGreaterThanOrEqual(concurrentUpdatedAt);
      expect(current?.pinnedAt).toBeUndefined();
    }
    expect(loadSessionEntry({ storePath, sessionKey: otherKey })).toStrictEqual(otherEntry);
  });

  it("rejects command persistence after the session rotates", async () => {
    const initialEntry = makeEntry({ queueMode: "collect" });
    const sessionEntry: SessionEntry = {
      ...initialEntry,
      queueMode: "followup",
    };
    const rotatedEntry = makeEntry({
      sessionId: "session-2",
      updatedAt: 3,
      delivery: { kind: "none" },
      queueMode: "interrupt",
    });
    const fixture = commandFixture(sessionEntry);
    await fixture.replace(rotatedEntry);
    await expect(fixture.persist({ initialSessionEntry: initialEntry })).resolves.toBe(false);
    fixture.expectCurrent(rotatedEntry);
  });

  it("rejects an explicit same-value command after a concurrent change", async () => {
    const sessionKey = "agent:main:command";
    const initialEntry = makeEntry({ sendPolicy: "deny" });
    const sessionEntry = { ...initialEntry };
    const concurrentEntry: SessionEntry = {
      ...initialEntry,
      updatedAt: 2,
      sendPolicy: "allow",
    };
    const fixture = commandFixture(sessionEntry);
    await fixture.replace(concurrentEntry);
    await expect(
      fixture.persist({
        initialSessionEntry: initialEntry,
        touchedFields: ["sendPolicy"],
      }),
    ).resolves.toBe(false);
    expect(fixture.sessionStore[sessionKey]).toMatchObject({
      sessionId: initialEntry.sessionId,
      sendPolicy: "allow",
    });
  });

  it("rejects a grouped command before committing any non-conflicting field", async () => {
    const initialEntry = makeEntry({
      groupActivation: "mention",
      groupActivationNeedsSystemIntro: true,
    });
    const sessionEntry: SessionEntry = {
      ...initialEntry,
      groupActivation: "always",
    };
    const concurrentEntry: SessionEntry = {
      ...initialEntry,
      updatedAt: 2,
      delivery: { kind: "none" },
      groupActivationNeedsSystemIntro: false,
    };
    const fixture = commandFixture(sessionEntry);
    await fixture.replace(concurrentEntry);
    await expect(
      fixture.persist({
        initialSessionEntry: initialEntry,
        touchedFields: ["groupActivation", "groupActivationNeedsSystemIntro"],
      }),
    ).resolves.toBe(false);
    fixture.expectCurrent(concurrentEntry);
  });

  it("keeps the legacy pending-reset marker through a command snapshot write", async () => {
    const sessionKey = "agent:main:tombstone-command";
    const persistedEntry = makeEntry({ sessionId: "tombstone-session", updatedAt: 0 });
    const entry: SessionEntry = { ...persistedEntry, sendPolicy: "allow" };
    const fixture = commandFixture(entry, sessionKey);
    await fixture.replace({ ...persistedEntry });
    await expect(
      fixture.persist({
        initialSessionEntry: { ...persistedEntry },
        touchedFields: ["sendPolicy"],
      }),
    ).resolves.toBe(true);
    expect(fixture.read()).toMatchObject({
      sessionId: "tombstone-session",
      sendPolicy: "allow",
      updatedAt: 0,
    });
    expect(fixture.sessionStore[sessionKey]?.updatedAt).toBe(0);
  });

  it("keeps the legacy pending-reset marker through abort persistence", async () => {
    const persistedEntry = makeEntry({ sessionId: "tombstone-abort-session", updatedAt: 0 });
    const entry = { ...persistedEntry };
    const fixture = commandFixture(entry);
    await fixture.replace({ ...persistedEntry });
    await expect(fixture.abort({ messageSid: "77", timestamp: 456 })).resolves.toBe(true);
    expect(fixture.read()).toMatchObject({
      sessionId: "tombstone-abort-session",
      abortedLastRun: true,
      abortCutoffMessageSid: "77",
      abortCutoffTimestamp: 456,
      updatedAt: 0,
    });
    expect(entry.updatedAt).toBe(0);
  });

  it("falls back to the supplied abort target when the persisted row is missing", async () => {
    const sessionKey = "agent:main:abort-target";
    const entry = makeEntry({
      sessionId: "abort-session",
      model: "gpt-5.5",
    });
    const fixture = commandFixture(entry, sessionKey);
    await expect(fixture.abort({ messageSid: "42", timestamp: 123 })).resolves.toBe(true);
    expect(fixture.sessionStore[sessionKey]).toBe(entry);
    expect(entry).toMatchObject({
      abortedLastRun: true,
      abortCutoffMessageSid: "42",
      abortCutoffTimestamp: 123,
    });
    expect(fixture.read()).toMatchObject({
      sessionId: "abort-session",
      model: "gpt-5.5",
      abortedLastRun: true,
      abortCutoffMessageSid: "42",
      abortCutoffTimestamp: 123,
    });
  });

  it("does not patch a different persisted abort owner", async () => {
    const sessionKey = "agent:main:abort-target";
    const otherKey = "agent:main:other";
    const entry = makeEntry({ sessionId: "memory-session" });
    const fixture = commandFixture(entry, sessionKey);
    const { storePath } = fixture;
    const persistedEntry = makeEntry({
      sessionId: "persisted-session",
      updatedAt: Date.now(),
      model: "sonnet-4.6",
    });
    const otherEntry = makeEntry({
      sessionId: "other-session",
      updatedAt: 3,
      delivery: { kind: "none" },
    });
    await fixture.replace(persistedEntry);
    await replaceSessionEntry({ storePath, sessionKey: otherKey }, otherEntry);

    await expect(fixture.abort()).resolves.toBe(false);

    const persisted = loadSessionEntry({ storePath, sessionKey });
    expect(entry.abortedLastRun).toBe(true);
    expect(persisted).toMatchObject({
      sessionId: "persisted-session",
      model: "sonnet-4.6",
    });
    expect(persisted?.abortedLastRun ?? false).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey: otherKey })).toStrictEqual(otherEntry);
  });
});
