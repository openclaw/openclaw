import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { persistAbortTargetEntry, persistCommandSession } from "./commands-session-store.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-command-session-store-");

function withTempStore<T>(run: (storePath: string) => Promise<T>): Promise<T> {
  return run(path.join(sessionDirs.make(), "sessions.json"));
}

function commandFixture(storePath: string, entry: SessionEntry, sessionKey = "agent:main:command") {
  const sessionStore = { [sessionKey]: entry };
  return {
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
  };
}

describe("commands session store persistence", () => {
  it("does not recreate a missing row without explicit create ownership", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:missing-existing";
      const entry: SessionEntry = {
        sessionId: "missing-existing-session",
        updatedAt: 1,
        responseUsage: "tokens",
      };
      const fixture = commandFixture(storePath, entry, sessionKey);
      await expect(fixture.persist({ touchedFields: ["responseUsage"] })).resolves.toBe(false);
      expect(fixture.read()).toBeUndefined();
    });
  });

  it("persists command state without reverting concurrent session management", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:command";
      const otherKey = "agent:main:other";
      const entry: SessionEntry = {
        sessionId: "command-session",
        updatedAt: 1,
        model: "gpt-5.5",
        label: "Before rename",
        pinnedAt: 100,
      };
      const otherEntry: SessionEntry = {
        sessionId: "other-session",
        updatedAt: 2,
        delivery: { kind: "none" },
      };
      const concurrentUpdatedAt = 300;
      const concurrentEntry = {
        ...entry,
        updatedAt: concurrentUpdatedAt,
        label: "After rename",
        pinnedAt: undefined,
      };
      await persistCommandSession({
        allowCreateSessionEntry: true,
        sessionEntry: concurrentEntry,
        sessionStore: { [sessionKey]: concurrentEntry },
        sessionKey,
        storePath,
      });
      await replaceSessionEntry({ storePath, sessionKey: otherKey }, { ...otherEntry });
      const { sessionStore, persist, read } = commandFixture(storePath, entry, sessionKey);
      const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValue(400);

      try {
        await expect(persist()).resolves.toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      const persisted = read();
      const persistedOther = loadSessionEntry({ storePath, sessionKey: otherKey });
      expect(entry.updatedAt).not.toBe(1);
      for (const current of [sessionStore[sessionKey], persisted]) {
        expect(current).toMatchObject({
          sessionId: "command-session",
          label: "After rename",
          model: "gpt-5.5",
        });
        expect(current?.updatedAt).toBeGreaterThanOrEqual(concurrentUpdatedAt);
        expect(current?.pinnedAt).toBeUndefined();
      }
      expect(persistedOther).toStrictEqual(otherEntry);
    });
  });

  it("rejects command persistence after the session rotates", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:command";
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 1,
        queueMode: "collect",
      };
      const sessionEntry: SessionEntry = {
        ...initialEntry,
        queueMode: "followup",
      };
      const rotatedEntry: SessionEntry = {
        sessionId: "session-2",
        updatedAt: 3,
        delivery: { kind: "none" },
        queueMode: "interrupt",
      };
      const fixture = commandFixture(storePath, sessionEntry, sessionKey);
      await fixture.replace(rotatedEntry);
      await expect(fixture.persist({ initialSessionEntry: initialEntry })).resolves.toBe(false);
      expect(fixture.sessionStore[sessionKey]).toEqual(rotatedEntry);
      expect(fixture.read()).toEqual(rotatedEntry);
    });
  });

  it("rejects an explicit same-value command after a concurrent change", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:command";
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 1,
        sendPolicy: "deny",
      };
      const sessionEntry = { ...initialEntry };
      const concurrentEntry: SessionEntry = {
        ...initialEntry,
        updatedAt: 2,
        sendPolicy: "allow",
      };
      const fixture = commandFixture(storePath, sessionEntry, sessionKey);
      await fixture.replace(concurrentEntry);
      await expect(
        fixture.persist({
          initialSessionEntry: initialEntry,
          touchedFields: ["sendPolicy"],
        }),
      ).resolves.toBe(false);
      expect(fixture.sessionStore[sessionKey]).toMatchObject({
        sessionId: "session-1",
        sendPolicy: "allow",
      });
    });
  });

  it("rejects a grouped command before committing any non-conflicting field", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:command";
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 1,
        groupActivation: "mention",
        groupActivationNeedsSystemIntro: true,
      };
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
      const fixture = commandFixture(storePath, sessionEntry, sessionKey);
      await fixture.replace(concurrentEntry);
      await expect(
        fixture.persist({
          initialSessionEntry: initialEntry,
          touchedFields: ["groupActivation", "groupActivationNeedsSystemIntro"],
        }),
      ).resolves.toBe(false);
      expect(fixture.sessionStore[sessionKey]).toEqual(concurrentEntry);
      expect(fixture.read()).toEqual(concurrentEntry);
    });
  });

  it("keeps the legacy pending-reset marker through a command snapshot write", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:tombstone-command";
      const persistedEntry: SessionEntry = {
        sessionId: "tombstone-session",
        updatedAt: 0,
      };
      await replaceSessionEntry({ storePath, sessionKey }, { ...persistedEntry });
      const entry: SessionEntry = { ...persistedEntry, sendPolicy: "allow" };
      const fixture = commandFixture(storePath, entry, sessionKey);
      await expect(
        fixture.persist({
          initialSessionEntry: { ...persistedEntry },
          touchedFields: ["sendPolicy"],
        }),
      ).resolves.toBe(true);
      const persisted = fixture.read();
      expect(persisted).toMatchObject({
        sessionId: "tombstone-session",
        sendPolicy: "allow",
        updatedAt: 0,
      });
      expect(fixture.sessionStore[sessionKey]?.updatedAt).toBe(0);
    });
  });

  it("keeps the legacy pending-reset marker through abort persistence", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:tombstone-abort";
      const persistedEntry: SessionEntry = {
        sessionId: "tombstone-abort-session",
        updatedAt: 0,
      };
      await replaceSessionEntry({ storePath, sessionKey }, { ...persistedEntry });
      const entry: SessionEntry = { ...persistedEntry };
      const fixture = commandFixture(storePath, entry, sessionKey);
      await expect(fixture.abort({ messageSid: "77", timestamp: 456 })).resolves.toBe(true);
      const persisted = fixture.read();
      expect(persisted).toMatchObject({
        sessionId: "tombstone-abort-session",
        abortedLastRun: true,
        abortCutoffMessageSid: "77",
        abortCutoffTimestamp: 456,
        updatedAt: 0,
      });
      expect(entry.updatedAt).toBe(0);
    });
  });

  it("falls back to the supplied abort target when the persisted row is missing", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:abort-target";
      const entry: SessionEntry = {
        sessionId: "abort-session",
        updatedAt: 1,
        model: "gpt-5.5",
      };
      const fixture = commandFixture(storePath, entry, sessionKey);
      await expect(fixture.abort({ messageSid: "42", timestamp: 123 })).resolves.toBe(true);
      const persisted = fixture.read();
      expect(fixture.sessionStore[sessionKey]).toBe(entry);
      expect(entry).toMatchObject({
        abortedLastRun: true,
        abortCutoffMessageSid: "42",
        abortCutoffTimestamp: 123,
      });
      expect(persisted).toMatchObject({
        sessionId: "abort-session",
        model: "gpt-5.5",
        abortedLastRun: true,
        abortCutoffMessageSid: "42",
        abortCutoffTimestamp: 123,
      });
    });
  });

  it("does not patch a different persisted abort owner", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:abort-target";
      const otherKey = "agent:main:other";
      const entry: SessionEntry = {
        sessionId: "memory-session",
        updatedAt: 1,
      };
      const persistedEntry: SessionEntry = {
        sessionId: "persisted-session",
        updatedAt: Date.now(),
        model: "sonnet-4.6",
      };
      const otherEntry: SessionEntry = {
        sessionId: "other-session",
        updatedAt: 3,
        delivery: { kind: "none" },
      };
      await replaceSessionEntry({ storePath, sessionKey }, persistedEntry);
      await replaceSessionEntry({ storePath, sessionKey: otherKey }, otherEntry);

      await expect(commandFixture(storePath, entry, sessionKey).abort()).resolves.toBe(false);

      const persisted = loadSessionEntry({ storePath, sessionKey });
      const persistedOther = loadSessionEntry({ storePath, sessionKey: otherKey });
      expect(entry.abortedLastRun).toBe(true);
      expect(persisted).toMatchObject({
        sessionId: "persisted-session",
        model: "sonnet-4.6",
      });
      expect(persisted?.abortedLastRun ?? false).toBe(false);
      expect(persistedOther).toStrictEqual(otherEntry);
    });
  });
});
