import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionStore, saveSessionStore, type SessionEntry } from "../../config/sessions.js";
import { persistAbortTargetEntry } from "./commands-session-store.js";

describe("persistAbortTargetEntry", () => {
  it("marks active runs as killed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stop-store-"));
    const storePath = path.join(root, "sessions.json");
    const key = "agent:main:telegram:123";
    const nowMs = Date.now();
    const entry: SessionEntry = {
      sessionId: "session-running",
      updatedAt: nowMs - 5_000,
      status: "running",
      startedAt: nowMs - 30_000,
    };
    const sessionStore: Record<string, SessionEntry> = {
      [key]: { ...entry },
    };

    try {
      await saveSessionStore(storePath, sessionStore);

      await expect(
        persistAbortTargetEntry({
          entry: sessionStore[key],
          key,
          sessionStore,
          storePath,
        }),
      ).resolves.toBe(true);

      expect(sessionStore[key]).toMatchObject({
        status: "killed",
        abortedLastRun: true,
      });
      const persisted = loadSessionStore(storePath, { skipCache: true });
      expect(persisted[key]).toMatchObject({
        status: "killed",
        abortedLastRun: true,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not rewrite terminal status when no run is active", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stop-terminal-"));
    const storePath = path.join(root, "sessions.json");
    const key = "agent:main:telegram:456";
    const nowMs = Date.now();
    const entry: SessionEntry = {
      sessionId: "session-done",
      updatedAt: nowMs - 5_000,
      status: "done",
      startedAt: nowMs - 30_000,
      endedAt: nowMs - 10_000,
      runtimeMs: 20_000,
    };
    const sessionStore: Record<string, SessionEntry> = {
      [key]: { ...entry },
    };

    try {
      await saveSessionStore(storePath, sessionStore);

      await expect(
        persistAbortTargetEntry({
          entry: sessionStore[key],
          key,
          sessionStore,
          storePath,
        }),
      ).resolves.toBe(true);

      expect(sessionStore[key]).toMatchObject({
        status: "done",
        endedAt: entry.endedAt,
        runtimeMs: entry.runtimeMs,
      });
      const persisted = loadSessionStore(storePath, { skipCache: true });
      expect(persisted[key]).toMatchObject({
        status: "done",
        endedAt: entry.endedAt,
        runtimeMs: entry.runtimeMs,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
