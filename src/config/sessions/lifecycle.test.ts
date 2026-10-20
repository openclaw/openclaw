import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { hasTerminalMainSessionTranscriptNewerThanRegistryAsync } from "./lifecycle-read.js";
import { resolveSessionLifecycleTimestamps } from "./lifecycle.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-lifecycle-");

describe("terminal main session transcript freshness", () => {
  let stateDir: string;
  let storePath: string;

  beforeEach(() => {
    stateDir = sessionDirs.make();
    storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  });

  async function createEntry(params: {
    endedAt?: number;
    sessionFile?: string;
    sessionKey?: string;
    status?: SessionEntry["status"];
    updatedAt: number;
  }): Promise<{ entry: SessionEntry; sessionKey: string }> {
    const { sessionKey = "agent:main:main", sessionFile, ...metadata } = params;
    const sessionId = `session-${params.status ?? "ended"}-${sessionKey.replaceAll(":", "-")}`;
    const sessionEntry = {
      ...metadata,
      sessionId,
      sessionFile:
        sessionFile ??
        `sqlite:main:${sessionId}:${resolveOpenClawAgentSqlitePath({
          agentId: "main",
          env: { OPENCLAW_STATE_DIR: stateDir },
        })}`,
    };
    await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, sessionEntry);
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        type: "custom",
        timestamp: "1970-01-01T00:00:00.001Z",
      },
    );
    return {
      entry: { ...loadEntry(sessionKey), ...metadata, sessionFile: sessionEntry.sessionFile },
      sessionKey,
    };
  }

  function loadEntry(sessionKey: string): SessionEntry {
    const entry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
    if (!entry) {
      throw new Error("expected session entry");
    }
    return entry;
  }

  function check(entry: SessionEntry, sessionKey: string): Promise<boolean> {
    return hasTerminalMainSessionTranscriptNewerThanRegistryAsync({
      agentId: "main",
      entry,
      sessionKey,
      storePath,
    });
  }

  it("uses the physical SQLite mutation watermark instead of event timestamps", async () => {
    const registryTimestampMs = Date.now() - 10_000;
    const { entry, sessionKey } = await createEntry({
      status: "killed",
      updatedAt: registryTimestampMs,
    });

    expect(entry.updatedAt).toBe(registryTimestampMs);
    const sql = observeHostDataSql();
    try {
      expect(await check(entry, sessionKey)).toBe(true);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it.each(["done", "failed"] as const)("keeps %s terminal sessions reusable", async (status) => {
    const { entry, sessionKey } = await createEntry({
      status,
      updatedAt: Date.now() - 10_000,
    });

    expect(await check(entry, sessionKey)).toBe(false);
  });

  it("keeps a yielded main session reusable after a child transcript admission", async () => {
    const { entry, sessionKey } = await createEntry({
      endedAt: Date.now() - 20_000,
      updatedAt: Date.now() - 10_000,
    });

    expect(entry.status).toBeUndefined();
    expect(entry.endedAt).toBeDefined();
    expect(await check(entry, sessionKey)).toBe(false);
  });

  it("uses SQLite freshness for entries that still contain legacy transcript paths", async () => {
    const { entry, sessionKey } = await createEntry({
      sessionFile: path.join(stateDir, "legacy-session.jsonl"),
      status: "killed",
      updatedAt: Date.now() - 10_000,
    });

    expect(await check(entry, sessionKey)).toBe(true);
  });

  it("preserves Date.parse semantics for a numeric-looking transcript header", async () => {
    const sessionId = "session-header-without-key";
    const timestamp = "2026";
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey: "agent:main:header", storePath },
      { type: "session", version: 3, id: sessionId, timestamp, cwd: stateDir },
    );

    expect(
      resolveSessionLifecycleTimestamps({
        agentId: "main",
        entry: { sessionId, updatedAt: Date.now() },
        storePath,
      }).sessionStartedAt,
    ).toBe(Date.parse(timestamp));
  });

  it("does not rotate after a same-millisecond registry write observes the mutation", async () => {
    const now = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const { entry, sessionKey } = await createEntry({
      status: "killed",
      updatedAt: now,
    });
    expect(await check(entry, sessionKey)).toBe(true);

    await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, entry);
    const refreshed = loadEntry(sessionKey);
    dateNow.mockRestore();

    expect(await check(refreshed, sessionKey)).toBe(false);
  });

  it("does not rotate non-main sessions or rows newer than the transcript", async () => {
    const nonMain = await createEntry({
      sessionKey: "agent:main:other",
      status: "killed",
      updatedAt: Date.now() - 10_000,
    });
    const newerRegistry = await createEntry({
      status: "timeout",
      updatedAt: Date.now() + 10_000,
    });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: newerRegistry.sessionKey, storePath },
      newerRegistry.entry,
    );
    const refreshedRegistry = loadEntry(newerRegistry.sessionKey);

    expect(await check(nonMain.entry, nonMain.sessionKey)).toBe(false);
    expect(await check(refreshedRegistry, newerRegistry.sessionKey)).toBe(false);
  });
});
