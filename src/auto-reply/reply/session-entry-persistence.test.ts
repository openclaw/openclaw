import path from "node:path";
import { describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
} from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { persistReplySessionEntry } from "./session-entry-persistence.js";

const tempDirs = useAutoCleanupTempDirTracker();

describe("persistReplySessionEntry", () => {
  it("does not restore policy fields revoked during reply processing", async () => {
    const dir = tempDirs.make("openclaw-reply-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 100,
        thinkingLevel: "low",
        elevatedLevel: "full",
        inheritedToolAllow: ["exec"],
        sendPolicy: "allow",
      };
      const currentEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 400,
        thinkingLevel: "low",
        sendPolicy: "deny",
      };
      await saveSessionStore(storePath, { main: currentEntry }, { skipMaintenance: true });

      const result = await persistReplySessionEntry({
        storePath,
        sessionKey: "main",
        initialEntry,
        entry: {
          ...initialEntry,
          thinkingLevel: "high",
          updatedAt: 250,
        },
      });

      expect(result.status).toBe("current");
      if (result.status !== "current") {
        throw new Error("expected current persisted session");
      }
      expect(result.entry).toMatchObject({
        sessionId: "session-1",
        thinkingLevel: "high",
        sendPolicy: "deny",
        updatedAt: 400,
      });
      expect(result.entry.elevatedLevel).toBeUndefined();
      expect(result.entry.inheritedToolAllow).toBeUndefined();
      expect(loadSessionStore(storePath, { skipCache: true }).main).toEqual(result.entry);
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("rejects persistence when the session rotated", async () => {
    const dir = tempDirs.make("openclaw-reply-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 100,
        thinkingLevel: "low",
      };
      const currentEntry: SessionEntry = {
        sessionId: "session-2",
        updatedAt: 400,
        thinkingLevel: "medium",
      };
      await saveSessionStore(storePath, { main: currentEntry }, { skipMaintenance: true });

      const result = await persistReplySessionEntry({
        storePath,
        sessionKey: "main",
        initialEntry,
        entry: { ...initialEntry, thinkingLevel: "high", updatedAt: 250 },
      });

      expect(result).toEqual({
        status: "lifecycle-invalidated",
        error: 'Session "main" changed while starting work. Retry.',
        entry: currentEntry,
      });
      expect(loadSessionStore(storePath, { skipCache: true }).main).toEqual(currentEntry);
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("does not recreate a row deleted after reply initialization by default", async () => {
    const dir = tempDirs.make("openclaw-reply-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 100,
      };
      await saveSessionStore(storePath, {}, { skipMaintenance: true });

      const result = await persistReplySessionEntry({
        storePath,
        sessionKey: "main",
        initialEntry,
        entry: { ...initialEntry, updatedAt: 250 },
      });

      expect(result).toEqual({
        status: "lifecycle-invalidated",
        error: 'Session "main" was deleted while starting work. Retry.',
      });
      expect(loadSessionStore(storePath, { skipCache: true }).main).toBeUndefined();
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("rejects same-value persistence after the session is archived", async () => {
    const dir = tempDirs.make("openclaw-reply-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 100,
        modelOverride: "gpt-5.5",
      };
      const archivedEntry: SessionEntry = {
        ...initialEntry,
        updatedAt: 400,
        archivedAt: 300,
      };
      await saveSessionStore(storePath, { main: archivedEntry }, { skipMaintenance: true });

      const result = await persistReplySessionEntry({
        storePath,
        sessionKey: "main",
        initialEntry,
        entry: { ...initialEntry, updatedAt: 250 },
        touchedFields: ["modelOverride"],
      });

      expect(result).toEqual({
        status: "lifecycle-invalidated",
        error: 'Session "main" is archived. Restore it before starting new work.',
        entry: archivedEntry,
      });
      expect(loadSessionStore(storePath, { skipCache: true }).main).toEqual(archivedEntry);
    } finally {
      clearSessionStoreCacheForTest();
    }
  });
});
