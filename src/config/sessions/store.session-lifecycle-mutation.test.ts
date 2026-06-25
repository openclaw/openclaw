// SQLite session lifecycle operations own entry mutation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  loadSessionEntry,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";
import type { SessionEntry } from "./types.js";

type TestTranscriptEvent = Parameters<typeof replaceSqliteTranscriptEvents>[1][number];

describe("session store lifecycle mutations", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-lifecycle-mutation-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resets an entry in SQLite while archiving the previous transcript rows", async () => {
    const now = Date.now();
    await replaceSessionEntry(
      { sessionKey: "agent:main:room", storePath },
      {
        sessionId: "old-session",
        updatedAt: now,
      },
    );
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:room", sessionId: "old-session", storePath },
      [createTranscriptEvent("old-session", "before reset")],
    );
    const transcriptUpdates = recordTranscriptUpdateFiles();

    const result = await resetSessionEntryLifecycle({
      storePath,
      target: {
        canonicalKey: "agent:main:room",
        storeKeys: ["agent:main:room", "Agent:Main:Room"],
      },
      buildNextEntry: ({ currentEntry }): SessionEntry => ({
        ...currentEntry,
        sessionId: "next-session",
        updatedAt: now + 1,
        systemSent: false,
        abortedLastRun: false,
      }),
    });
    transcriptUpdates.unsubscribe();

    const stored = loadSessionEntry({ sessionKey: "agent:main:room", storePath });
    expect(stored?.sessionId).toBe("next-session");
    expect(result.previousSessionId).toBe("old-session");
    expect(result.archivedTranscripts).toHaveLength(1);
    expect(result.archivedTranscripts[0]?.archivedPath).toContain("old-session.jsonl.reset.");
    expect(transcriptUpdates.files).toContain(result.archivedTranscripts[0]?.archivedPath);
    expect(readArchiveLines(result.archivedTranscripts[0]?.archivedPath)).toEqual([
      createTranscriptEventLine("old-session", "before reset"),
    ]);
    await expect(
      loadTranscriptEvents({ sessionKey: "agent:main:room", sessionId: "old-session", storePath }),
    ).resolves.toEqual([]);
  });

  it("deletes an entry from SQLite while archiving unreferenced transcript rows", async () => {
    const now = Date.now();
    await replaceSessionEntry(
      { sessionKey: "agent:main:keep", storePath },
      {
        sessionId: "keep-session",
        updatedAt: now,
      },
    );
    await replaceSessionEntry(
      { sessionKey: "agent:main:delete", storePath },
      {
        sessionId: "delete-session",
        updatedAt: now - 1,
      },
    );
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:delete", sessionId: "delete-session", storePath },
      [createTranscriptEvent("delete-session", "before delete")],
    );
    const transcriptUpdates = recordTranscriptUpdateFiles();

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:delete",
        storeKeys: ["agent:main:delete"],
      },
    });
    transcriptUpdates.unsubscribe();

    expect(result.deleted).toBe(true);
    expect(result.deletedSessionId).toBe("delete-session");
    expect(result.archivedTranscripts).toHaveLength(1);
    expect(result.archivedTranscripts[0]?.archivedPath).toContain("delete-session.jsonl.deleted.");
    expect(transcriptUpdates.files).toContain(result.archivedTranscripts[0]?.archivedPath);
    expect(readArchiveLines(result.archivedTranscripts[0]?.archivedPath)).toEqual([
      createTranscriptEventLine("delete-session", "before delete"),
    ]);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:delete",
        sessionId: "delete-session",
        storePath,
      }),
    ).resolves.toEqual([]);
    expect(loadSessionEntry({ sessionKey: "agent:main:delete", storePath })).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: "agent:main:keep", storePath })?.sessionId).toBe(
      "keep-session",
    );
  });

  it("preserves shared SQLite transcript rows until the final session reference is deleted", async () => {
    const now = Date.now();
    await replaceSessionEntry(
      { sessionKey: "agent:main:first", storePath },
      {
        sessionId: "shared-session",
        updatedAt: now,
      },
    );
    await replaceSessionEntry(
      { sessionKey: "agent:main:second", storePath },
      {
        sessionId: "shared-session",
        updatedAt: now - 1,
      },
    );
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:first", sessionId: "shared-session", storePath },
      [createTranscriptEvent("shared-session", "shared transcript")],
    );

    const first = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:first",
        storeKeys: ["agent:main:first"],
      },
    });

    expect(first.deleted).toBe(true);
    expect(first.archivedTranscripts).toEqual([]);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:second",
        sessionId: "shared-session",
        storePath,
      }),
    ).resolves.toEqual([createTranscriptEvent("shared-session", "shared transcript")]);

    const second = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:second",
        storeKeys: ["agent:main:second"],
      },
    });

    expect(second.deleted).toBe(true);
    expect(second.archivedTranscripts).toHaveLength(1);
    expect(readArchiveLines(second.archivedTranscripts[0]?.archivedPath)).toEqual([
      createTranscriptEventLine("shared-session", "shared transcript"),
    ]);
    await expect(
      loadTranscriptEvents({
        sessionKey: "agent:main:second",
        sessionId: "shared-session",
        storePath,
      }),
    ).resolves.toEqual([]);
  });
});

function createTranscriptEvent(sessionId: string, content: string): TestTranscriptEvent {
  return JSON.parse(createTranscriptEventLine(sessionId, content)) as TestTranscriptEvent;
}

function createTranscriptEventLine(sessionId: string, content: string): string {
  return JSON.stringify({
    type: "session",
    id: sessionId,
    content,
  });
}

function readArchiveLines(archivePath: string | undefined): string[] {
  expect(archivePath).toBeTruthy();
  return fs
    .readFileSync(archivePath ?? "", "utf-8")
    .trim()
    .split("\n");
}

function recordTranscriptUpdateFiles(): { files: string[]; unsubscribe: () => void } {
  const files: string[] = [];
  return {
    files,
    unsubscribe: onSessionTranscriptUpdate((update) => {
      files.push(update.sessionFile);
    }),
  };
}
