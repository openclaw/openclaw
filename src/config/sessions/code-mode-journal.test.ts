import { expect, it } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createCodeModeJournalStore } from "./code-mode-journal.js";
import {
  beginCodeModeJournalInDatabase as begin,
  completeCodeModeCallInDatabase as complete,
  finishCodeModeJournalInDatabase as finish,
  readCodeModeJournalInDatabase as read,
  recordCodeModeCallInDatabase as call,
} from "./code-mode-journal.kernel.js";
import {
  CODE_MODE_JOURNAL_LIMITS as limits,
  type CodeModeJournalStart,
} from "./code-mode-journal.types.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { transcriptTurnCommand } from "./session-actor-transcript.test-support.js";
import { withActor } from "./session-actor-worker.test-support.js";

const key = {
  sessionKey: "agent:main:journal",
  sessionId: "journal-window",
  executionId: "original-execution",
};
const start: CodeModeJournalStart = {
  ...key,
  version: 1,
  runId: "original-run",
  toolCallId: "outer-tool",
  source: { version: 1, sourceJson: '{"requesterProfileId":"participant-not-owner"}' },
  programJson: '{"source":"return await tools.read();","seed":7,"time":123}',
};
const intent = {
  key: "call-0",
  operationId: "original-operation",
  name: "synthetic.read",
  argsJson: '{ "a": 1 }',
  recovery: "interrupt" as const,
};
const outcome = { resultJson: '{"answer":"saved"}', storeJson: '{"count":1}' };

it("reopens the actual worker journal with exact completed bytes, pending identity and original source", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    writeSessionEntry(database, key.sessionKey, { sessionId: key.sessionId, updatedAt: 1 });
    let current = true;
    const store = createCodeModeJournalStore({
      ...key,
      storePath: database.path,
      env,
      assertCurrent: () => {
        if (!current) {
          throw new Error("requester revoked");
        }
      },
    });
    await store.begin(start);
    await store.call(key.executionId, intent);
    await store.call(key.executionId, { ...intent, key: "call-1", operationId: "op-1" });
    const saved = '{ "value": [1,2], "text": "é" }';
    await store.completeCall(key.executionId, { key: "call-0", resultJson: saved, issuedCalls: 2 });
    await closeOpenClawAgentDatabaseByPathAsync(database.path, "main");
    const recovered = await store.read(key.executionId);
    expect(recovered).toMatchObject({
      ...start,
      calls: [
        { ...intent, state: "completed", resultJson: saved, deliveryIndex: 0, issuedCalls: 2 },
        { key: "call-1", operationId: "op-1", state: "pending" },
      ],
    });
    expect((await store.call(key.executionId, intent)).calls[0]).toEqual(recovered?.calls[0]);
    await expect(store.call(key.executionId, { ...intent, argsJson: "{}" })).rejects.toThrow(
      "diverged",
    );
    await store.finish(key.executionId, outcome);
    expect((await store.read(key.executionId))?.outcome).toEqual(outcome);
    current = false;
    await expect(store.read(key.executionId)).rejects.toThrow("requester revoked");
  });
});

it("keeps result delivery order, rejects changed results and bounds calls without overwriting", async () => {
  await withActor((f) => {
    const selected = { ...start, sessionKey: f.scope.sessionKey, sessionId: f.scope.sessionId };
    const db = f.database.db;
    const tx = <T>(run: () => T) => runSqliteImmediateTransactionSync(db, run);
    tx(() => begin(db, selected));
    tx(() => call(db, selected, intent));
    tx(() => call(db, selected, { ...intent, key: "call-1", operationId: "op-1" }));
    tx(() => complete(db, { ...selected, key: "call-1", resultJson: "null", issuedCalls: 2 }));
    tx(() =>
      complete(db, { ...selected, key: "call-0", resultJson: '{"first":true}', issuedCalls: 2 }),
    );
    expect(
      read(db, selected)?.calls.map((c) => c.state === "completed" && c.deliveryIndex),
    ).toEqual([1, 0]);
    expect(() =>
      tx(() => complete(db, { ...selected, key: "call-0", resultJson: "{}", issuedCalls: 2 })),
    ).toThrow("different durable result");
    expect(() => tx(() => begin(db, { ...selected, programJson: "{}" }))).toThrow(
      "different inputs",
    );
    tx(() => {
      for (let i = 2; i < limits.callsPerExecution; i++) {
        call(db, selected, { ...intent, key: "call-" + i, operationId: "op-" + i });
      }
    });
    expect(() =>
      tx(() => call(db, selected, { ...intent, key: "overflow", operationId: "overflow" })),
    ).toThrow("call limit");
    expect(read(db, selected)?.calls).toHaveLength(limits.callsPerExecution);
  });
});

it.each(["exec", "wait"])(
  "preserves terminal outcome across refused %s commit and retires only with its final tool result",
  async (toolName) => {
    await withActor((f) => {
      const selected = { ...start, sessionKey: f.scope.sessionKey, sessionId: f.scope.sessionId };
      const db = f.database.db;
      runSqliteImmediateTransactionSync(db, () => {
        begin(db, selected);
        finish(db, selected, {
          resultJson: JSON.stringify({
            content: [{ type: "text", text: "saved" }],
            details: { durableExecutionId: selected.executionId },
          }),
          storeJson: "{}",
        });
      });
      const message = {
        role: "toolResult",
        toolCallId: toolName === "wait" ? "wait-result" : selected.toolCallId,
        toolName,
        content: [{ type: "text", text: "saved" }],
        details: { durableExecutionId: selected.executionId },
        isError: false,
        timestamp: 123,
      };
      const command = {
        type: "session.actor.appendToolResult" as const,
        input: {
          ...transcriptTurnCommand(f.scope, "final-result", [{ message }]),
          target: f.target,
        },
      };
      f.hooks.withCommit = () => {
        throw new Error("commit refused");
      };
      expect(f.mutate(command)).toMatchObject({ kind: "rolled-back" });
      expect(read(db, selected)?.outcome?.resultJson).toContain("saved");
      f.hooks.withCommit = undefined;
      expect(f.mutate(command)).toMatchObject({ kind: "committed" });
      expect(read(db, selected)).toBeUndefined();
      const events = readTranscriptEventRows(f.database, selected.sessionId);
      expect(
        events
          .map(({ eventJson }) => JSON.parse(eventJson))
          .filter((event) => event.type === "message")
          .map((event) => event.message),
      ).toEqual([message]);
    });
  },
);

it("refuses malformed, incompatible and oversized records and keeps session limits after finish", async () => {
  await withActor((f) => {
    const selected = { ...start, sessionKey: f.scope.sessionKey, sessionId: f.scope.sessionId };
    const db = f.database.db;
    const tx = <T>(run: () => T) => runSqliteImmediateTransactionSync(db, run);
    tx(() => begin(db, selected));
    expect(read(db, { ...selected, sessionId: "other-window" })).toBeUndefined();
    expect(() => tx(() => call(db, selected, { ...intent, argsJson: "not json" }))).toThrow(
      "Invalid",
    );
    expect(() =>
      tx(() =>
        call(db, selected, {
          ...intent,
          argsJson: JSON.stringify("x".repeat(limits.jsonValueBytes)),
        }),
      ),
    ).toThrow("Invalid");
    tx(() => finish(db, selected, outcome));
    expect(() => tx(() => finish(db, selected, { ...outcome, resultJson: "{}" }))).toThrow(
      "different outcome",
    );
    tx(() => {
      for (let i = 1; i < limits.executionsPerSession; i++) {
        begin(db, { ...selected, executionId: "exec-" + i, toolCallId: "tool-" + i });
      }
    });
    expect(() =>
      tx(() => begin(db, { ...selected, executionId: "overflow", toolCallId: "overflow" })),
    ).toThrow("active journal limit");
    db.prepare("UPDATE session_code_mode_journal SET version = 2 WHERE execution_id = ?").run(
      selected.executionId,
    );
    expect(() => read(db, selected)).toThrow("Unsupported");
    db.prepare(
      "UPDATE session_code_mode_journal SET version = 1, record_json = ? WHERE execution_id = ?",
    ).run('{"version":2}', selected.executionId);
    expect(() => read(db, selected)).toThrow("Unsupported or invalid");
  });
});
