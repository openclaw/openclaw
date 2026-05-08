import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionTranscriptLocator } from "../../config/sessions/paths.js";
import {
  loadSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScopeForPath,
} from "../../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { openTranscriptSessionManager } from "./session-manager.js";
import { SessionManager } from "./session-transcript-contract.js";
import { replaceTranscriptStateEventsSync } from "./transcript-state.js";

async function makeTempSessionFile(name = "session.jsonl"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-session-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  return path.join(dir, name);
}

function readSessionEntries(sessionFile: string) {
  const scope = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: sessionFile });
  if (!scope) {
    return [];
  }
  return loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("TranscriptSessionManager", () => {
  it("exposes create, in-memory, list, continue, and fork through the contract value", async () => {
    await makeTempSessionFile();
    const memory = SessionManager.inMemory("/tmp/memory-workspace");
    expect(memory.isPersisted()).toBe(false);
    expect(memory.getSessionFile()).toBeUndefined();
    const memoryUserId = memory.appendMessage({
      role: "user",
      content: "in memory",
      timestamp: 1,
    });
    expect(memory.getLeafId()).toBe(memoryUserId);

    const created = SessionManager.create("/tmp/workspace");
    created.appendMessage({ role: "user", content: "persist me", timestamp: 2 });
    const sessionFile = created.getSessionFile();
    expect(sessionFile).toBeTruthy();
    if (!sessionFile) {
      throw new Error("expected created session file");
    }

    const listed = await SessionManager.list("/tmp/workspace");
    expect(listed.map((session) => session.id)).toContain(created.getSessionId());

    const continued = SessionManager.continueRecent("/tmp/workspace");
    expect(continued.getSessionId()).toBe(created.getSessionId());

    const forked = SessionManager.forkFrom(sessionFile, "/tmp/forked-workspace");
    expect(forked.getHeader()).toMatchObject({
      cwd: "/tmp/forked-workspace",
      parentSession: sessionFile,
    });
    expect(forked.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "persist me" },
    ]);
  });

  it("rejects an unmigrated explicit legacy session file", async () => {
    const sessionFile = await makeTempSessionFile();

    expect(() =>
      openTranscriptSessionManager({
        sessionFile,
        sessionId: "session-1",
        cwd: "/tmp/workspace",
      }),
    ).toThrow(/Legacy transcript has not been imported into SQLite/);
  });

  it("rejects runtime writes to unmigrated legacy session files", async () => {
    const sessionFile = await makeTempSessionFile();

    expect(() =>
      replaceTranscriptStateEventsSync(sessionFile, [
        {
          type: "session",
          version: 3,
          id: "session-legacy-write",
          timestamp: new Date(0).toISOString(),
          cwd: "/tmp/workspace",
        },
      ]),
    ).toThrow(/Legacy transcript has not been imported into SQLite/);
  });

  it("opens virtual sqlite transcript locators without resolving them as filesystem paths", async () => {
    await makeTempSessionFile();
    const sessionFile = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "virtual-session",
    });

    const sessionManager = openTranscriptSessionManager({
      sessionFile,
      sessionId: "virtual-session",
      cwd: "/tmp/workspace",
    });

    expect(sessionManager.getSessionFile()).toBe(sessionFile);
    expect(
      resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: sessionFile }),
    ).toMatchObject({
      agentId: "main",
      sessionId: "virtual-session",
    });
    expect(readSessionEntries(sessionFile)).toMatchObject([
      {
        type: "session",
        id: "virtual-session",
        cwd: "/tmp/workspace",
      },
    ]);
  });

  it("creates, branches, lists, and forks default sessions with virtual sqlite locators", async () => {
    await makeTempSessionFile();
    const sessionManager = SessionManager.create("/tmp/sqlite-workspace");
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("expected session file");
    }
    expect(sessionFile).toMatch(/^sqlite-transcript:\/\/main\//);

    const userId = sessionManager.appendMessage({
      role: "user",
      content: "sqlite default",
      timestamp: 3,
    });
    const branchFile = sessionManager.createBranchedSession(userId);
    if (!branchFile) {
      throw new Error("expected branch file");
    }
    expect(branchFile).toMatch(/^sqlite-transcript:\/\/main\//);

    const listed = await SessionManager.list("/tmp/sqlite-workspace");
    expect(listed.map((session) => session.id)).toContain(sessionManager.getSessionId());

    const forked = SessionManager.forkFrom(sessionFile, "/tmp/sqlite-fork");
    expect(forked.getSessionFile()).toMatch(/^sqlite-transcript:\/\/main\//);
    expect(forked.getHeader()).toMatchObject({
      cwd: "/tmp/sqlite-fork",
      parentSession: sessionFile,
    });
  });

  it("preserves non-main agent scope for virtual sqlite branches and forks", async () => {
    await makeTempSessionFile();
    const sessionFile = createSqliteSessionTranscriptLocator({
      agentId: "qa",
      sessionId: "qa-source-session",
    });
    const sessionManager = openTranscriptSessionManager({
      sessionFile,
      sessionId: "qa-source-session",
      cwd: "/tmp/qa-workspace",
    });
    const userId = sessionManager.appendMessage({
      role: "user",
      content: "qa source",
      timestamp: 4,
    });

    const branchFile = sessionManager.createBranchedSession(userId);
    expect(branchFile).toMatch(/^sqlite-transcript:\/\/qa\//);
    expect(
      resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: branchFile! }),
    ).toMatchObject({
      agentId: "qa",
    });

    const forked = SessionManager.forkFrom(sessionFile, "/tmp/qa-fork");
    expect(forked.getSessionFile()).toMatch(/^sqlite-transcript:\/\/qa\//);
    expect(
      resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: forked.getSessionFile()! }),
    ).toMatchObject({
      agentId: "qa",
    });
  });

  it("persists initial user messages synchronously before the first assistant message", async () => {
    await makeTempSessionFile();
    const sessionFile = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "session-sync",
    });
    const sessionManager = openTranscriptSessionManager({
      sessionFile,
      sessionId: "session-sync",
      cwd: "/tmp/workspace",
    });

    const userId = sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });

    const afterUser = readSessionEntries(sessionFile);
    expect(afterUser).toHaveLength(2);
    expect(afterUser[1]).toMatchObject({
      type: "message",
      id: userId,
      parentId: null,
      message: { role: "user", content: "hello" },
    });

    const assistantId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });

    const reopened = openTranscriptSessionManager({ sessionFile });
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([userId, assistantId]);
    expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("removes persisted tail entries through SQLite instead of rewriting JSONL", async () => {
    await makeTempSessionFile();
    const sessionFile = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "session-tail",
    });
    const sessionManager = openTranscriptSessionManager({
      sessionFile,
      sessionId: "session-tail",
      cwd: "/tmp/workspace",
    });

    const userId = sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    const assistantId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "synthetic" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      timestamp: 2,
    });

    expect(
      sessionManager.removeTailEntries((entry) => (entry as { id?: string }).id === assistantId),
    ).toBe(1);

    const reopened = openTranscriptSessionManager({ sessionFile });
    expect(reopened.getEntry(assistantId)).toBeUndefined();
    expect(reopened.getLeafId()).toBe(userId);
    expect(readSessionEntries(sessionFile).map((entry) => (entry as { id?: string }).id)).toEqual([
      "session-tail",
      userId,
    ]);
  });

  it("supports tree, label, name, and branch summary session APIs", async () => {
    await makeTempSessionFile();
    const sessionFile = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "session-tree",
    });
    const sessionManager = openTranscriptSessionManager({
      sessionFile,
      sessionId: "session-tree",
      cwd: "/tmp/workspace",
    });
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
    const childId = sessionManager.appendMessage({ role: "user", content: "child", timestamp: 2 });
    sessionManager.branch(rootId);
    const siblingId = sessionManager.appendMessage({
      role: "user",
      content: "sibling",
      timestamp: 3,
    });
    sessionManager.appendLabelChange(siblingId, "alternate");
    sessionManager.appendSessionInfo("Named session");
    const summaryId = sessionManager.branchWithSummary(childId, "Back to main branch.");

    expect(sessionManager.getChildren(rootId).map((entry) => entry.id)).toEqual([
      childId,
      siblingId,
    ]);
    expect(sessionManager.getLabel(siblingId)).toBe("alternate");
    expect(sessionManager.getSessionName()).toBe("Named session");
    expect(sessionManager.getTree()[0]).toMatchObject({
      entry: { id: rootId },
      children: [{ entry: { id: childId } }, { entry: { id: siblingId }, label: "alternate" }],
    });

    const reopened = openTranscriptSessionManager({ sessionFile });
    expect(reopened.getEntry(summaryId)).toMatchObject({
      type: "branch_summary",
      fromId: childId,
      summary: "Back to main branch.",
    });
  });
});
