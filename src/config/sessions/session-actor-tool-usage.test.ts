import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import {
  readSqliteDatabasePendingScopedWriteToken,
  readSqliteDatabaseScopedWriteToken,
} from "../../infra/sqlite-database-admission.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import type { SessionActorAppend, SessionActorHotState } from "./session-actor-contract.js";
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";
import {
  readAgentToolUsageInDatabase,
  readAgentToolUsageLiveRunsInDatabase,
  resetAgentToolUsageInDatabase,
} from "./tool-usage.kernel.js";

const now = Date.UTC(2026, 9, 1);
const runId = "co-committed-run";
const row = { toolId: "openclaw:core:read", score: 1, updatedAt: now };
const begin = { kind: "begin", runId, now } as const;
const flush = (generation: number) => ({
  kind: "flush" as const,
  runId,
  generation,
  rows: [row],
  now,
});

function commandInput(snapshot: SessionActorHotState, commandId: string) {
  return { target: snapshot.target, expected: snapshot.version, commandId, phaseId: "turn" };
}

function expectCommitted(outcome: ReturnType<Fixture["mutate"]>) {
  assert(outcome.kind === "committed", "Expected native commit");
  const append = outcome.receipt.transcript.append;
  assert(append?.value.snapshot.ok, "Expected a committed prepared append");
  return append;
}

function appendCommand(
  f: Fixture,
  kind: SessionActorAppend["kind"],
  toolUsage?: SessionActorAppend["toolUsage"],
): Mutation {
  const timestamp = new Date(now).toISOString();
  const append: SessionActorAppend =
    kind === "metadata"
      ? {
          kind,
          toolUsage,
          header: {
            scope: f.scope,
            event: JSON.stringify({
              type: "session",
              id: f.scope.sessionId,
              version: 3,
              timestamp,
            }),
            options: {},
          },
          input: {
            scope: f.scope,
            event: JSON.stringify({
              type: "custom",
              id: "run-start",
              parentId: null,
              timestamp,
              customType: "tool-usage-test",
              data: { runId },
            }),
            options: { appendIntent: "active-branch" },
          },
        }
      : {
          kind,
          toolUsage,
          input: {
            scope: f.scope,
            cwd: "/synthetic",
            messageJson: JSON.stringify({
              role: "toolResult",
              toolCallId: "read-call",
              toolName: "read",
              content: [{ type: "text", text: "Synthetic result" }],
              isError: false,
              timestamp: now,
            }),
          },
        };
  return {
    type: "session.actor.appendTranscriptEvent",
    input: { ...commandInput(f.read(), kind), append },
  };
}

async function beginRun(f: Fixture) {
  const command = appendCommand(f, "metadata", begin);
  await f.prepare(command);
  const generation = expectCommitted(f.mutate(command)).toolUsageGeneration;
  assert(typeof generation === "number", "Expected the admitted tool usage generation");
  return generation;
}

it("co-commits run admission and usage without extra transactions, grants, or broader write scopes", async () => {
  const costs: Array<Array<{ transactions: number; grants: string[] }>> = [];
  for (const recordUsage of [false, true]) {
    await withActor(async (f) => {
      const siblingScope = ["agent:main:untouched"];
      const siblingToken = readSqliteDatabaseScopedWriteToken(f.database.db, siblingScope);
      assert(siblingToken, "Expected an admitted sibling write scope");
      const measured: (typeof costs)[number] = [];
      let generation = 0;
      for (const kind of ["metadata", "message"] as const) {
        const usage = recordUsage ? (kind === "metadata" ? begin : flush(generation)) : undefined;
        const command = appendCommand(f, kind, usage);
        await f.prepare(command);
        const transactions = f.hooks.transactions;
        const grants: string[] = [];
        let checkedFinal = false;
        f.hooks.admit = (stage, facts) => {
          grants.push(stage);
          if (stage === "commit" && isRecord(facts) && facts.final === true) {
            checkedFinal = true;
            expect(f.database.db.isTransaction).toBe(true);
            expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toHaveLength(
              kind === "metadata" ? 2 : 3,
            );
            expect(readSqliteDatabasePendingScopedWriteToken(f.database.db, siblingScope)).toBe(
              siblingToken,
            );
          }
        };
        let committed: ReturnType<typeof expectCommitted>;
        try {
          committed = expectCommitted(f.mutate(command));
        } finally {
          delete f.hooks.admit;
        }
        expect(checkedFinal).toBe(true);
        measured.push({ transactions: f.hooks.transactions - transactions, grants });
        expect(measured.at(-1)?.transactions).toBe(1);
        expect(readSqliteDatabaseScopedWriteToken(f.database.db, siblingScope)).toBe(siblingToken);
        if (recordUsage) {
          assert(typeof committed.toolUsageGeneration === "number");
          generation = committed.toolUsageGeneration;
          expect(readAgentToolUsageInDatabase(f.database.db, now)).toMatchObject({
            generation,
            liveSince: now,
            rows: kind === "metadata" ? [] : [row],
          });
          expect(readAgentToolUsageLiveRunsInDatabase(f.database.db, now)).toEqual(
            new Set([runId]),
          );
        }
      }
      costs.push(measured);
    });
  }
  expect(costs[1]).toEqual(costs[0]);
});

it("fences a pre-reset usage delta without refusing its transcript append", () =>
  withActor(async (f) => {
    const generation = await beginRun(f);
    const command = appendCommand(f, "message", flush(generation));
    await f.prepare(command);
    const reset = runSqliteImmediateTransactionSync(f.database.db, () =>
      resetAgentToolUsageInDatabase(f.database.db, now + 1),
    );
    expect(reset.generation).toBe(generation + 1);
    expectCommitted(f.mutate(command));
    expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toHaveLength(3);
    expect(readAgentToolUsageInDatabase(f.database.db, now + 1)).toMatchObject({
      generation: reset.generation,
      liveSince: now + 1,
      rows: [],
    });
    expect(readAgentToolUsageLiveRunsInDatabase(f.database.db, now + 1)).toEqual(new Set());
  }));

it.each(["begin", "flush"] as const)(
  "rolls back both transcript and %s usage when final actor authority refuses commit",
  (kind) =>
    withActor(async (f) => {
      const generation = kind === "flush" ? await beginRun(f) : 0;
      const command = appendCommand(
        f,
        kind === "begin" ? "metadata" : "message",
        kind === "begin" ? begin : flush(generation),
      );
      await f.prepare(command);
      const before = {
        transcript: readTranscriptEventRows(f.database, f.scope.sessionId),
        usage: readAgentToolUsageInDatabase(f.database.db, now),
        runs: readAgentToolUsageLiveRunsInDatabase(f.database.db, now),
        actor: f.read(),
      };
      let refusedFinal = false;
      f.hooks.admit = (stage, facts) => {
        if (stage === "commit" && isRecord(facts) && facts.final === true) {
          refusedFinal = true;
          expect(readTranscriptEventRows(f.database, f.scope.sessionId).length).toBeGreaterThan(
            before.transcript.length,
          );
          expect(readAgentToolUsageInDatabase(f.database.db, now)).toMatchObject({
            liveSince: now,
            rows: kind === "begin" ? [] : [row],
          });
          expect(readAgentToolUsageLiveRunsInDatabase(f.database.db, now)).toContain(runId);
          throw new Error("Synthetic final actor authority refusal");
        }
      };
      try {
        expect(f.mutate(command)).toMatchObject({
          kind: "rolled-back",
          error: { message: "Synthetic final actor authority refusal" },
        });
      } finally {
        delete f.hooks.admit;
      }
      expect(refusedFinal).toBe(true);
      expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toEqual(before.transcript);
      expect(readAgentToolUsageInDatabase(f.database.db, now)).toEqual(before.usage);
      expect(readAgentToolUsageLiveRunsInDatabase(f.database.db, now)).toEqual(before.runs);
      const after = f.read();
      // A refused transaction retires the hot generation; rehydrated data stays exact.
      expect(after.version.epoch).not.toBe(before.actor.version.epoch);
      expect(after).toEqual({
        ...before.actor,
        version: after.version,
        writeToken: after.writeToken,
      });
    }),
);
