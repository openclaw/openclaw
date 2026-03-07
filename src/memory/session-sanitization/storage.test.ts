import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendSessionMemoryAuditEntry,
  appendSessionMemorySummaryEntry,
  readSessionMemoryAuditEntries,
  readSessionMemorySummaryEntries,
  resolveSessionMemoryAuditFile,
  resolveSessionMemorySummaryFile,
  sweepOldAuditEntries,
  upsertSessionMemorySummaryEntry,
} from "./storage.js";

const AGENT_ID = "main";
const SESSION_ID = "sess-storage-1";

describe("session-sanitization storage", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempStateDir = "";

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-storage-test-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    await fs.rm(tempStateDir, { recursive: true, force: true });
  });

  it("serializes concurrent summary upserts so updates are not lost", async () => {
    await appendSessionMemorySummaryEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        messageId: "msg-1",
        timestamp: "2026-03-07T00:00:00.000Z",
        rawExpiresAt: "2099-01-01T00:00:00.000Z",
        source: "transcript",
        decisions: ["d1"],
        actionItems: [],
        entities: [],
        contextNote: "seed-a",
        discard: false,
      },
    });
    await appendSessionMemorySummaryEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        messageId: "msg-2",
        timestamp: "2026-03-07T00:00:01.000Z",
        rawExpiresAt: "2099-01-01T00:00:00.000Z",
        source: "transcript",
        decisions: ["d2"],
        actionItems: [],
        entities: [],
        contextNote: "seed-b",
        discard: false,
      },
    });

    const summaryFile = resolveSessionMemorySummaryFile(AGENT_ID, SESSION_ID);
    const originalWriteFile = fs.writeFile.bind(fs) as typeof fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        const [filePath, data] = args;
        if (
          typeof filePath === "string" &&
          filePath === summaryFile &&
          typeof data === "string" &&
          data.includes('"contextNote":"A-update"')
        ) {
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return await originalWriteFile(...args);
      },
    );

    const upsertA = upsertSessionMemorySummaryEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        messageId: "msg-1",
        timestamp: "2026-03-07T00:01:00.000Z",
        rawExpiresAt: "2099-01-01T00:00:00.000Z",
        source: "transcript",
        decisions: ["d1-updated"],
        actionItems: [],
        entities: [],
        contextNote: "A-update",
        discard: false,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const upsertB = upsertSessionMemorySummaryEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        messageId: "msg-2",
        timestamp: "2026-03-07T00:01:01.000Z",
        rawExpiresAt: "2099-01-01T00:00:00.000Z",
        source: "transcript",
        decisions: ["d2-updated"],
        actionItems: [],
        entities: [],
        contextNote: "B-update",
        discard: false,
      },
    });
    await Promise.all([upsertA, upsertB]);

    const entries = await readSessionMemorySummaryEntries({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.messageId === "msg-1")?.contextNote).toBe("A-update");
    expect(entries.find((entry) => entry.messageId === "msg-2")?.contextNote).toBe("B-update");
  });

  it("serializes audit sweep rewrites with concurrent appends", async () => {
    await appendSessionMemoryAuditEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        event: "sanitized_pass",
        timestamp: "2000-01-01T00:00:00.000Z",
        messageId: "old-seed",
      },
    });
    await appendSessionMemoryAuditEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        event: "sanitized_pass",
        timestamp: new Date().toISOString(),
        messageId: "fresh-seed",
      },
    });

    const auditFile = resolveSessionMemoryAuditFile(AGENT_ID, SESSION_ID);
    const originalWriteFile = fs.writeFile.bind(fs) as typeof fs.writeFile;
    let releaseSweepWrite: (() => void) | null = null;
    const sweepWriteStarted = new Promise<void>((resolve) => {
      releaseSweepWrite = resolve;
    });
    let delayedOnce = false;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      const [filePath, data] = args;
      if (
        !delayedOnce &&
        typeof filePath === "string" &&
        filePath === auditFile &&
        typeof data === "string" &&
        data.includes('"messageId":"fresh-seed"')
      ) {
        delayedOnce = true;
        releaseSweepWrite?.();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return await originalWriteFile(...args);
    });

    const sweep = sweepOldAuditEntries({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      retentionDays: 30,
    });
    await sweepWriteStarted;
    const append = appendSessionMemoryAuditEntry({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      entry: {
        event: "sanitized_pass",
        timestamp: new Date().toISOString(),
        messageId: "new-entry",
      },
    });
    await Promise.all([sweep, append]);

    const entries = await readSessionMemoryAuditEntries({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    const messageIds = entries.map((entry) => entry.messageId);
    expect(messageIds).toContain("fresh-seed");
    expect(messageIds).toContain("new-entry");
    expect(messageIds).not.toContain("old-seed");
  });
});
