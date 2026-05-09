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

async function makeTempTranscriptLocator(name = "session.jsonl"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-session-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  return path.join(dir, name);
}

function readSessionEntries(transcriptLocator: string) {
  const scope = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: transcriptLocator });
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
    await makeTempTranscriptLocator();
    const memory = SessionManager.inMemory("/tmp/memory-workspace");
    expect(memory.isPersisted()).toBe(false);
    expect(memory.getTranscriptLocator()).toBeUndefined();
    const memoryUserId = memory.appendMessage({
      role: "user",
      content: "in memory",
      timestamp: 1,
    });
    expect(memory.getLeafId()).toBe(memoryUserId);

    const created = SessionManager.create("/tmp/workspace");
    created.appendMessage({ role: "user", content: "persist me", timestamp: 2 });
    const transcriptLocator = created.getTranscriptLocator();
    expect(transcriptLocator).toBeTruthy();
    if (!transcriptLocator) {
      throw new Error("expected created transcript locator");
    }

    const listed = await SessionManager.list("/tmp/workspace");
    expect(listed.map((session) => session.id)).toContain(created.getSessionId());

    const continued = SessionManager.continueRecent("/tmp/workspace");
    expect(continued.getSessionId()).toBe(created.getSessionId());

    const forked = SessionManager.forkFrom(transcriptLocator, "/tmp/forked-workspace");
    expect(forked.getHeader()).toMatchObject({
      cwd: "/tmp/forked-workspace",
      parentSession: transcriptLocator,
    });
    expect(forked.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "persist me" },
    ]);
  });

  it("rejects filesystem transcript locators at runtime", async () => {
    const transcriptLocator = await makeTempTranscriptLocator();

    expect(() =>
      openTranscriptSessionManager({
        transcriptLocator,
        sessionId: "session-1",
        cwd: "/tmp/workspace",
      }),
    ).toThrow(/Transcript locator must be SQLite-backed/);
  });

  it("rejects runtime writes to filesystem transcript locators", async () => {
    const transcriptLocator = await makeTempTranscriptLocator();

    expect(() =>
      replaceTranscriptStateEventsSync(transcriptLocator, [
        {
          type: "session",
          version: 3,
          id: "session-legacy-write",
          timestamp: new Date(0).toISOString(),
          cwd: "/tmp/workspace",
        },
      ]),
    ).toThrow(/Transcript locator must be SQLite-backed/);
  });

  it("opens virtual sqlite transcript locators without resolving them as filesystem paths", async () => {
    await makeTempTranscriptLocator();
    const transcriptLocator = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "virtual-session",
    });

    const sessionManager = openTranscriptSessionManager({
      transcriptLocator,
      sessionId: "virtual-session",
      cwd: "/tmp/workspace",
    });

    expect(sessionManager.getTranscriptLocator()).toBe(transcriptLocator);
    expect(
      resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: transcriptLocator }),
    ).toMatchObject({
      agentId: "main",
      sessionId: "virtual-session",
    });
    expect(readSessionEntries(transcriptLocator)).toMatchObject([
      {
        type: "session",
        id: "virtual-session",
        cwd: "/tmp/workspace",
      },
    ]);
  });

  it("uses the virtual sqlite transcript locator session id when no explicit id is supplied", async () => {
    await makeTempTranscriptLocator();
    const transcriptLocator = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "locator-session",
    });

    const sessionManager = openTranscriptSessionManager({
      transcriptLocator,
      cwd: "/tmp/workspace",
    });
    sessionManager.appendMessage({ role: "user", content: "seed", timestamp: 1 });

    expect(sessionManager.getSessionId()).toBe("locator-session");
    expect(readSessionEntries(transcriptLocator)).toMatchObject([
      {
        type: "session",
        id: "locator-session",
        cwd: "/tmp/workspace",
      },
      {
        type: "message",
        message: { role: "user", content: "seed" },
      },
    ]);
  });

  it("creates, branches, lists, and forks default sessions with virtual sqlite locators", async () => {
    await makeTempTranscriptLocator();
    const sessionManager = SessionManager.create("/tmp/sqlite-workspace");
    const transcriptLocator = sessionManager.getTranscriptLocator();
    if (!transcriptLocator) {
      throw new Error("expected transcript locator");
    }
    expect(transcriptLocator).toMatch(/^sqlite-transcript:\/\/main\//);

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

    const forked = SessionManager.forkFrom(transcriptLocator, "/tmp/sqlite-fork");
    expect(forked.getTranscriptLocator()).toMatch(/^sqlite-transcript:\/\/main\//);
    expect(forked.getHeader()).toMatchObject({
      cwd: "/tmp/sqlite-fork",
      parentSession: transcriptLocator,
    });
  });

  it("allocates a fresh sqlite transcript locator when starting a new persisted session", async () => {
    await makeTempTranscriptLocator();
    const sessionManager = openTranscriptSessionManager({
      transcriptLocator: createSqliteSessionTranscriptLocator({
        agentId: "main",
        sessionId: "first-session",
      }),
      sessionId: "first-session",
      cwd: "/tmp/workspace",
    });
    sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });

    const firstTranscriptLocator = sessionManager.getTranscriptLocator();
    const secondTranscriptLocator = sessionManager.newSession({ id: "second-session" });
    sessionManager.appendMessage({ role: "user", content: "second", timestamp: 2 });

    expect(secondTranscriptLocator).toBe(
      createSqliteSessionTranscriptLocator({
        agentId: "main",
        sessionId: "second-session",
      }),
    );
    expect(secondTranscriptLocator).not.toBe(firstTranscriptLocator);
    expect(
      readSessionEntries(firstTranscriptLocator!).map((entry) => (entry as { id?: string }).id),
    ).toEqual(["first-session", expect.any(String)]);
    expect(readSessionEntries(secondTranscriptLocator!)).toMatchObject([
      { type: "session", id: "second-session" },
      { type: "message", message: { role: "user", content: "second" } },
    ]);
  });

  it("preserves non-main agent scope for virtual sqlite branches and forks", async () => {
    await makeTempTranscriptLocator();
    const transcriptLocator = createSqliteSessionTranscriptLocator({
      agentId: "qa",
      sessionId: "qa-source-session",
    });
    const sessionManager = openTranscriptSessionManager({
      transcriptLocator,
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

    const forked = SessionManager.forkFrom(transcriptLocator, "/tmp/qa-fork");
    expect(forked.getTranscriptLocator()).toMatch(/^sqlite-transcript:\/\/qa\//);
    expect(
      resolveSqliteSessionTranscriptScopeForPath({
        transcriptPath: forked.getTranscriptLocator()!,
      }),
    ).toMatchObject({
      agentId: "qa",
    });
  });

  it("persists initial user messages synchronously before the first assistant message", async () => {
    await makeTempTranscriptLocator();
    const transcriptLocator = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "session-sync",
    });
    const sessionManager = openTranscriptSessionManager({
      transcriptLocator,
      sessionId: "session-sync",
      cwd: "/tmp/workspace",
    });

    const userId = sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });

    const afterUser = readSessionEntries(transcriptLocator);
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

    const reopened = openTranscriptSessionManager({ transcriptLocator });
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([userId, assistantId]);
    expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("removes persisted tail entries through SQLite instead of rewriting JSONL", async () => {
    await makeTempTranscriptLocator();
    const transcriptLocator = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "session-tail",
    });
    const sessionManager = openTranscriptSessionManager({
      transcriptLocator,
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

    const reopened = openTranscriptSessionManager({ transcriptLocator });
    expect(reopened.getEntry(assistantId)).toBeUndefined();
    expect(reopened.getLeafId()).toBe(userId);
    expect(
      readSessionEntries(transcriptLocator).map((entry) => (entry as { id?: string }).id),
    ).toEqual(["session-tail", userId]);
  });

  it("supports tree, label, name, and branch summary session APIs", async () => {
    await makeTempTranscriptLocator();
    const transcriptLocator = createSqliteSessionTranscriptLocator({
      agentId: "main",
      sessionId: "session-tree",
    });
    const sessionManager = openTranscriptSessionManager({
      transcriptLocator,
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

    const reopened = openTranscriptSessionManager({ transcriptLocator });
    expect(reopened.getEntry(summaryId)).toMatchObject({
      type: "branch_summary",
      fromId: childId,
      summary: "Back to main branch.",
    });
  });
});
