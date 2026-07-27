// Behavior tests for the accessor parent-fork transcript boundary.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  forkSessionFromParentTranscript,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "./session-accessor.js";
import { formatSqliteSessionFileMarker, parseSqliteSessionFileMarker } from "./sqlite-marker.js";

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function createParentSessionHeader(
  sessionId: string,
  cwd: string,
  timestamp = "2026-06-15T00:00:00.000Z",
): Record<string, unknown> {
  return { type: "session", version: 3, id: sessionId, timestamp, cwd };
}

// Seeds the parent transcript rows into the SQLite-backed accessor so the fork
// can read the parent branch by session id, mirroring the old raw-.jsonl setup.
async function seedParentTranscript(params: {
  storePath: string;
  parentSessionId: string;
  events: Record<string, unknown>[];
}): Promise<void> {
  await replaceTranscriptEvents(
    {
      agentId: "main",
      sessionId: params.parentSessionId,
      sessionKey: "agent:main:main",
      storePath: params.storePath,
    },
    params.events,
  );
}

// Persists a child session entry so SessionManager.open can resolve the forked
// SQLite transcript (the fork writes transcript rows only, not the entry).
async function persistChildEntry(params: {
  storePath: string;
  sessionFile: string;
  sessionId: string;
}): Promise<void> {
  await replaceSessionEntry(
    { sessionKey: "agent:main:child", storePath: params.storePath },
    {
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      updatedAt: Date.now(),
    },
  );
}

async function makeParentForkFixture(prefix: string) {
  const root = await makeRoot(prefix);
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(sessionsDir);
  return { root, sessionsDir, storePath: path.join(sessionsDir, "sessions.json") };
}

async function forkParentTranscript(params: { storePath: string; parentSessionId: string }) {
  const forked = await forkSessionFromParentTranscript({
    parentEntry: { sessionId: params.parentSessionId, updatedAt: Date.now() },
    agentId: "main",
    parentSessionKey: "agent:main:main",
    sessionKey: "agent:main:child",
    storePath: params.storePath,
  });
  if (forked.status !== "created") {
    throw new Error("expected forked session");
  }
  return forked.transcript;
}

async function loadChildForkRecords(storePath: string, sessionId: string) {
  return (await loadTranscriptEvents({
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:child",
    storePath,
  })) as Record<string, unknown>[];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("forkSessionFromParentTranscript", () => {
  it("forks the active branch without synchronously opening the session manager", async () => {
    const { root, sessionsDir, storePath } = await makeParentForkFixture("openclaw-parent-fork-");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd);
    const parentSessionId = "parent-session";
    const lines: Record<string, unknown>[] = [
      createParentSessionHeader(parentSessionId, cwd, "2026-05-01T00:00:00.000Z"),
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-05-01T00:00:01.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-05-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.4",
          stopReason: "stop",
          timestamp: 2,
        },
      },
      {
        type: "label",
        id: "label-1",
        parentId: "assistant-1",
        timestamp: "2026-05-01T00:00:03.000Z",
        targetId: "user-1",
        label: "start",
      },
      {
        type: "message",
        id: "delivery-side-branch",
        parentId: "label-1",
        timestamp: "2026-05-01T00:00:04.000Z",
        message: { role: "assistant", content: "side delivery" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "delivery-side-branch",
        timestamp: "2026-05-01T00:00:05.000Z",
        targetId: "label-1",
      },
    ];
    await seedParentTranscript({ storePath, parentSessionId, events: lines });

    const fork = await forkParentTranscript({ storePath, parentSessionId });
    expect(fork.sessionFile).toContain(sessionsDir);
    expect(fork.sessionId).not.toBe(parentSessionId);
    const forkedEntries = await loadChildForkRecords(storePath, fork.sessionId);
    const expectedParentSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: parentSessionId,
      storePath: parseSqliteSessionFileMarker(fork.sessionFile)!.storePath,
    });
    const forkedHeader = forkedEntries[0];
    expect(forkedHeader?.type).toBe("session");
    expect(forkedHeader?.id).toBe(fork.sessionId);
    expect(forkedHeader?.cwd).toBe(cwd);
    expect(forkedHeader?.parentSession).toBe(expectedParentSessionFile);
    expect(forkedEntries.map((entry) => entry.type)).toEqual([
      "session",
      "message",
      "message",
      "label",
      "leaf",
    ]);
    const forkedLabel = forkedEntries.find((entry) => entry.type === "label");
    expect(forkedLabel?.type).toBe("label");
    expect(forkedLabel?.targetId).toBe("user-1");
    expect(forkedLabel?.label).toBe("start");
    expect(forkedEntries.at(-1)).toMatchObject({
      type: "leaf",
      targetId: "label-1",
      appendParentId: "label-1",
    });
    expect(JSON.stringify(forkedEntries)).not.toContain("side delivery");
  });

  it("keeps opaque append-parent metadata on the active fork branch", async () => {
    const { root, sessionsDir, storePath } = await makeParentForkFixture(
      "openclaw-parent-fork-opaque-",
    );
    const parentSessionId = "parent-opaque";
    const entries: Record<string, unknown>[] = [
      createParentSessionHeader(parentSessionId, root),
      {
        type: "message",
        id: "active-root",
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        // Canonical assistant content is a block array; the SQLite transcript
        // store round-trips it verbatim (the file-era string->text-block repair
        // in normalizeLoadedFileEntry only runs on the JSONL read path).
        message: { role: "assistant", content: [{ type: "text", text: "active root" }] },
      },
      {
        type: "label",
        id: "active-label",
        parentId: "active-root",
        timestamp: "2026-06-15T00:00:01.500Z",
        targetId: "active-root",
        label: "selected",
      },
      {
        type: "message",
        id: "side-delivery",
        parentId: "active-root",
        timestamp: "2026-06-15T00:00:02.000Z",
        message: { role: "assistant", content: "side delivery" },
      },
      {
        type: "metadata",
        id: "plugin-metadata",
        parentId: "side-delivery",
        payload: { source: "plugin" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "side-delivery",
        timestamp: "2026-06-15T00:00:03.000Z",
        targetId: "active-root",
        appendParentId: "plugin-metadata",
        appendMode: "side",
      },
    ];
    await seedParentTranscript({ storePath, parentSessionId, events: entries });

    const fork = await forkParentTranscript({ storePath, parentSessionId });
    const forkedRecords = await loadChildForkRecords(storePath, fork.sessionId);
    const serialized = JSON.stringify(forkedRecords);
    expect(serialized).toContain('"id":"active-root"');
    expect(serialized).toContain('"id":"plugin-metadata"');
    expect(serialized).not.toContain("side delivery");
    expect(forkedRecords.find((entry) => entry.id === "plugin-metadata")).toMatchObject({
      parentId: "active-root",
    });
    expect(forkedRecords.find((entry) => entry.type === "label")).toMatchObject({
      targetId: "active-root",
      label: "selected",
    });
    expect(forkedRecords.at(-1)).toMatchObject({
      type: "leaf",
      targetId: "active-root",
      appendParentId: "plugin-metadata",
      appendMode: "side",
    });
    await persistChildEntry({
      storePath,
      sessionFile: fork.sessionFile,
      sessionId: fork.sessionId,
    });
    const reopened = SessionManager.open(fork.sessionFile, sessionsDir);
    reopened.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
    const records = await loadChildForkRecords(storePath, fork.sessionId);
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: "plugin-metadata" });
    expect(records.at(-1)).not.toHaveProperty("appendMode");
    expect(reopened.buildSessionContext().messages).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "active root" }] },
      { role: "user", content: "continued" },
    ]);
  });

  it("keeps parentless visible history with a disjoint append cursor", async () => {
    const { root, sessionsDir, storePath } = await makeParentForkFixture(
      "openclaw-parent-fork-disjoint-",
    );
    await seedParentTranscript({
      storePath,
      parentSessionId: "parent-disjoint",
      events: [
        createParentSessionHeader("parent-disjoint", root),
        {
          type: "message",
          id: "visible-user",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "visible question" },
        },
        {
          type: "message",
          id: "visible-assistant",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "visible answer" },
        },
        {
          type: "metadata",
          id: "append-root",
          parentId: null,
          payload: { source: "plugin" },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "append-root",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "visible-assistant",
          appendParentId: "append-root",
        },
      ],
    });

    const fork = await forkParentTranscript({ storePath, parentSessionId: "parent-disjoint" });
    await persistChildEntry({
      storePath,
      sessionFile: fork.sessionFile,
      sessionId: fork.sessionId,
    });
    const reopened = SessionManager.open(fork.sessionFile, sessionsDir);
    expect(reopened.buildSessionContext().messages).toHaveLength(2);
    reopened.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
    const records = await loadChildForkRecords(storePath, fork.sessionId);
    const serialized = JSON.stringify(records);
    expect(serialized).toContain("visible question");
    expect(serialized).toContain("visible answer");
    expect(serialized).toContain('"id":"append-root"');
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: "append-root" });
  });

  it("keeps an explicit empty visible branch separate from its opaque append parent", async () => {
    const { root, sessionsDir, storePath } = await makeParentForkFixture(
      "openclaw-parent-fork-empty-opaque-",
    );
    await seedParentTranscript({
      storePath,
      parentSessionId: "parent-empty-opaque",
      events: [
        createParentSessionHeader("parent-empty-opaque", root),
        {
          type: "message",
          id: "inactive-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "inactive history" },
        },
        {
          type: "leaf",
          id: "empty-leaf",
          parentId: "inactive-root",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: null,
          appendParentId: null,
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: "inactive-root",
          payload: { source: "plugin" },
        },
      ],
    });

    const fork = await forkParentTranscript({ storePath, parentSessionId: "parent-empty-opaque" });
    await persistChildEntry({
      storePath,
      sessionFile: fork.sessionFile,
      sessionId: fork.sessionId,
    });
    const reopened = SessionManager.open(fork.sessionFile, sessionsDir);
    expect(reopened.buildSessionContext().messages).toEqual([]);
    const continuedId = reopened.appendMessage({
      role: "user",
      content: "continued",
      timestamp: Date.now(),
    });
    reopened.appendMessage({
      role: "assistant",
      content: "done",
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      timestamp: Date.now(),
    } as unknown as AssistantMessage);
    const records = await loadChildForkRecords(storePath, fork.sessionId);
    expect(records.some((record) => record.id === "inactive-root")).toBe(false);
    expect(records.find((record) => record.id === continuedId)).toMatchObject({
      type: "message",
      parentId: "plugin-metadata",
    });
  });

  it("keeps a reachable branch suffix when an older parent is missing", async () => {
    const { root, storePath } = await makeParentForkFixture(
      "openclaw-parent-fork-missing-ancestor-",
    );
    await seedParentTranscript({
      storePath,
      parentSessionId: "parent-missing-ancestor",
      events: [
        createParentSessionHeader("parent-missing-ancestor", root),
        {
          type: "message",
          id: "reachable-tail",
          parentId: "missing-parent",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "reachable tail" },
        },
      ],
    });

    const fork = await forkParentTranscript({
      storePath,
      parentSessionId: "parent-missing-ancestor",
    });
    const records = await loadChildForkRecords(storePath, fork.sessionId);
    const serialized = JSON.stringify(records);
    expect(serialized).toContain("reachable tail");
    expect(serialized).not.toContain("missing-parent");
  });

  it("keeps visible history when the next append explicitly starts a root branch", async () => {
    const { root, sessionsDir, storePath } = await makeParentForkFixture(
      "openclaw-parent-fork-root-append-",
    );
    await seedParentTranscript({
      storePath,
      parentSessionId: "parent-root-append",
      events: [
        createParentSessionHeader("parent-root-append", root),
        {
          type: "message",
          id: "visible-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "visible history" },
        },
        {
          type: "leaf",
          id: "root-append-control",
          parentId: "inactive-tail",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: "visible-root",
          appendParentId: null,
        },
      ],
    });

    const fork = await forkParentTranscript({ storePath, parentSessionId: "parent-root-append" });
    await persistChildEntry({
      storePath,
      sessionFile: fork.sessionFile,
      sessionId: fork.sessionId,
    });
    const reopened = SessionManager.open(fork.sessionFile, sessionsDir);
    expect(reopened.buildSessionContext().messages).toHaveLength(1);
    reopened.appendMessage({ role: "user", content: "new root", timestamp: Date.now() });
    const records = await loadChildForkRecords(storePath, fork.sessionId);
    expect(records.at(-1)).toMatchObject({ type: "message", parentId: null });
  });

  it("preserves supported current-version linear transcripts", async () => {
    const { root, sessionsDir, storePath } = await makeParentForkFixture(
      "openclaw-parent-fork-linear-",
    );
    await seedParentTranscript({
      storePath,
      parentSessionId: "parent-linear",
      events: [
        createParentSessionHeader("parent-linear", root),
        {
          type: "message",
          id: "linear-user",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "hello" },
        },
        {
          type: "message",
          id: "linear-assistant",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "hi" },
        },
        {
          type: "metadata",
          id: "linear-metadata",
          parentId: "linear-assistant",
          payload: { source: "plugin" },
        },
      ],
    });

    const fork = await forkParentTranscript({ storePath, parentSessionId: "parent-linear" });
    const records = await loadChildForkRecords(storePath, fork.sessionId);
    expect(records.slice(1)).toMatchObject([
      { id: "linear-user", parentId: null },
      { id: "linear-assistant", parentId: "linear-user" },
      { id: "linear-metadata", parentId: "linear-assistant" },
    ]);
    await persistChildEntry({
      storePath,
      sessionFile: fork.sessionFile,
      sessionId: fork.sessionId,
    });
    const reopened = SessionManager.open(fork.sessionFile, sessionsDir);
    expect(reopened.buildSessionContext().messages).toHaveLength(2);
    reopened.appendMessage({ role: "user", content: "continued", timestamp: Date.now() });
    const continuedRecords = await loadChildForkRecords(storePath, fork.sessionId);
    expect(continuedRecords.at(-1)).toMatchObject({
      type: "message",
      parentId: "linear-metadata",
    });
  });

  it("creates a header-only child when the parent has no entries", async () => {
    const { root, storePath } = await makeParentForkFixture("openclaw-parent-fork-empty-");
    const parentSessionId = "parent-empty";
    await seedParentTranscript({
      storePath,
      parentSessionId,
      events: [createParentSessionHeader(parentSessionId, root, "2026-05-01T00:00:00.000Z")],
    });

    const fork = await forkParentTranscript({ storePath, parentSessionId });
    const records = await loadChildForkRecords(storePath, fork.sessionId);
    expect(records).toHaveLength(1);
    const expectedParentSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: parentSessionId,
      storePath: parseSqliteSessionFileMarker(fork.sessionFile)!.storePath,
    });
    const header = records[0];
    expect(header?.type).toBe("session");
    expect(header?.id).toBe(fork.sessionId);
    expect(header?.parentSession).toBe(expectedParentSessionFile);
  });
});
