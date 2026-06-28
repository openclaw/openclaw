// File-backed session lifecycle operations own entry mutation and transcript artifact transitions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSessionEntryLifecycle, resetSessionEntryLifecycle } from "./session-accessor.js";
import { clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

describe("session store lifecycle mutations", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-lifecycle-mutation-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resets an entry while archiving the old transcript and creating the new header", async () => {
    const oldTranscriptPath = path.join(tempDir, "old-session.jsonl");
    const nextTranscriptPath = path.join(tempDir, "next-session.jsonl");
    const now = Date.now();
    fs.writeFileSync(oldTranscriptPath, '{"type":"session","id":"old-session"}\n', "utf-8");
    await saveSessionStore(
      storePath,
      {
        "agent:main:room": {
          sessionFile: path.join(tempDir, "stale-session.jsonl"),
          sessionId: "stale-session",
          updatedAt: now - 1,
        },
        "Agent:Main:Room": {
          sessionFile: oldTranscriptPath,
          sessionId: "old-session",
          updatedAt: now,
        },
      },
      { skipMaintenance: true },
    );

    const result = await resetSessionEntryLifecycle({
      storePath,
      target: {
        canonicalKey: "agent:main:room",
        storeKeys: ["agent:main:room", "Agent:Main:Room"],
      },
      buildNextEntry: ({ currentEntry }): SessionEntry => ({
        ...currentEntry,
        sessionFile: nextTranscriptPath,
        sessionId: "next-session",
        updatedAt: now + 1,
        systemSent: false,
        abortedLastRun: false,
      }),
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:main:room"]?.sessionId).toBe("next-session");
    expect(store["Agent:Main:Room"]).toBeUndefined();
    expect(result.previousSessionId).toBe("old-session");
    expect(result.archivedTranscripts).toHaveLength(1);
    expect(result.archivedTranscripts[0]?.archivedPath).toContain(".jsonl.reset.");
    expect(fs.existsSync(oldTranscriptPath)).toBe(false);
    expect(fs.readFileSync(nextTranscriptPath, "utf-8")).toContain('"id":"next-session"');
  });

  it("deletes an entry while archiving its transcript in the same lifecycle operation", async () => {
    const transcriptPath = path.join(tempDir, "delete-session.jsonl");
    const now = Date.now();
    fs.writeFileSync(transcriptPath, '{"type":"session","id":"delete-session"}\n', "utf-8");
    await saveSessionStore(
      storePath,
      {
        "agent:main:keep": {
          sessionId: "keep-session",
          sessionFile: path.join(tempDir, "keep-session.jsonl"),
          updatedAt: now,
        },
        "agent:main:delete": {
          sessionFile: transcriptPath,
          sessionId: "delete-session",
          updatedAt: now - 1,
        },
      },
      { skipMaintenance: true },
    );

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:delete",
        storeKeys: ["agent:main:delete"],
      },
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(result.deleted).toBe(true);
    expect(result.deletedSessionId).toBe("delete-session");
    expect(result.archivedTranscripts).toHaveLength(1);
    expect(result.archivedTranscripts[0]?.archivedPath).toContain(".jsonl.deleted.");
    expect(store["agent:main:delete"]).toBeUndefined();
    expect(store["agent:main:keep"]?.sessionId).toBe("keep-session");
    expect(fs.existsSync(transcriptPath)).toBe(false);
  });
});
