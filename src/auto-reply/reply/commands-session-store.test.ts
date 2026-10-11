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

describe("commands session store persistence", () => {
  it("does not recreate a missing row without explicit create ownership", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:missing-existing";
      const entry: SessionEntry = {
        sessionId: "missing-existing-session",
        updatedAt: 1,
        responseUsage: "tokens",
      };
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };

      await expect(
        persistCommandSession({
          sessionEntry: entry,
          sessionStore,
          sessionKey,
          storePath,
          touchedFields: ["responseUsage"],
        }),
      ).resolves.toBe(false);

      expect(loadSessionEntry({ storePath, sessionKey })).toBeUndefined();
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
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
      const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValue(400);

      try {
        await expect(
          persistCommandSession({
            sessionEntry: entry,
            sessionStore,
            sessionKey,
            storePath,
          }),
        ).resolves.toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      const persisted = loadSessionEntry({ storePath, sessionKey });
      const persistedOther = loadSessionEntry({ storePath, sessionKey: otherKey });
      expect(entry.updatedAt).not.toBe(1);
      expect(sessionStore[sessionKey]).toMatchObject({
        sessionId: "command-session",
        label: "After rename",
        model: "gpt-5.5",
      });
      expect(sessionStore[sessionKey]?.updatedAt).toBeGreaterThanOrEqual(concurrentUpdatedAt);
      expect(sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
      expect(persisted).toMatchObject({
        sessionId: "command-session",
        label: "After rename",
        model: "gpt-5.5",
      });
      expect(persisted?.updatedAt).toBeGreaterThanOrEqual(concurrentUpdatedAt);
      expect(persisted?.pinnedAt).toBeUndefined();
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
      await replaceSessionEntry({ storePath, sessionKey }, rotatedEntry);
      const sessionStore = { [sessionKey]: sessionEntry };

      await expect(
        persistCommandSession({
          initialSessionEntry: initialEntry,
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
        }),
      ).resolves.toBe(false);

      expect(sessionStore[sessionKey]).toEqual(rotatedEntry);
      expect(loadSessionEntry({ storePath, sessionKey })).toEqual(rotatedEntry);
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
      await replaceSessionEntry({ storePath, sessionKey }, concurrentEntry);
      const sessionStore = { [sessionKey]: sessionEntry };

      await expect(
        persistCommandSession({
          initialSessionEntry: initialEntry,
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
          touchedFields: ["sendPolicy"],
        }),
      ).resolves.toBe(false);

      expect(sessionStore[sessionKey]).toMatchObject({
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
      await replaceSessionEntry({ storePath, sessionKey }, concurrentEntry);
      const sessionStore = { [sessionKey]: sessionEntry };

      await expect(
        persistCommandSession({
          initialSessionEntry: initialEntry,
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
          touchedFields: ["groupActivation", "groupActivationNeedsSystemIntro"],
        }),
      ).resolves.toBe(false);

      expect(sessionStore[sessionKey]).toEqual(concurrentEntry);
      expect(loadSessionEntry({ storePath, sessionKey })).toEqual(concurrentEntry);
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
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };

      await expect(
        persistCommandSession({
          initialSessionEntry: { ...persistedEntry },
          sessionEntry: entry,
          sessionStore,
          sessionKey,
          storePath,
          touchedFields: ["sendPolicy"],
        }),
      ).resolves.toBe(true);

      const persisted = loadSessionEntry({ storePath, sessionKey });
      expect(persisted).toMatchObject({
        sessionId: "tombstone-session",
        sendPolicy: "allow",
        updatedAt: 0,
      });
      expect(sessionStore[sessionKey]?.updatedAt).toBe(0);
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
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };

      await expect(
        persistAbortTargetEntry({
          entry,
          key: sessionKey,
          sessionStore,
          storePath,
          abortCutoff: { messageSid: "77", timestamp: 456 },
        }),
      ).resolves.toBe(true);

      const persisted = loadSessionEntry({ storePath, sessionKey });
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
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };

      await expect(
        persistAbortTargetEntry({
          entry,
          key: sessionKey,
          sessionStore,
          storePath,
          abortCutoff: { messageSid: "42", timestamp: 123 },
        }),
      ).resolves.toBe(true);

      const persisted = loadSessionEntry({ storePath, sessionKey });
      expect(sessionStore[sessionKey]).toBe(entry);
      expect(entry.abortedLastRun).toBe(true);
      expect(entry.abortCutoffMessageSid).toBe("42");
      expect(entry.abortCutoffTimestamp).toBe(123);
      expect(persisted).toMatchObject({
        sessionId: "abort-session",
        model: "gpt-5.5",
        abortedLastRun: true,
        abortCutoffMessageSid: "42",
        abortCutoffTimestamp: 123,
      });
    });
  });

  it.each([false])("only patches a matching persisted abort owner=%s", async (matchesOwner) => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:abort-target";
      const otherKey = "agent:main:other";
      const entry: SessionEntry = {
        sessionId: matchesOwner ? "persisted-session" : "memory-session",
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

      await expect(
        persistAbortTargetEntry({
          entry,
          key: sessionKey,
          sessionStore: { [sessionKey]: entry },
          storePath,
        }),
      ).resolves.toBe(matchesOwner);

      const persisted = loadSessionEntry({ storePath, sessionKey });
      const persistedOther = loadSessionEntry({ storePath, sessionKey: otherKey });
      expect(entry.abortedLastRun).toBe(true);
      expect(persisted).toMatchObject({
        sessionId: "persisted-session",
        model: "sonnet-4.6",
      });
      expect(persisted?.abortedLastRun ?? false).toBe(matchesOwner);
      expect(persistedOther).toStrictEqual(otherEntry);
    });
  });
});
