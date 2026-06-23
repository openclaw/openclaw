import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionStore, saveSessionStore } from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { persistAbortTargetEntry, persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";

async function withTempStore<T>(run: (storePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-session-store-"));
  try {
    return await run(path.join(dir, "sessions.json"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("commands session store persistence", () => {
  it("persists a single command session entry through the accessor", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "agent:main:command";
      const otherKey = "agent:main:other";
      const entry: SessionEntry = {
        sessionId: "command-session",
        updatedAt: 1,
        model: "gpt-5.5",
      };
      const otherEntry: SessionEntry = {
        sessionId: "other-session",
        updatedAt: 2,
      };
      await saveSessionStore(
        storePath,
        {
          [sessionKey]: { ...entry },
          [otherKey]: { ...otherEntry },
        },
        { skipMaintenance: true },
      );
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };

      await expect(
        persistSessionEntry({
          sessionEntry: entry,
          sessionStore,
          sessionKey,
          storePath,
        } as Parameters<CommandHandler>[0]),
      ).resolves.toBe(true);

      const persisted = loadSessionStore(storePath, { skipCache: true });
      expect(sessionStore[sessionKey]).toBe(entry);
      expect(entry.updatedAt).not.toBe(1);
      expect(persisted[sessionKey]).toMatchObject({
        sessionId: "command-session",
        model: "gpt-5.5",
        updatedAt: entry.updatedAt,
      });
      expect(persisted[otherKey]).toStrictEqual(otherEntry);
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
