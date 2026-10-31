import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readTranscriptStorageRows } from "../config/sessions/session-accessor.sqlite-read.js";
import { replaceTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as agentDatabase from "../state/openclaw-agent-db.js";
import { observeMainThreadReads } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

import { noteSessionTranscriptHeaderHealth } from "./doctor-session-transcript-headers.js";

const AGENT_ID = "main";
const SESSION_ID = "headerless-session";
const SESSION_KEY = "agent:main:headerless-session";
const SPAWNED_CWD = "/workspace/headerless-child";

function message(content = "hello", id = "user-1", parentId: string | null = null) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-07-15T21:23:03.698Z",
    message: { role: "user", content },
  };
}

describe("doctor SQLite session transcript header repair", () => {
  let state: OpenClawTestState;
  let cfg: OpenClawConfig;
  let transcriptDatabaseOptions: agentDatabase.OpenClawAgentDatabaseOptions;
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };
  const database = () => agentDatabase.openOpenClawAgentDatabase(transcriptDatabaseOptions);
  const rows = () => readTranscriptStorageRows(database(), SESSION_ID);
  const health = (shouldRepair = true) =>
    noteSessionTranscriptHeaderHealth({ cfg, env: state.env, shouldRepair });
  const expectNote = (text: unknown) =>
    expect(note).toHaveBeenCalledWith(text, "Session transcript headers");

  beforeEach(async () => {
    note.mockClear();
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-doctor-transcript-headers-",
    });
    cfg = {
      agents: { entries: { [AGENT_ID]: { workspace: state.workspaceDir } } },
    };
    transcriptDatabaseOptions = { agentId: AGENT_ID, env: state.env };
    scope = {
      agentId: AGENT_ID,
      env: state.env,
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      storePath: path.join(state.sessionsDir(AGENT_ID), "sessions.json"),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await state.cleanup();
  });

  async function seedTranscript(
    events: readonly unknown[] = [message()],
    options: { spawnedCwd?: string } = { spawnedCwd: SPAWNED_CWD },
  ) {
    const entry = await upsertSessionEntryCore(scope, {
      sessionId: SESSION_ID,
      ...(options.spawnedCwd ? { spawnedCwd: options.spawnedCwd } : {}),
      updatedAt: 10,
    });
    if (!entry) {
      throw new Error("Failed to seed session entry");
    }
    expect(replaceTranscriptEventsSync(scope, [...events])).toBe(true);
    return entry;
  }

  it("repairs headerless history with legacy projection and unchanged event bytes", async () => {
    const userText =
      "Please quote <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> literally.\r\n  Keep spacing.";
    await seedTranscript([
      {
        type: "model_change",
        id: "model-1",
        parentId: null,
        timestamp: "2026-07-15T21:23:03.632Z",
        provider: "github-copilot",
        modelId: "claude-opus-4.8",
      },
      message(userText, "user-1", "model-1"),
      {
        type: "leaf",
        id: "leaf-1",
        parentId: "user-1",
        targetId: "user-1",
        timestamp: "2026-07-15T21:23:03.699Z",
      },
    ]);
    const db = database();
    const beforeRows = rows();
    const originalStorage = db.db.prepare("SELECT * FROM transcript_events ORDER BY seq").all();
    const recoveryDirectories = () =>
      fs
        .readdirSync(path.dirname(db.path))
        .filter((name) => name.startsWith("openclaw-transcript-headers-recovery-"));
    agentDatabase.runOpenClawAgentWriteTransaction((transactionDatabase) => {
      transactionDatabase.db
        .prepare(
          "UPDATE session_windows SET transcript_updated_at = ?, transcript_observed_at = ? WHERE session_id = ?",
        )
        .run(1_000_000, 999_000, SESSION_ID);
    }, transcriptDatabaseOptions);

    expect(() => SessionManager.open(scope, state.workspaceDir)).toThrow(
      "require doctor/import migration before runtime use",
    );

    await expect(health(false)).resolves.toEqual({ found: 1, repaired: 0 });
    expect(rows()).toEqual(beforeRows);
    expect(recoveryDirectories()).toEqual([]);
    expectNote(
      '- Found 1 stored session transcript without a header.\n- Run "openclaw doctor --fix" to repair it before resuming the session.',
    );

    note.mockClear();
    await expect(health()).resolves.toEqual({ found: 1, repaired: 1 });
    const backups = recoveryDirectories();
    expect(backups).toHaveLength(1);
    {
      using backup = openNodeSqliteDatabase(
        path.join(path.dirname(db.path), backups[0]!, "database.sqlite"),
        { readOnly: true },
      );
      expect(backup.prepare("SELECT * FROM transcript_events ORDER BY seq").all()).toEqual(
        originalStorage,
      );
    }

    const repairedRows = rows();
    const repairedEvents = repairedRows.map((row) => JSON.parse(row.eventJson));
    expect(repairedEvents[0]).toMatchObject({
      type: "session",
      version: 3,
      id: SESSION_ID,
      cwd: SPAWNED_CWD,
      timestamp: new Date(beforeRows[0]?.createdAt ?? 0).toISOString(),
    });
    // Exact event JSON below also preserves ids, parents, and the leaf target.
    expect(repairedRows.slice(1).map((row) => row.createdAt)).toEqual(
      beforeRows.map((row) => row.createdAt),
    );
    expect(repairedRows.slice(1).map((row) => row.eventJson)).toEqual(
      beforeRows.map((row) => row.eventJson),
    );
    expect(repairedRows.map((row) => row.seq)).toEqual([0, 1, 2, 3]);

    const identities = db.db
      .prepare(
        "SELECT event_id, parent_id, seq FROM transcript_event_identities WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(SESSION_ID);
    expect(identities).toEqual([
      { event_id: SESSION_ID, parent_id: null, seq: 0 },
      { event_id: "model-1", parent_id: null, seq: 1 },
      { event_id: "user-1", parent_id: "model-1", seq: 2 },
      { event_id: "leaf-1", parent_id: "user-1", seq: 3 },
    ]);
    await waitForSessionTranscriptIndexReconcile(transcriptDatabaseOptions);
    expect(
      db.db
        .prepare(
          "SELECT event_seq FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position ASC",
        )
        .all(SESSION_ID),
    ).toEqual([{ event_seq: 1 }, { event_seq: 2 }]);
    expect(
      db.db
        .prepare("SELECT transcript_updated_at AS value FROM session_windows WHERE session_id = ?")
        .get(SESSION_ID),
    ).toEqual({ value: 1_000_001 });
    const repairedManager = SessionManager.open(scope, state.workspaceDir);
    expect(repairedManager.getEntries().map((entry) => entry.id)).toEqual(["model-1", "user-1"]);
    expect(repairedManager.buildSessionContext().messages).toEqual([
      { role: "user", content: userText },
    ]);
    expectNote("- Prepended missing headers to 1 session transcript.");

    note.mockClear();
    const afterFirstRepair = rows();
    const reads: string[] = [];
    const observation = observeMainThreadReads((sql) => reads.push(sql));
    try {
      await expect(health()).resolves.toEqual({ found: 0, repaired: 0 });
      expect(
        reads.filter((sql) => /\b(?:from|join)\s+"?transcript_events\b/iu.test(sql)),
      ).toHaveLength(1);
    } finally {
      observation.restore();
    }
    expect(rows()).toEqual(afterFirstRepair);
    expect(note).not.toHaveBeenCalled();
    expect(recoveryDirectories()).toEqual(backups);
  });

  it("leaves retained history unchanged when its recovery copy cannot be saved", async () => {
    await seedTranscript([message("retained history")]);
    const before = rows();
    const copyFile = fs.copyFileSync;
    vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
      if (String(destination).includes("openclaw-transcript-headers-recovery-")) {
        throw new Error("recovery copy: disk full");
      }
      return copyFile(source, destination, mode);
    });

    await expect(health()).resolves.toEqual({ found: 1, repaired: 0 });
    expect(rows()).toEqual(before);
    expectNote(expect.stringContaining("recovery copy: disk full"));
  });

  it("rejects a row timestamp change between detection and header repair", async () => {
    await seedTranscript();
    const before = rows();
    const transaction = agentDatabase.runOpenClawAgentWriteTransaction;
    vi.spyOn(agentDatabase, "runOpenClawAgentWriteTransaction").mockImplementationOnce(
      (write, options, transactionOptions) => {
        transaction((db) => {
          db.db
            .prepare(
              "UPDATE transcript_events SET created_at = created_at + 1 WHERE session_id = ?",
            )
            .run(SESSION_ID);
        }, transcriptDatabaseOptions);
        return transaction(write, options, transactionOptions);
      },
    );
    await expect(health()).resolves.toEqual({ found: 1, repaired: 0 });
    expect(rows()).toEqual(
      before.map((row) => ({
        seq: row.seq,
        eventJson: row.eventJson,
        createdAt: row.createdAt + 1,
      })),
    );
    expectNote(expect.stringContaining("transcript changed while preparing header repair"));
  });

  it.each([
    {
      name: "a malformed current entry",
      events: [{ ...message(), message: { role: "invalid", content: "not a current message" } }],
    },
    {
      name: "an invalid leaf control",
      events: [message(), { type: "leaf", id: "invalid-leaf", parentId: "user-1" }],
    },
    {
      name: "duplicate event identities",
      events: [message(), message("second", "user-2", "user-1")],
      duplicate: true,
    },
  ])("does not repair $name", async ({ events, duplicate }) => {
    await seedTranscript(events);
    if (duplicate) {
      agentDatabase.runOpenClawAgentWriteTransaction((writer) => {
        writer.db
          .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 1")
          .run(JSON.stringify(message("second", "user-1", "user-1")), SESSION_ID);
      }, transcriptDatabaseOptions);
    }
    const before = rows();
    await expect(health()).resolves.toEqual({ found: 0, repaired: 0 });
    expect(rows()).toEqual(before);
    expect(() => SessionManager.open(scope, state.workspaceDir)).toThrow(
      "require doctor/import migration before runtime use",
    );
    expect(note).not.toHaveBeenCalled();
  });

  it.each(["shared store", "newer session"])("uses workspace for %s", async (kind) => {
    if (kind === "shared store") {
      const storePath = state.path("shared.sqlite");
      transcriptDatabaseOptions = { agentId: "alpha", env: state.env, path: storePath };
      agentDatabase.openOpenClawAgentDatabase(transcriptDatabaseOptions);
      cfg = {
        agents: { entries: { beta: { workspace: state.workspaceDir } } },
        session: { store: storePath },
      };
      scope = { ...scope, agentId: "beta", sessionKey: `agent:beta:${SESSION_ID}`, storePath };
      await seedTranscript([message()], {});
    } else {
      const entry = await seedTranscript();
      agentDatabase.runOpenClawAgentWriteTransaction((writer) => {
        writer.db
          .prepare(
            "UPDATE session_nodes SET current_session_id = ?, entry_json = ? WHERE session_key = ?",
          )
          .run(
            "newer-session",
            JSON.stringify({
              sessionId: "newer-session",
              updatedAt: entry.updatedAt,
              spawnedCwd: "/workspace/newer",
            }),
            SESSION_KEY,
          );
      }, transcriptDatabaseOptions);
    }
    await expect(health()).resolves.toEqual({ found: 1, repaired: 1 });
    expect(JSON.parse(rows()[0]!.eventJson).cwd).toBe(state.workspaceDir);
  });
});
