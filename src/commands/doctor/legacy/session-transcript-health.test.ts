import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../../terminal/note.js", () => ({
  note,
}));

import { loadSqliteSessionTranscriptEvents } from "../../../config/sessions/transcript-store.sqlite.js";
import { createPluginStateSyncKeyedStore } from "../../../plugin-state/plugin-state-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { noteSessionTranscriptHealth } from "./session-transcript-health.js";

const CODEX_APP_SERVER_BINDING_PLUGIN_ID = "codex";
const CODEX_APP_SERVER_BINDING_NAMESPACE = "app-server-thread-bindings";
const CODEX_APP_SERVER_BINDING_MAX_ENTRIES = 10_000;

function countNonEmptyLines(value: string): number {
  let count = 0;
  for (const line of value.split(/\r?\n/)) {
    if (line) {
      count += 1;
    }
  }
  return count;
}

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("doctor session transcript repair", () => {
  let root: string;

  beforeEach(async () => {
    note.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-transcripts-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeTranscript(entries: unknown[]): Promise<string> {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return filePath;
  }

  it("imports affected prompt-rewrite branches as active SQLite transcript rows", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content: [
            "visible ask",
            "",
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "secret",
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "plain-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "plain-assistant",
        parentId: "plain-user",
        message: { role: "assistant", content: "answer" },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    await expect(fs.access(filePath)).rejects.toThrow();
    expect(
      loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "session-1",
      })
        .map((entry) => entry.event as { type?: string; id?: string })
        .filter((entry) => entry.type !== "session")
        .map((entry) => entry.id),
    ).toEqual(["parent", "plain-user", "plain-assistant"]);
  });

  it("reports affected transcripts without rewriting outside repair mode", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "runtime-user",
        parentId: null,
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "plain-user",
        parentId: null,
        message: { role: "user", content: "visible ask" },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: false, sessionDirs: [sessionsDir] });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = requireFirstMockCall(note, "doctor note") as [string, string];
    expect(title).toBe("Session transcripts");
    expect(message).toContain("legacy transcript JSONL");
    expect(message).toContain('Run "openclaw doctor --fix"');
    expect(countNonEmptyLines(await fs.readFile(filePath, "utf-8"))).toBe(3);
  });

  it("imports legacy transcript files into SQLite during repair mode", async () => {
    const filePath = await writeTranscript([
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-04-25T00:00:00Z",
        cwd: root,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        message: { role: "user", content: "hello" },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    await expect(fs.access(filePath)).rejects.toThrow();
    expect(
      loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "session-1",
      }).map((entry) => entry.event),
    ).toMatchObject([
      { type: "session", version: 1, id: "session-1" },
      { type: "message", id: "user-1" },
    ]);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Session transcripts");
    expect(message).toContain("Imported 1 transcript file into SQLite");
  });

  it("imports legacy Codex app-server binding sidecars during repair mode", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const legacyTranscriptPath = path.join(sessionsDir, "session.jsonl");
    await fs.writeFile(
      legacyTranscriptPath,
      `${JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: root })}\n`,
    );
    const sidecarPath = `${legacyTranscriptPath}.codex-app-server.json`;
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-123",
        cwd: root,
        model: "gpt-5.5",
      }),
    );

    await noteSessionTranscriptHealth({ shouldRepair: true, sessionDirs: [sessionsDir] });

    await expect(fs.access(sidecarPath)).rejects.toThrow();
    expect(
      createPluginStateSyncKeyedStore<Record<string, unknown>>(CODEX_APP_SERVER_BINDING_PLUGIN_ID, {
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      }).lookup("session-1"),
    ).toMatchObject({
      schemaVersion: 1,
      threadId: "thread-123",
      sessionId: "session-1",
      cwd: root,
      model: "gpt-5.5",
    });
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Session transcripts");
    expect(message).toContain("Imported 1 Codex app-server binding sidecar into SQLite");
  });

  it("ignores ordinary branch history without internal runtime context", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "branch-a",
        parentId: null,
        message: { role: "user", content: "draft A" },
      },
      {
        type: "message",
        id: "branch-b",
        parentId: null,
        message: { role: "user", content: "draft B" },
      },
    ]);

    await noteSessionTranscriptHealth({
      shouldRepair: true,
      sessionDirs: [path.dirname(filePath)],
    });

    await expect(fs.access(filePath)).rejects.toThrow();
    expect(
      loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "session-1",
      }).map((entry) => entry.event),
    ).toHaveLength(3);
  });
});
