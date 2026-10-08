import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { enrichAssistantTranscriptMediaForRun } from "../../gateway/server-methods/chat-transcript-persistence.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "./session-message-rewrite.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";

// mock-isolation: Keep unrelated periodic maintenance outside the exact-row writer fixture.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Keep history retention outside the exact-row writer fixture.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

function fixture(agentId = "main", storePath?: string) {
  const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  const scope = {
    agentId,
    storePath: database.path,
    sessionKey: `agent:${agentId}:exact-rewrite`,
    sessionId: "exact-rewrite",
  };
  replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (const [eventId, message] of [
    ["admission", { role: "user", content: "original" }],
    [
      "answer",
      {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        stopReason: "stop",
        __openclaw: { runId: "first-run" },
      },
    ],
    ["later", { role: "user", content: "later" }],
  ] as const) {
    expect(appendTranscriptMessageSync(scope, { eventId, message })).toMatchObject({ ok: true });
  }
  const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admission" });
  if (!anchor) {
    throw new Error("missing fixture anchor");
  }
  return {
    database,
    scope,
    anchor,
    rows: () => readTranscriptEventRows(database, scope.sessionId),
  };
}

it.each([
  ["anchor", "main"],
  ["terminal", "main"],
  ["anchor", "secondary"],
  ["terminal", "secondary"],
] as const)(
  "rewrites the %s for logical %s without caller-thread SQL or changing later rows",
  async (operation, agentId) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = fixture(agentId, agentId === "main" ? undefined : state.statePath("shared.sqlite"));
      const before = f.rows();
      const sql = observeHostDataSql();
      try {
        if (operation === "anchor") {
          await expect(
            rewritePreparedTranscriptMessageAtAnchor(f.anchor, (message) => {
              if (!isRecord(message)) {
                throw new Error("invalid fixture message");
              }
              return { ...message, __openclaw: { steerTargetRunId: "next-run" } };
            }),
          ).resolves.toMatchObject({ message: { __openclaw: { steerTargetRunId: "next-run" } } });
        } else {
          await expect(
            enrichAssistantTranscriptMediaForRun({
              scope: f.scope,
              runId: "first-run",
              expectedLifecycleRevision: null,
              content: [{ type: "text", text: "display answer" }],
              mediaUrls: [],
            }),
          ).resolves.toEqual({ messageId: "answer" });
        }
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      const after = f.rows();
      expect(after.at(-1)).toEqual(before.at(-1));
      expect(after).not.toEqual(before);
    });
  },
);

it.each(["payload", "lifecycle"] as const)(
  "refuses a stale %s after preparation with the original error class",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const source = f.rows().find((row) => JSON.parse(row.eventJson).id === "admission")!;
      await expect(
        rewritePreparedTranscriptMessageAtAnchor(
          f.anchor,
          (message) => {
            if (!isRecord(message)) {
              throw new Error("invalid fixture message");
            }
            if (change === "lifecycle") {
              replaceSessionEntrySync(f.scope, {
                sessionId: f.scope.sessionId,
                updatedAt: 2,
                lifecycleRevision: "successor",
              });
            } else {
              runOpenClawAgentWriteTransaction(
                (database) => {
                  rewriteSqliteTranscriptEventRowsInTransaction(
                    database,
                    resolveSqliteTranscriptScope(f.scope),
                    [
                      {
                        seq: source.seq,
                        expectedEventJson: source.eventJson,
                        event: {
                          ...JSON.parse(source.eventJson),
                          message: { ...message, content: "successor" },
                        },
                      },
                    ],
                  );
                },
                { agentId: "main", path: f.database.path },
              );
            }
            return { ...message, content: "stale replacement" };
          },
          { expectedEntry: { lifecycleRevision: null } },
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      const current = f.rows().find((row) => row.seq === source.seq)!;
      expect(JSON.parse(current.eventJson).message.content).toBe(
        change === "payload" ? "successor" : "original",
      );
    });
  },
);

it("preserves an inherited lifecycle fence when enriching a completion", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    replaceSessionEntrySync(f.scope, {
      sessionId: f.scope.sessionId,
      updatedAt: 2,
      activeWriterRunId: "first-run",
    });
    const before = f.rows();
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: {
          ...f.scope,
          expectedWriterRunId: "first-run",
          expectedLifecycleRevision: "previous-lifecycle",
        },
        withTranscriptWrite: async (run) => await run(),
      },
      async () => {
        await expect(
          enrichAssistantTranscriptMediaForRun({
            scope: f.scope,
            runId: "first-run",
            expectedLifecycleRevision: null,
            content: [{ type: "text", text: "stale display" }],
            mediaUrls: [],
          }),
        ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
      },
    );
    expect(f.rows()).toEqual(before);
  });
});
