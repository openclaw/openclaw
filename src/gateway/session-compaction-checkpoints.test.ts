import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AssistantMessage } from "../agents/pi-ai-contract.js";
import { SessionManager } from "../agents/transcript/session-transcript-contract.js";
import { getSessionEntry, upsertSessionEntry } from "../config/sessions.js";
import {
  createSqliteSessionTranscriptLocator,
  isSqliteSessionTranscriptLocator,
} from "../config/sessions/paths.js";
import {
  exportSqliteSessionTranscriptJsonl,
  hasSqliteSessionTranscriptEvents,
  hasSqliteSessionTranscriptSnapshot,
  loadSqliteSessionTranscriptEvents,
  recordSqliteSessionTranscriptSnapshot,
  replaceSqliteSessionTranscriptEvents,
} from "../config/sessions/transcript-store.sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  captureCompactionCheckpointSnapshotAsync,
  cleanupCompactionCheckpointSnapshot,
  forkCompactionCheckpointTranscriptAsync,
  MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES,
  persistSessionCompactionCheckpoint,
  readSessionLeafIdFromTranscriptAsync,
} from "./session-compaction-checkpoints.js";

const tempDirs: string[] = [];

function readSqliteTranscriptEvents(sessionId: string): Record<string, unknown>[] {
  return loadSqliteSessionTranscriptEvents({
    agentId: DEFAULT_AGENT_ID,
    sessionId,
  }).map((entry) => entry.event as Record<string, unknown>);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session-compaction-checkpoints", () => {
  test("async capture stores the pre-compaction transcript in SQLite", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-async-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir);
    session.appendMessage({
      role: "user",
      content: "before async compaction",
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "async working on it" }],
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      timestamp: Date.now(),
    } as AssistantMessage);

    const sessionFile = session.getSessionFile();
    const leafId = session.getLeafId();
    expect(sessionFile).toBeTruthy();
    expect(leafId).toBeTruthy();

    const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
    const originalBefore = exportSqliteSessionTranscriptJsonl({
      agentId: DEFAULT_AGENT_ID,
      sessionId: session.getSessionId(),
    });
    try {
      const snapshot = await captureCompactionCheckpointSnapshotAsync({
        sessionManager: session,
        sessionFile: sessionFile!,
      });

      expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
      expect(snapshot).not.toBeNull();
      expect(snapshot?.leafId).toBe(leafId);
      expect(snapshot?.sessionFile).not.toBe(sessionFile);
      expect(snapshot?.sessionFile).toContain("sqlite-transcript://");
      expect(
        hasSqliteSessionTranscriptSnapshot({
          agentId: DEFAULT_AGENT_ID,
          sessionId: session.getSessionId(),
          snapshotId: snapshot!.sessionId,
        }),
      ).toBe(true);
      const snapshotBefore = exportSqliteSessionTranscriptJsonl({
        agentId: DEFAULT_AGENT_ID,
        sessionId: snapshot!.sessionId,
      });
      expect(snapshotBefore).toContain("before async compaction");
      expect(snapshotBefore).toContain("async working on it");
      expect(snapshotBefore).not.toBe(originalBefore);

      session.appendCompaction("checkpoint summary", leafId!, 123, { ok: true });

      expect(
        exportSqliteSessionTranscriptJsonl({
          agentId: DEFAULT_AGENT_ID,
          sessionId: snapshot!.sessionId,
        }),
      ).toBe(snapshotBefore);
      expect(
        exportSqliteSessionTranscriptJsonl({
          agentId: DEFAULT_AGENT_ID,
          sessionId: session.getSessionId(),
        }),
      ).not.toBe(originalBefore);

      await cleanupCompactionCheckpointSnapshot(snapshot);

      expect(
        hasSqliteSessionTranscriptEvents({
          agentId: DEFAULT_AGENT_ID,
          sessionId: snapshot!.sessionId,
        }),
      ).toBe(true);
    } finally {
      sessionManagerOpenSpy.mockRestore();
    }
  });

  test("async capture derives session metadata without synchronous SessionManager.open", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-async-metadata-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir);
    session.appendMessage({
      role: "user",
      content: "derive checkpoint metadata",
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "assistant",
      content: "metadata derived",
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      timestamp: Date.now(),
    } as unknown as AssistantMessage);

    const sessionFile = session.getSessionFile();
    const sessionId = session.getSessionId();
    const leafId = session.getLeafId();
    expect(sessionFile).toBeTruthy();
    expect(sessionId).toBeTruthy();
    expect(leafId).toBeTruthy();

    const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
    let snapshot: Awaited<ReturnType<typeof captureCompactionCheckpointSnapshotAsync>> = null;
    try {
      expect(await readSessionLeafIdFromTranscriptAsync(sessionFile!)).toBe(leafId);
      snapshot = await captureCompactionCheckpointSnapshotAsync({
        sessionFile: sessionFile!,
      });

      expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
      expect(snapshot).not.toBeNull();
      expect(snapshot?.sessionId).not.toBe(sessionId);
      expect(snapshot?.leafId).toBe(leafId);
      expect(snapshot?.sessionFile).not.toBe(sessionFile);
      expect(snapshot?.sessionFile).toContain("sqlite-transcript://");
    } finally {
      await cleanupCompactionCheckpointSnapshot(snapshot);
      sessionManagerOpenSpy.mockRestore();
    }
  });

  test("async capture keeps checkpoint transcript locators virtual for SQLite sources", async () => {
    const sourceSessionId = "source-capture-virtual";
    const sourceFile = createSqliteSessionTranscriptLocator({
      agentId: DEFAULT_AGENT_ID,
      sessionId: sourceSessionId,
    });
    replaceSqliteSessionTranscriptEvents({
      agentId: DEFAULT_AGENT_ID,
      sessionId: sourceSessionId,
      transcriptPath: sourceFile,
      events: [
        {
          type: "session",
          id: sourceSessionId,
          timestamp: new Date(0).toISOString(),
          cwd: "/tmp/openclaw-virtual-capture",
        },
        {
          type: "message",
          id: "capture-leaf",
          role: "user",
          content: "virtual checkpoint source",
        },
      ],
    });

    const snapshot = await captureCompactionCheckpointSnapshotAsync({
      sessionFile: sourceFile,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.leafId).toBe("capture-leaf");
    expect(snapshot?.sessionFile).toBeTruthy();
    expect(isSqliteSessionTranscriptLocator(snapshot?.sessionFile)).toBe(true);
    expect(snapshot?.sessionFile).toContain("sqlite-transcript://");
    expect(snapshot?.sessionFile).not.toMatch(/^sqlite-transcript:\/[^/]/u);
    expect(
      hasSqliteSessionTranscriptSnapshot({
        agentId: DEFAULT_AGENT_ID,
        sessionId: sourceSessionId,
        snapshotId: snapshot!.sessionId,
      }),
    ).toBe(true);
    expect(readSqliteTranscriptEvents(snapshot!.sessionId)[0]).toMatchObject({
      type: "session",
      id: snapshot!.sessionId,
      parentSession: sourceFile,
    });
  });

  test("async capture skips oversized pre-compaction transcripts without sync copy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-async-oversized-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir);
    session.appendMessage({
      role: "user",
      content: "before compaction",
      timestamp: Date.now(),
    });
    const sessionFile = session.getSessionFile();
    expect(sessionFile).toBeTruthy();

    const snapshot = await captureCompactionCheckpointSnapshotAsync({
      sessionManager: session,
      sessionFile: sessionFile!,
      maxBytes: 64,
    });

    expect(snapshot).toBeNull();
    expect(MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES).toBeGreaterThan(64);
  });

  test("async fork creates a checkpoint branch transcript without SessionManager sync reads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-fork-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir);
    session.appendMessage({
      role: "user",
      content: "before checkpoint fork",
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "assistant",
      content: "fork me",
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      timestamp: Date.now(),
    } as unknown as AssistantMessage);

    const sessionFile = session.getSessionFile();
    expect(sessionFile).toBeTruthy();

    const openSpy = vi.spyOn(SessionManager, "open");
    const forkSpy = vi.spyOn(SessionManager, "forkFrom");
    let forked: Awaited<ReturnType<typeof forkCompactionCheckpointTranscriptAsync>> = null;
    try {
      forked = await forkCompactionCheckpointTranscriptAsync({
        sourceFile: sessionFile!,
      });

      expect(openSpy).not.toHaveBeenCalled();
      expect(forkSpy).not.toHaveBeenCalled();
      expect(forked).not.toBeNull();
      expect(forked?.sessionFile).not.toBe(sessionFile);
      expect(forked?.sessionId).toBeTruthy();
    } finally {
      openSpy.mockRestore();
      forkSpy.mockRestore();
    }

    const forkedEntries = readSqliteTranscriptEvents(forked!.sessionId);
    const sourceEntries = readSqliteTranscriptEvents(session.getSessionId());

    expect(forkedEntries[0]).toMatchObject({
      type: "session",
      id: forked!.sessionId,
      cwd: dir,
      parentSession: sessionFile,
    });
    expect(forkedEntries.slice(1)).toEqual(
      sourceEntries.filter((entry) => entry.type !== "session"),
    );
  });

  test("async fork keeps transcript locators virtual for SQLite sources", async () => {
    const sourceSessionId = "source-fork-virtual";
    const sourceFile = createSqliteSessionTranscriptLocator({
      agentId: DEFAULT_AGENT_ID,
      sessionId: sourceSessionId,
    });
    replaceSqliteSessionTranscriptEvents({
      agentId: DEFAULT_AGENT_ID,
      sessionId: sourceSessionId,
      transcriptPath: sourceFile,
      events: [
        {
          type: "session",
          id: sourceSessionId,
          timestamp: new Date(0).toISOString(),
          cwd: "/tmp/openclaw-virtual-fork",
        },
        {
          type: "message",
          id: "fork-leaf",
          role: "assistant",
          content: "virtual fork source",
        },
      ],
    });

    const forked = await forkCompactionCheckpointTranscriptAsync({
      sourceFile,
    });

    expect(forked).not.toBeNull();
    expect(forked?.sessionId).toBeTruthy();
    expect(isSqliteSessionTranscriptLocator(forked?.sessionFile)).toBe(true);
    expect(forked?.sessionFile).toContain("sqlite-transcript://");
    expect(forked?.sessionFile).not.toMatch(/^sqlite-transcript:\/[^/]/u);
    const forkedEntries = readSqliteTranscriptEvents(forked!.sessionId);
    expect(forkedEntries[0]).toMatchObject({
      type: "session",
      id: forked!.sessionId,
      cwd: "/tmp/openclaw-virtual-fork",
      parentSession: sourceFile,
    });
    expect(forkedEntries[1]).toMatchObject({
      type: "message",
      role: "assistant",
      content: "virtual fork source",
    });
    expect(readSqliteTranscriptEvents(sourceSessionId)[1]).toMatchObject({
      type: "message",
      id: "fork-leaf",
    });
  });

  test("async fork ignores legacy checkpoint files that doctor has not imported", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-legacy-fork-"));
    tempDirs.push(dir);

    const legacySessionFile = path.join(dir, "legacy.jsonl");
    await fs.writeFile(
      legacySessionFile,
      [
        JSON.stringify({
          type: "session",
          id: "legacy-session",
          timestamp: new Date(0).toISOString(),
          cwd: dir,
        }),
        "",
      ].join("\n"),
      "utf-8",
    );

    const forked = await forkCompactionCheckpointTranscriptAsync({
      sourceFile: legacySessionFile,
    });

    expect(forked).toBeNull();
  });

  test("persist trims old checkpoint metadata and removes trimmed SQLite snapshots", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-trim-"));
    tempDirs.push(dir);

    const sessionId = "sess";
    const sessionKey = "agent:main:main";
    const now = Date.now();
    const existingCheckpoints = Array.from({ length: 26 }, (_, index) => {
      const checkpointSessionId = `checkpoint-session-${index}`;
      replaceSqliteSessionTranscriptEvents({
        agentId: DEFAULT_AGENT_ID,
        sessionId: checkpointSessionId,
        events: [
          {
            type: "session",
            id: checkpointSessionId,
            timestamp: new Date(now + index).toISOString(),
            cwd: dir,
          },
        ],
      });
      recordSqliteSessionTranscriptSnapshot({
        agentId: DEFAULT_AGENT_ID,
        sessionId,
        snapshotId: checkpointSessionId,
        reason: "pre-compaction",
        eventCount: 1,
      });
      return {
        checkpointId: `old-${index}`,
        sessionKey,
        sessionId,
        createdAt: now + index,
        reason: "manual" as const,
        preCompaction: {
          sessionId: checkpointSessionId,
          leafId: `old-leaf-${index}`,
        },
        postCompaction: { sessionId },
      };
    });
    upsertSessionEntry({
      agentId: "main",
      sessionKey,
      entry: {
        sessionId,
        updatedAt: now,
        compactionCheckpoints: existingCheckpoints,
      },
    });

    replaceSqliteSessionTranscriptEvents({
      agentId: DEFAULT_AGENT_ID,
      sessionId: "current-snapshot",
      events: [
        {
          type: "session",
          id: "current-snapshot",
          timestamp: new Date(now + 100).toISOString(),
          cwd: dir,
        },
      ],
    });

    const stored = await persistSessionCompactionCheckpoint({
      cfg: {
        session: {},
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      sessionKey,
      sessionId,
      reason: "manual",
      snapshot: {
        sessionId: "current-snapshot",
        leafId: "current-leaf",
      },
      createdAt: now + 100,
    });

    expect(stored).not.toBeNull();
    expect(
      hasSqliteSessionTranscriptEvents({
        agentId: DEFAULT_AGENT_ID,
        sessionId: existingCheckpoints[0].preCompaction.sessionId,
      }),
    ).toBe(false);
    expect(
      hasSqliteSessionTranscriptSnapshot({
        agentId: DEFAULT_AGENT_ID,
        sessionId,
        snapshotId: existingCheckpoints[0].preCompaction.sessionId,
      }),
    ).toBe(false);
    expect(
      hasSqliteSessionTranscriptEvents({
        agentId: DEFAULT_AGENT_ID,
        sessionId: existingCheckpoints[1].preCompaction.sessionId,
      }),
    ).toBe(false);
    expect(
      hasSqliteSessionTranscriptSnapshot({
        agentId: DEFAULT_AGENT_ID,
        sessionId,
        snapshotId: existingCheckpoints[1].preCompaction.sessionId,
      }),
    ).toBe(false);
    expect(
      hasSqliteSessionTranscriptEvents({
        agentId: DEFAULT_AGENT_ID,
        sessionId: existingCheckpoints[2].preCompaction.sessionId,
      }),
    ).toBe(true);
    expect(
      hasSqliteSessionTranscriptSnapshot({
        agentId: DEFAULT_AGENT_ID,
        sessionId,
        snapshotId: existingCheckpoints[2].preCompaction.sessionId,
      }),
    ).toBe(true);
    expect(
      hasSqliteSessionTranscriptEvents({
        agentId: DEFAULT_AGENT_ID,
        sessionId: "current-snapshot",
      }),
    ).toBe(true);

    expect(getSessionEntry({ agentId: "main", sessionKey })?.compactionCheckpoints).toHaveLength(
      25,
    );
  });
});
