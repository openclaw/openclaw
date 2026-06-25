// SQLite session lifecycle operations own entry mutation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

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

  it("resets an entry in SQLite while reporting the previous session", async () => {
    const now = Date.now();
    await replaceSessionEntry(
      { sessionKey: "agent:main:room", storePath },
      {
        sessionId: "old-session",
        updatedAt: now,
      },
    );

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

    const stored = loadSessionEntry({ sessionKey: "agent:main:room", storePath });
    expect(stored?.sessionId).toBe("next-session");
    expect(result.previousSessionId).toBe("old-session");
    expect(result.archivedTranscripts).toEqual([]);
  });

  it("deletes an entry from SQLite while preserving unrelated entries", async () => {
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

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:delete",
        storeKeys: ["agent:main:delete"],
      },
    });

    expect(result.deleted).toBe(true);
    expect(result.deletedSessionId).toBe("delete-session");
    expect(result.archivedTranscripts).toEqual([]);
    expect(loadSessionEntry({ sessionKey: "agent:main:delete", storePath })).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: "agent:main:keep", storePath })?.sessionId).toBe(
      "keep-session",
    );
  });
});
