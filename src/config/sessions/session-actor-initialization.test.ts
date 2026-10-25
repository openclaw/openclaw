import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";
import { promptReport } from "./system-prompt-report.test-support.js";

// mock-isolation: The fixture owns maintenance and retention for its database.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns retention for its database.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

function initialization(
  f: Fixture,
): Extract<Mutation, { type: "session.actor.appendTranscriptEvent" }> {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    type: "session.actor.appendTranscriptEvent",
    input: {
      target: f.target,
      commandId: "initialize",
      phaseId: "turn",
      append: {
        kind: "metadata",
        header: {
          scope: f.scope,
          event: JSON.stringify({ type: "session", id: f.scope.sessionId, version: 3, timestamp }),
          options: {},
        },
        input: {
          scope: f.scope,
          initialModel: {
            type: "model_change",
            id: "model",
            parentId: null,
            timestamp,
            provider: "synthetic",
            modelId: "synthetic-model",
          },
          event: JSON.stringify({
            type: "thinking_level_change",
            id: "thinking",
            parentId: "model",
            timestamp,
            thinkingLevel: "high",
          }),
          options: { appendIntent: "active-branch" },
        },
      },
    },
  };
}

it("publishes initialization once and rolls back a later refused append without a watermark", async () => {
  await withActor(async (f) => {
    const command = initialization(f);
    await f.prepare(command);
    const reader = new DatabaseSync(f.database.path, { readOnly: true });
    const watermark = () =>
      reader
        .prepare("SELECT transcript_updated_at FROM session_windows WHERE session_id = ?")
        .get(f.scope.sessionId);
    const previousWatermark = watermark();
    let observations = 0;
    f.hooks.admit = (stage) => {
      if (stage === "commit") {
        observations += 1;
        expect(watermark()).toEqual(previousWatermark);
      }
    };
    const sql = trackSqliteStatementExecutions(f.database.db, ["window"], (query) =>
      /^update "session_windows"/i.test(query) && query.includes('"transcript_updated_at" =')
        ? "window"
        : null,
    );
    try {
      const result = f.mutate(command);
      delete f.hooks.admit;
      assert(result.kind === "committed");
      expect(sql.counts.window).toBe(1);
      expect(observations).toBeGreaterThan(0);
      const append = result.receipt.transcript.append;
      assert(append?.kind === "metadata" && append.value.snapshot.ok);
      assert(append.header?.snapshot.ok);
      expect(append.header.snapshot.value.after.rawSeq).toBe(0);
      expect(append.value.snapshot.value.before).toEqual(append.header.snapshot.value.after);
      expect(append.header.snapshot.value.after.updatedAt).toBeLessThan(
        result.receipt.transcript.after.updatedAt!,
      );
      expect(append.value.snapshot.value.after).toEqual(result.receipt.transcript.after);
      expect(watermark()).toEqual({
        transcript_updated_at: result.receipt.transcript.after.updatedAt,
      });
      expect(result.receipt.postimage.transcript.watermark.maxSeq).toBe(2);
      const rows = readTranscriptEventRows(f.database, f.scope.sessionId);
      expect(rows.map(({ eventJson }) => JSON.parse(eventJson).id)).toEqual([
        f.scope.sessionId,
        "model",
        "thinking",
      ]);
      const before = f.read();
      assert(command.input.append?.kind === "metadata" && command.input.append.input.initialModel);
      command.input.commandId = "refused-initialization";
      delete command.input.append.header;
      command.input.append.input.initialModel.id = "refused-model";
      const refused = f.mutate(command);
      expect(refused.kind).toBe("rolled-back");
      expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toEqual(rows);
      expect(f.read().transcript).toEqual(before.transcript);
      expect(sql.counts.window).toBe(1);
      f.restartActor();
      await f.reopenDatabase();
      expect(f.read().transcript).toEqual(before.transcript);
    } finally {
      delete f.hooks.admit;
      reader.close();
      sql.restore();
    }
  });
});

it("prepares rebased actor message bytes only after choosing their final parent", async () => {
  await withActor(async (f) => {
    const content = "Synthetic answer ".repeat(300);
    const command = initialization(f);
    await f.prepare(command);
    expect(f.mutate(command).kind).toBe("committed");
    const sql = trackSqliteStatementExecutions(f.database.db, ["metadata"], (query) =>
      query.includes('as "navigation_json"') && query.includes('with "source"') ? "metadata" : null,
    );
    try {
      const outcome = f.mutate({
        type: "session.actor.appendTranscriptEvent",
        input: {
          target: f.target,
          commandId: "rebased-message",
          phaseId: "turn",
          append: {
            kind: "metadata",
            input: {
              scope: f.scope,
              event: {
                type: "message",
                id: "answer",
                parentId: null,
                timestamp: "2026-01-01T00:00:01.000Z",
              },
              message: {
                messageJson: JSON.stringify({ role: "assistant", content }),
                cwd: "/synthetic",
                validateTurn: false,
              },
              options: { appendIntent: "active-branch" },
            },
          },
        },
      });
      assert(outcome.kind === "committed");
      expect(
        JSON.parse(readTranscriptEventRows(f.database, f.scope.sessionId).at(-1)!.eventJson),
      ).toMatchObject({ id: "answer", parentId: "thinking", message: { content } });
      expect(sql.counts.metadata).toBe(1);
    } finally {
      sql.restore();
    }
  });
});

it("preserves decoded lookup sibling snapshots when initializing a missing exact actor", async () => {
  await withActor(async (f) => {
    const scope = {
      ...f.scope,
      sessionKey: "agent:main:matrix:group:!Room:example.org",
      sessionId: "new-room",
    };
    const siblingKey = "agent:main:matrix:group:!room:example.org";
    const sibling = f.writeEntry(
      {
        sessionId: "sibling-room",
        updatedAt: 1,
        skillsSnapshot: { prompt: "sibling instructions", skills: [] },
        systemPromptReport: promptReport(1, 100, 80),
        sessionDiffBaseline: {
          version: 1,
          sessionId: "sibling-room",
          root: "/synthetic",
          files: [{ path: "README.md", fingerprint: "sibling" }],
        },
      },
      siblingKey,
    );
    const target = { ...f.target, sessionKey: scope.sessionKey };
    expect(f.read(target).entry).toBeUndefined();
    const command: Mutation = {
      type: "session.actor.appendTranscriptEvent",
      input: {
        target,
        commandId: "initialize-with-sibling",
        phaseId: "turn",
        append: {
          kind: "message",
          input: {
            scope,
            cwd: "/synthetic",
            messageJson: JSON.stringify({ role: "user", content: "first input", timestamp: 2 }),
          },
          initialization: { scope, entry: { sessionId: scope.sessionId, updatedAt: 2 } },
        },
      },
    };
    await f.prepare(command);
    const result = f.mutate(command);
    assert(result.kind === "committed");
    const identity = result.receipt.transcript.append?.initialEntry?.identity;
    expect(identity?.previous.get(siblingKey)).toEqual(sibling);
    expect(identity?.current.get(siblingKey)).toEqual(sibling);
    expect(identity?.current.get(scope.sessionKey)).toMatchObject({ sessionId: scope.sessionId });
    f.restartActor();
    await f.reopenDatabase();
    expect(f.read({ ...target, sessionKey: siblingKey }).entry).toEqual(sibling);
    expect(f.read(target).entry?.sessionId).toBe(scope.sessionId);
  });
});
