import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSessionStore, saveSessionStore } from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { persistAbortTargetEntry, persistSessionEntry } from "./commands-session-store.js";

async function withTempStore<T>(run: (storePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-session-store-"));
  try {
    return await run(path.join(dir, "sessions.json"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("commands session store persistence", () => {
  it("creates a missing row for the first command-only session mutation", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:first-command";
      const entry: SessionEntry = {
        sessionId: "first-command-session",
        updatedAt: 1,
        responseUsage: "tokens",
      };
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
      await saveSessionStore(storePath, {}, { skipMaintenance: true });

      await expect(
        persistSessionEntry({
          allowCreateSessionEntry: true,
          sessionEntry: entry,
          sessionStore,
          sessionKey,
          storePath,
          touchedFields: ["responseUsage"],
        }),
      ).resolves.toBe(true);

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted).toMatchObject({
        sessionId: "first-command-session",
        responseUsage: "tokens",
      });
      expect(sessionStore[sessionKey]).toMatchObject({
        sessionId: "first-command-session",
        responseUsage: "tokens",
      });
    });
  });

  it("does not recreate a missing row without explicit create ownership", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:missing-existing";
      const entry: SessionEntry = {
        sessionId: "missing-existing-session",
        updatedAt: 1,
        responseUsage: "tokens",
      };
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
      await saveSessionStore(storePath, {}, { skipMaintenance: true });

      await expect(
        persistSessionEntry({
          sessionEntry: entry,
          sessionStore,
          sessionKey,
          storePath,
          touchedFields: ["responseUsage"],
        }),
      ).resolves.toBe(false);

      expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toBeUndefined();
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
      };
      const concurrentUpdatedAt = 300;
      await saveSessionStore(
        storePath,
        {
          [sessionKey]: {
            ...entry,
            updatedAt: concurrentUpdatedAt,
            label: "After rename",
            pinnedAt: undefined,
          },
          [otherKey]: { ...otherEntry },
        },
        { skipMaintenance: true },
      );
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
      const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValue(400);

      try {
        await expect(
          persistSessionEntry({
            sessionEntry: entry,
            sessionStore,
            sessionKey,
            storePath,
          }),
        ).resolves.toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      const persisted = loadSessionStore(storePath, { skipCache: true });
      expect(entry.updatedAt).not.toBe(1);
      expect(sessionStore[sessionKey]).toMatchObject({
        sessionId: "command-session",
        label: "After rename",
        model: "gpt-5.5",
        updatedAt: concurrentUpdatedAt,
      });
      expect(sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
      expect(persisted[sessionKey]).toMatchObject({
        sessionId: "command-session",
        label: "After rename",
        model: "gpt-5.5",
        updatedAt: concurrentUpdatedAt,
      });
      expect(persisted[sessionKey]?.pinnedAt).toBeUndefined();
      expect(persisted[otherKey]).toStrictEqual(otherEntry);
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
        queueMode: "interrupt",
      };
      await saveSessionStore(storePath, { [sessionKey]: rotatedEntry }, { skipMaintenance: true });
      const sessionStore = { [sessionKey]: sessionEntry };

      await expect(
        persistSessionEntry({
          initialSessionEntry: initialEntry,
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
        }),
      ).resolves.toBe(false);

      expect(sessionStore[sessionKey]).toEqual(rotatedEntry);
      expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toEqual(rotatedEntry);
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
      await saveSessionStore(
        storePath,
        { [sessionKey]: concurrentEntry },
        { skipMaintenance: true },
      );
      const sessionStore = { [sessionKey]: sessionEntry };

      await expect(
        persistSessionEntry({
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
        groupActivationNeedsSystemIntro: false,
      };
      await saveSessionStore(
        storePath,
        { [sessionKey]: concurrentEntry },
        { skipMaintenance: true },
      );
      const sessionStore = { [sessionKey]: sessionEntry };

      await expect(
        persistSessionEntry({
          initialSessionEntry: initialEntry,
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath,
          touchedFields: ["groupActivation", "groupActivationNeedsSystemIntro"],
        }),
      ).resolves.toBe(false);

      expect(sessionStore[sessionKey]).toEqual(concurrentEntry);
      expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toEqual(concurrentEntry);
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
      await fs.writeFile(storePath, JSON.stringify({}, null, 2), "utf8");

      await expect(
        persistAbortTargetEntry({
          entry,
          key: sessionKey,
          sessionStore,
          storePath,
          abortCutoff: { messageSid: "42", timestamp: 123 },
        }),
      ).resolves.toBe(true);

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
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

  it("patches the persisted abort target when it already exists", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:abort-target";
      const otherKey = "agent:main:other";
      const entry: SessionEntry = {
        sessionId: "memory-session",
        updatedAt: 1,
      };
      const persistedEntry: SessionEntry = {
        sessionId: "persisted-session",
        updatedAt: 2,
        model: "sonnet-4.6",
      };
      const otherEntry: SessionEntry = {
        sessionId: "other-session",
        updatedAt: 3,
      };
      await saveSessionStore(
        storePath,
        {
          [sessionKey]: persistedEntry,
          [otherKey]: otherEntry,
        },
        { skipMaintenance: true },
      );

      await expect(
        persistAbortTargetEntry({
          entry,
          key: sessionKey,
          sessionStore: { [sessionKey]: entry },
          storePath,
        }),
      ).resolves.toBe(true);

      const persisted = loadSessionStore(storePath, { skipCache: true });
      expect(entry.abortedLastRun).toBe(true);
      expect(persisted[sessionKey]).toMatchObject({
        sessionId: "persisted-session",
        model: "sonnet-4.6",
        abortedLastRun: true,
      });
      expect(persisted[otherKey]).toStrictEqual(otherEntry);
    });
  });
});
