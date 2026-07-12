// Guardrail: TUI-local `!`/`!!` shell command persistence must attach to the current
// append parent (like other injected transcript messages) and must round-trip
// excludeFromContext so `!!` output never reaches the model while `!` output does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  replaceSessionEntry,
  type TranscriptEvent,
  withTranscriptWriteLock,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendInjectedBashExecutionMessageToTranscript } from "./chat-transcript-inject.js";

type SqliteTranscriptFixture = {
  agentId: string;
  dir: string;
  sessionKey: string;
  sessionId: string;
  storePath: string;
};

async function createSqliteTranscriptFixture(params: {
  prefix: string;
  sessionId: string;
}): Promise<SqliteTranscriptFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), params.prefix));
  const sessionKey = "main";
  const agentId = "main";
  const storePath = path.join(dir, "sessions.json");
  await replaceSessionEntry(
    { agentId, sessionKey, storePath },
    { sessionId: params.sessionId, updatedAt: Date.now() },
  );
  return { agentId, dir, sessionKey, sessionId: params.sessionId, storePath };
}

async function cleanupFixture(fixture: { dir: string }) {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
}

function fixtureScope(fixture: SqliteTranscriptFixture) {
  return {
    agentId: fixture.agentId,
    sessionId: fixture.sessionId,
    sessionKey: fixture.sessionKey,
    storePath: fixture.storePath,
  };
}

async function readLastTranscriptRecord(
  fixture: SqliteTranscriptFixture,
): Promise<Record<string, unknown>> {
  const events = (await loadTranscriptEvents(fixtureScope(fixture))) as Record<string, unknown>[];
  expect(events.length).toBeGreaterThanOrEqual(2);
  return events.at(-1) as Record<string, unknown>;
}

describe("appendInjectedBashExecutionMessageToTranscript", () => {
  it("appends a bashExecution message with parentId, agent-visible by default", async () => {
    const fixture = await createSqliteTranscriptFixture({
      prefix: "openclaw-chat-inject-bash-",
      sessionId: "sess-1",
    });
    try {
      const prior = appendTranscriptMessageSync(fixtureScope(fixture), {
        message: { role: "user", content: [{ type: "text", text: "run something" }] },
      });

      const appended = await appendInjectedBashExecutionMessageToTranscript({
        ...fixtureScope(fixture),
        command: "ls",
        output: "a.txt\nb.txt",
        exitCode: 0,
      });

      expect(appended.ok).toBe(true);
      expect(appended.messageId).toBeTypeOf("string");

      const last = await readLastTranscriptRecord(fixture);
      // Attaches to the current append parent so compaction and chat.history
      // projection keep a connected chain.
      expect(last.parentId).toBe(prior?.messageId);
      const message = last.message as Record<string, unknown>;
      expect(message.role).toBe("bashExecution");
      expect(message.command).toBe("ls");
      expect(message.output).toBe("a.txt\nb.txt");
      expect(message.exitCode).toBe(0);
      // `!` (agent-visible): excludeFromContext must not be set at all.
      expect(Object.hasOwn(message, "excludeFromContext")).toBe(false);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("persists excludeFromContext: true for a `!!` command", async () => {
    const fixture = await createSqliteTranscriptFixture({
      prefix: "openclaw-chat-inject-bash-bangbang-",
      sessionId: "sess-1",
    });
    try {
      const appended = await appendInjectedBashExecutionMessageToTranscript({
        ...fixtureScope(fixture),
        command: "cat secrets.env",
        output: "API_KEY=fake",
        exitCode: 0,
        excludeFromContext: true,
      });

      expect(appended.ok).toBe(true);
      const last = await readLastTranscriptRecord(fixture);
      const message = last.message as Record<string, unknown>;
      expect(message.role).toBe("bashExecution");
      expect(message.excludeFromContext).toBe(true);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("attaches to the run's append parent while a side-branch leaf control is active", async () => {
    // While an agent run is in flight, the newest transcript event can be a
    // side-mode leaf control owning the visible leaf. An injected `!` row must
    // chain onto that control's appendParentId — not sever the run's branch —
    // so the run adopts the row on its next append instead of orphaning it.
    const fixture = await createSqliteTranscriptFixture({
      prefix: "openclaw-chat-inject-bash-midrun-",
      sessionId: "sess-1",
    });
    try {
      const timestamp = new Date().toISOString();
      await withTranscriptWriteLock(fixtureScope(fixture), async (context) => {
        await context.replaceEvents([
          {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp,
            message: { role: "user", content: [{ type: "text", text: "start a run" }] },
          },
          {
            type: "leaf",
            id: "leaf-1",
            parentId: "user-1",
            timestamp,
            targetId: "user-1",
            appendParentId: "user-1",
            appendMode: "side",
          },
        ] satisfies TranscriptEvent[]);
      });

      const appended = await appendInjectedBashExecutionMessageToTranscript({
        ...fixtureScope(fixture),
        command: "git status",
        output: "clean",
        exitCode: 0,
      });

      expect(appended.ok).toBe(true);
      const last = await readLastTranscriptRecord(fixture);
      expect(last.parentId).toBe("user-1");
      expect((last.message as Record<string, unknown>).role).toBe("bashExecution");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("fails cleanly when transcript identity is unresolved", async () => {
    const appended = await appendInjectedBashExecutionMessageToTranscript({
      command: "ls",
      output: "",
    });
    expect(appended.ok).toBe(false);
    expect(appended.error).toBeTypeOf("string");
  });
});
