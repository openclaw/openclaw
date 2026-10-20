import { assert, expect, it as baseIt, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareSessionCostUsageRefreshLock } from "../../infra/session-cost-usage-cache.sqlite.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import * as participantCache from "./session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  participantRecordsBySessionKey,
  projectSqliteSessionParticipants,
} from "./session-accessor.sqlite-participant-projection.js";
import { recordSessionParticipantFromWorker } from "./session-accessor.sqlite-participants.native.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  createSessionActorReplica,
  readSessionActorProjectionReceipt,
} from "./session-actor-replica.js";
import {
  participantRecord,
  withActor,
  type Fixture,
  type Mutation,
} from "./session-actor-worker.test-support.js";
import type { SessionEntryPatchGuard } from "./session-entry-patch.types.js";
import { readSessionEntryPatchSnapshot } from "./session-entry-patch.worker.js";
import { readSessionTranscriptAccountingFromProjection } from "./session-transcript-accounting.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { withSessionTranscriptProjectionReceipt } from "./session-transcript-projection-facts-scope.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";

// mock-isolation: Actor ownership proof must not schedule unrelated background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns its database lifetime without background history eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const it = baseIt.extend<{ actor: Fixture }>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest requires destructured fixture dependencies; this fixture has none.
  actor: async ({}, use) => withActor(use),
});
const transaction = <T>(f: Fixture, run: () => T) =>
  runSqliteImmediateTransactionSync(f.database.db, run);
const participantInput = (id = "peer", promptedAt = 10) => ({
  identity: { type: "agent" as const, id },
  promptedAt,
});
const recordParticipant = (f: Fixture, id = "peer", at = 10) =>
  recordSessionParticipantFromWorker(f.database, f.scope, participantInput(id, at));
const participants = (f: Fixture) =>
  participantRecordsBySessionKey(f.database.db, [f.target.sessionKey]).get(f.target.sessionKey);
function refuse(f: Fixture, message: string, refused = "commit") {
  f.hooks.admit = (stage) => {
    if (stage === refused) {
      throw new Error(message);
    }
  };
}
function counts<Key extends string>(
  f: Fixture,
  keys: readonly Key[],
  classify: (sql: string) => Key | null,
) {
  const tracked = trackSqliteStatementExecutions(f.database.db, keys, classify);
  return { ...tracked, [Symbol.dispose]: tracked.restore };
}
const entrySelection = (f: Fixture, exact = true, sessionKey = f.target.sessionKey) =>
  ({ kind: "entry", sessionKey, exact }) as const;
const entrySnapshot = (f: Fixture) => readSessionEntryPatchSnapshot(f.database, entrySelection(f));
const messageEvent = (id: string, parentId: string | null, content: string, role = "user") => ({
  type: "message" as const,
  id,
  parentId,
  message: { role, content },
});
const headerEvent = (f: Fixture) => ({
  type: "session",
  id: f.scope.sessionId,
  version: 3,
  cwd: "/synthetic",
});
const steer = <T extends { message: object }>(event: T, steerTargetRunId: string) => ({
  ...event,
  message: { ...event.message, __openclaw: { steerTargetRunId } },
});
const rewrite = (
  f: Fixture,
  seq: number,
  expectedEventJson: string,
  event: Parameters<typeof rewriteSqliteTranscriptEventRowsInTransaction>[2][number]["event"],
) =>
  rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
    { seq, expectedEventJson, event },
  ]);
async function commit(f: Fixture, command: Mutation) {
  await f.prepare(command);
  const result = f.mutate(command);
  assert(result.kind === "committed");
  return result;
}

function activityCommand(
  f: Fixture,
  commandId: string,
  updatedAt: number,
): Extract<Mutation, { type: "session.actor.patch" }> {
  const current = f.read();
  return {
    type: "session.actor.patch",
    input: {
      target: current.target,
      expected: current.version,
      commandId,
      phaseId: "terminal-accounting",
      reducers: [{ kind: "activity", updatedAt }],
    },
  };
}

it("persists adoption once, skips unchanged hydration, and repairs stale columns", async ({
  actor: f,
}) => {
  const initial = f.read();
  const command: Mutation = {
    type: "session.actor.adoptRun",
    input: {
      target: f.target,
      expected: initial.version,
      commandId: "adopt-with-activity",
      phaseId: "adoption",
      sessionId: f.scope.sessionId,
      expectedState: buildRestartRecoveryExpectedState(initial.entry!),
      runId: "current-run",
      lifecycle: { startedAt: 2 },
      reducers: [{ kind: "activity", updatedAt: 20 }],
    },
  };
  await f.prepare(command);
  using writes = counts(f, ["nodes", "windows"], (sql) => {
    const table = /^(?:insert into|update|delete from) "([^"]+)"/iu.exec(sql)?.[1];
    return table === "session_nodes" ? "nodes" : table === "session_windows" ? "windows" : null;
  });
  expect(f.mutate(command)).toMatchObject({
    kind: "committed",
    receipt: {
      postimage: { entry: { activeWriterRunId: "current-run", startedAt: 2, updatedAt: 20 } },
    },
  });
  expect(writes.counts).toEqual({ nodes: 1, windows: 1 });
  for (const repair of [false, true]) {
    if (repair) {
      transaction(f, () =>
        f.database.db
          .prepare("UPDATE session_nodes SET label = ? WHERE session_key = ?")
          .run("stale-derived-label", f.target.sessionKey),
      );
    }
    f.restartActor();
    const hydrated = f.read();
    expect(hydrated.entry).toMatchObject({
      activeWriterRunId: "current-run",
      startedAt: 2,
      updatedAt: 20,
      label: "initial",
    });
    Object.assign(writes.counts, { nodes: 0, windows: 0 });
    expect(
      f.mutate({
        ...command,
        input: {
          ...command.input,
          expected: hydrated.version,
          commandId: repair ? "repair-hydrated-column" : "unchanged-after-hydration",
          expectedState: buildRestartRecoveryExpectedState(hydrated.entry!),
          // Clearing an absent optional field changes the in-memory shape, not the stored row.
          lifecycle: { endedAt: undefined },
          reducers: [],
        },
      }),
    ).toMatchObject({ kind: "committed" });
    expect(writes.counts).toEqual({ nodes: Number(repair), windows: 0 });
    expect(f.nativeEntry()).toEqual(hydrated.entry);
    expect(
      f.database.db
        .prepare("SELECT label FROM session_nodes WHERE session_key = ?")
        .get(f.target.sessionKey),
    ).toMatchObject({ label: "initial" });
  }
});

it("reads participant counts and ordering across turns without SQL", ({ actor: f }) => {
  f.read();
  using reads = counts(f, ["participant", "hydration"], (sql) => {
    if (sql.includes('as "actor_participants"')) {
      return "hydration";
    }
    return /^select\b/iu.test(sql) && sql.includes('"session_participants"') ? "participant" : null;
  });
  transaction(f, () => {
    expect(recordParticipant(f, "second", 20).value).toBe("inserted");
    expect(participants(f)).toMatchObject([participantRecord("second", 1, 20)]);
    expect(recordParticipant(f, "first", 10).value).toBe("inserted");
    expect(recordParticipant(f, "second", 5).value).toBe("updated");
    expect(participants(f)?.map((participant) => participant.identity.id)).toEqual([
      "second",
      "first",
    ]);
  });
  expect(f.read().participants).toEqual(participants(f));
  expect(participants(f)).toMatchObject([
    participantRecord("second", 2, 5, 20),
    participantRecord("first", 1, 10),
  ]);
  transaction(f, () => recordParticipant(f, "second", 30));
  const next = f.read();
  expect(next.participants[0]).toMatchObject({ contributionCount: 3, lastPromptedAt: 30 });
  expect(
    projectSqliteSessionParticipants(f.database.db, f.target.sessionKey, next.entry!),
  ).toMatchObject({
    participantCount: 2,
    participants: [{ identity: { id: "second" } }, { identity: { id: "first" } }],
  });
  expect(reads.counts).toEqual({ participant: 0, hydration: 0 });
});

it("autocommits consecutive resident contributions", ({ actor: f }) => {
  f.read();
  const input = participantInput();
  f.participant(input);
  {
    using sql = counts(f, ["contribution", "read"], (text) =>
      /^insert into "session_participants"/iu.test(text)
        ? "contribution"
        : /^select\b/iu.test(text)
          ? "read"
          : null,
    );
    using exec = vi.spyOn(f.database.db, "exec");
    f.participant({ ...input, promptedAt: 20 });
    f.participant({ ...input, promptedAt: 30 });
    expect(f.read().participants).toMatchObject([participantRecord("peer", 3, 10, 30)]);
    expect(sql.counts).toEqual({ contribution: 2, read: 0 });
    expect(exec.mock.calls.some(([text]) => /BEGIN|COMMIT/iu.test(text))).toBe(false);
  }
  f.restartActor();
  expect(f.read().participants).toMatchObject([{ contributionCount: 3, lastPromptedAt: 30 }]);
});

it("refuses contributions before writing and survives publication failure", ({ actor: f }) => {
  f.read();
  const input = participantInput();
  f.participant(input);
  for (const refused of ["transaction", "commit"] as const) {
    refuse(f, "participant admission refused", refused);
    expect(() => f.participant(input)).toThrow("participant admission refused");
  }
  f.hooks.admit = undefined;
  expect(f.read().participants).toMatchObject([{ contributionCount: 1 }]);
  {
    using publish = vi.spyOn(participantCache, "publishSessionEntryCacheParticipantUpdate");
    publish.mockImplementation(() => {
      throw new Error("participant publication failed");
    });
    expect(f.participant({ ...input, promptedAt: 20 })).toMatchObject({ value: "updated" });
    expect(f.read().participants).toMatchObject([{ contributionCount: 2, lastPromptedAt: 20 }]);
  }
  f.restartActor();
  expect(f.read().participants).toMatchObject([{ contributionCount: 2, lastPromptedAt: 20 }]);
});

it("discards rolled-back participant facts, then retains committed ones", ({ actor: f }) => {
  const before = f.read();
  const record = () => recordParticipant(f);
  expect(() =>
    transaction(f, () => {
      record();
      expect(participants(f)).toMatchObject([{ identity: { id: "peer" }, contributionCount: 1 }]);
      throw new Error("rollback participant");
    }),
  ).toThrow("rollback participant");
  const rolledBack = f.read();
  expect({ participants: rolledBack.participants, entry: rolledBack.entry }).toEqual({
    participants: before.participants,
    entry: before.entry,
  });
  transaction(f, record);
  const committed = [{ identity: { id: "peer" }, contributionCount: 1 }];
  expect(f.read().participants).toMatchObject(committed);
  f.restartActor();
  expect(f.read().participants).toMatchObject(committed);
});

it("keeps residency across usage writes and reloads session changes", async ({ actor: f }) => {
  const initial = f.read();
  const usage = prepareSessionCostUsageRefreshLock(f.database.agentId, f.database.path);
  using reads = counts(f, ["hydration"], (sql) =>
    sql.includes('as "actor_participants"') ? "hydration" : null,
  );
  const unchanged = () => {
    expect(f.read()).toEqual(initial);
    expect(reads.counts.hydration).toBe(0);
  };
  try {
    expect(await usage.acquire()).toBe(true);
    unchanged();
    expect(
      await usage.writeRollup([
        {
          rollupId: "synthetic-rollup",
          valueJson: new TextEncoder().encode("{}"),
          blob: null,
          updatedAt: 2,
        },
      ]),
    ).toBe(true);
    unchanged();
    await usage.pruneRows([{ key: "synthetic-rollup", valueJson: "{}", updatedAt: 2 }]);
    unchanged();
    await usage.release();
    unchanged();

    f.writeEntry({ ...initial.entry!, label: "changed by the session owner" });
    expect(f.read().entry?.label).toBe("changed by the session owner");
    expect(reads.counts.hydration).toBe(1);
  } finally {
    await usage.release();
  }
});

it("keeps entry and transcript owners' writes resident across patches", async ({ actor: f }) => {
  f.database.db
    .prepare(
      "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'main', 'Synthetic board', 0, 'user', 0)",
    )
    .run(f.target.sessionKey);
  transaction(f, () =>
    appendTranscriptEventsInTransaction(f.database, f.scope, [
      { ...headerEvent(f), timestamp: "2026-01-01T00:00:00Z" },
      {
        ...messageEvent("before-patch", null, "retain this input"),
        timestamp: "2026-01-01T00:00:01Z",
      },
    ]),
  );
  f.writeEntry({
    ...f.nativeEntry()!,
    activitySummary: {
      version: 1,
      text: "Retained input",
      updatedAt: 10,
      sessionId: f.scope.sessionId,
      generation: null,
      maxSeq: null,
      leafEntryId: null,
      coveredMessages: 1,
      totalMessages: 1,
      omittedContent: false,
    },
  });
  const before = f.read();
  const predicate: SessionEntryPatchGuard["shouldCommitIf"] = {
    kind: "transcript",
    sessionId: f.scope.sessionId,
    generation: before.transcript.watermark.generation,
    leafEntryId: "before-patch",
  };
  const entryPatch = (
    fields: { label?: string; lifecycleRevision?: string; model?: string },
    shouldCommitIf = predicate,
  ) =>
    f.patchEntry({
      selection: entrySelection(f),
      sessionKey: f.target.sessionKey,
      operation: { kind: "fields", patch: fields },
      operationLabel: "session-entry.patch",
      validateCanonicalKeys: false,
      preserveActivity: true,
      shouldCommitIf,
    });
  {
    using reads = counts(f, ["select", "watermark"], (sql) =>
      sql.startsWith("select coalesce(") &&
      sql.includes('as "max_seq"') &&
      sql.includes('"session_transcript_cold_archives"')
        ? "watermark"
        : /^select\b/iu.test(sql)
          ? "select"
          : null,
    );
    entryPatch({ label: "entry owner committed", model: "updated-model" });
    expect(reads.counts).toEqual({ watermark: 0, select: 0 });
    transaction(f, () => recordParticipant(f));
    reads.counts.select = 0;
    const after = f.read();
    expect(after).toMatchObject({
      entry: { label: "entry owner committed", model: "updated-model" },
      hasBoard: true,
      participants: [{ identity: { id: "peer" }, contributionCount: 1 }],
    });
    expect({ transcript: after.transcript, version: after.version }).toEqual({
      transcript: before.transcript,
      version: { ...before.version, sequence: before.version.sequence + 2 },
    });
    const accounting = activityCommand(f, "activity-20", 20);
    expect((await commit(f, accounting)).receipt.postimage.entry).toMatchObject({
      updatedAt: 20,
      label: "entry owner committed",
    });
    const append: Mutation = {
      type: "session.actor.appendTranscriptEvent",
      input: {
        target: f.target,
        expected: f.read().version,
        commandId: "append-after-entry-patch",
        phaseId: "model",
        sessionId: f.scope.sessionId,
        lifecycleRevision: after.entry!.lifecycleRevision ?? null,
        eventJson: JSON.stringify({
          type: "model_change",
          id: "after-patch",
          parentId: "before-patch",
          timestamp: "2026-01-01T00:00:02Z",
          provider: "synthetic",
          modelId: "test-model",
        }),
      },
    };
    await commit(f, append);
    expect(entrySnapshot(f)[0]?.row?.transcriptWatermark).toEqual({
      sessionId: f.scope.sessionId,
      generation: expect.any(String),
      maxSeq: 2,
    });
    expect(reads.counts.select).toBe(0);
    entryPatch({ label: "wrong generation" }, { ...predicate, generation: "superseded" });
    entryPatch({ label: "wrong branch" }, { ...predicate, leafEntryId: "off-path" });
    expect(f.read().entry?.label).toBe("entry owner committed");
    entryPatch({ label: "entry owner committed" }, { ...predicate, leafEntryId: "after-patch" });
    expect(reads.counts.watermark).toBe(0);
  }
  expect(f.nativeEntry()).toMatchObject({ updatedAt: 20, label: "entry owner committed" });
  expect(
    readTranscriptEventRows(f.database, f.scope.sessionId).map(
      (row) => JSON.parse(row.eventJson).id,
    ),
  ).toEqual([f.scope.sessionId, "before-patch", "after-patch"]);

  const retained = f.read();
  refuse(f, "entry patch refused");
  expect(() => entryPatch({ label: "must roll back" })).toThrow("entry patch refused");
  delete f.hooks.admit;
  const rolledBack = f.read();
  expect([rolledBack.entry, rolledBack.transcript, rolledBack.pendingInputs]).toEqual([
    retained.entry,
    retained.transcript,
    retained.pendingInputs,
  ]);
  entryPatch({ lifecycleRevision: "new-lifecycle" });
  const replaced = f.read();
  expect(replaced.version.epoch).not.toBe(rolledBack.version.epoch);
  expect(replaced).toMatchObject({
    entry: { lifecycleRevision: "new-lifecycle", model: "updated-model" },
    hasBoard: true,
  });
});

it.each(["entry", "target"] as const)(
  "patches %s from current actor facts without losing intervening writes or publishing a rollback",
  async (kind) => {
    await withActor((f) => {
      f.read();
      const selection =
        kind === "entry"
          ? entrySelection(f, false)
          : {
              kind,
              target: { canonicalKey: f.target.sessionKey, storeKeys: [f.target.sessionKey] },
            };
      if (kind === "entry") {
        expect(
          readSessionEntryPatchSnapshot(
            f.database,
            entrySelection(f, true, ` ${f.target.sessionKey} `),
          ),
        ).toEqual([]);
        expect(
          readSessionEntryPatchSnapshot(
            f.database,
            entrySelection(f, false, ` ${f.target.sessionKey} `),
          )[0]?.sessionKey,
        ).toBe(f.target.sessionKey);
      }
      const snapshot = () => readSessionEntryPatchSnapshot(f.database, selection);
      const prepare = (label: string) => {
        const prepared = snapshot();
        const writeBase = prepared[0]!.entry;
        return {
          selection,
          prepared,
          writeBase,
          next: { ...writeBase, label },
          sessionKey: f.target.sessionKey,
          operationLabel: "session-entry.patch" as const,
          validateCanonicalKeys: false,
        };
      };
      // Warm publication setup before measuring ordinary patches.
      f.patchEntry(prepare("warm publication"));
      {
        using reads = counts(f, ["select"], (sql) => (/^select\b/iu.test(sql) ? "select" : null));
        const stale = prepare("stale replacement");
        f.patchEntry(prepare("first committed patch"));
        expect(snapshot()[0]?.entry.label).toBe("first committed patch");
        expect(() => f.patchEntry(stale)).toThrow(/changed|conflict/i);
        f.patchEntry(prepare("second committed patch"));
        expect(snapshot()[0]?.entry.label).toBe("second committed patch");
        expect(reads.counts.select).toBe(0);

        const refused = prepare("must roll back");
        refuse(f, "patch commit refused");
        expect(() => f.patchEntry(refused)).toThrow("patch commit refused");
        delete f.hooks.admit;
        expect(snapshot()[0]?.entry.label).toBe("second committed patch");
      }
      expect(f.nativeEntry()?.label).toBe("second committed patch");

      const beforeExternalWrite = prepare("stale after another owner writes");
      f.writeEntry({ ...f.nativeEntry()!, model: "other owner model" });
      expect(() => f.patchEntry(beforeExternalWrite)).toThrow(/changed|conflict/i);
      expect(snapshot()[0]?.entry.model).toBe("other owner model");
      f.restartActor();
      expect(snapshot()[0]?.entry).toMatchObject({
        label: "second committed patch",
        model: "other owner model",
      });
    });
  },
);

const question = messageEvent("question", null, "A question about 🦞");
const answer = messageEvent("answer", "question", "An answer", "assistant");

const storedBytes = (event: unknown) => Buffer.byteLength(JSON.stringify(event)) + 1;

function seed(f: Fixture, prettyQuestion = false) {
  const header = headerEvent(f);
  const questionJson = JSON.stringify(question, null, prettyQuestion ? 2 : undefined);
  transaction(f, () => {
    appendTranscriptEventInTransaction(f.database, f.scope, header);
    appendTranscriptEventInTransaction(f.database, f.scope, question, { eventJson: questionJson });
    appendTranscriptEventInTransaction(f.database, f.scope, answer);
  });
  // Native hydration supplies navigation and bytes without retaining transcript payloads.
  f.restartActor();
  return { header, questionJson };
}

function reader(f: Fixture) {
  if (f.target.database.kind !== "file") {
    throw new Error("Context metadata proof requires a durable actor");
  }
  const replica = createSessionActorReplica({
    target: { ...f.target, database: f.target.database },
    lifetime: { assertCurrent() {}, assertReadable() {} },
    currentGeneration: () => "context-metadata-proof",
  });
  const receipt = () => {
    const retained = readSessionActorProjectionReceipt({
      path: f.database.path,
      sessionKey: f.scope.sessionKey,
      sessionId: f.scope.sessionId,
    });
    if (!retained) {
      throw new Error("Actor did not publish its projection receipt");
    }
    return retained;
  };
  const accounting = () =>
    withSessionTranscriptProjectionReceipt({ ...receipt(), contextOnly: true }, () =>
      readCurrentProjectionSnapshot(f.database, f.scope, (projection) =>
        readSessionTranscriptAccountingFromProjection(projection, {
          includeByteSize: true,
          includeUsage: false,
        }),
      ),
    );
  return {
    [Symbol.dispose]() {
      replica.close();
    },
    receipt,
    install() {
      expect(replica.beginRead()(f.read())).toBe(true);
    },
    expectAccounting(eventCount: number, byteSize: number) {
      expect(accounting()).toMatchObject({ kind: "value", value: { eventCount, byteSize } });
    },
    bounded: () =>
      withSessionTranscriptProjectionReceipt(receipt(), () =>
        readSessionTranscriptBoundedActiveContextCore(f.scope, {
          maxBytes: 1024 * 1024,
          maxEvents: 100,
        }),
      ),
  };
}

it("tracks rewritten bytes in compact receipts, including rollback", ({ actor: f }) => {
  const { header, questionJson } = seed(f, true);
  using context = reader(f);
  context.install();
  expect(context.receipt().facts?.contextMetadata).toBeUndefined();
  context.expectAccounting(2, Buffer.byteLength(questionJson) + 1 + storedBytes(answer));

  const rewritten = steer(question, "committed-next-run");
  transaction(f, () => rewrite(f, 1, questionJson, rewritten));
  // The compact publication updates exact totals without copying row metadata.
  expect(context.receipt().facts?.contextMetadata).toBeUndefined();
  const expected = { eventCount: 2, byteSize: storedBytes(rewritten) + storedBytes(answer) };
  context.expectAccounting(expected.eventCount, expected.byteSize);
  expect(context.bounded()).toMatchObject({
    events: [header, rewritten, answer],
    serializedBytes: storedBytes(header) + expected.byteSize,
  });

  const rolledBack = steer(rewritten, "uncommitted-run-with-a-different-size");
  expect(() =>
    transaction(f, () => {
      rewrite(f, 1, JSON.stringify(rewritten), rolledBack);
      throw new Error("Synthetic context rewrite rollback");
    }),
  ).toThrow("Synthetic context rewrite rollback");
  context.install();
  context.expectAccounting(expected.eventCount, expected.byteSize);
  expect(context.bounded().events).toEqual([header, rewritten, answer]);
});

it.each(["reset", "compaction", "leaf"] as const)(
  "reads the durable context after %s changes the active window",
  async (kind) => {
    await withActor((f) => {
      const { header } = seed(f);
      using context = reader(f);
      context.install();
      expect(context.receipt().facts?.contextMetadata).toBeUndefined();
      const control =
        kind === "leaf"
          ? { type: kind, id: "control", parentId: "answer", targetId: "question" }
          : kind === "compaction"
            ? {
                type: kind,
                id: "control",
                parentId: "answer",
                summary: "The earlier conversation",
                tokensBefore: 20,
              }
            : { type: kind, id: "control", parentId: "answer", reason: "new" };
      const tail = messageEvent(
        "tail",
        kind === "leaf" ? "question" : "control",
        "Continue in the selected window",
      );
      transaction(f, () => {
        appendTranscriptEventsInTransaction(f.database, f.scope, [control, tail], {
          scheduleProjectionReconcile: false,
        });
        reconcileSessionTranscriptIndexInTransaction(f.database.db, f.scope.sessionId);
      });
      context.install();
      expect(context.receipt().facts?.contextMetadata).toBeUndefined();
      const counted =
        kind === "reset" ? [tail] : kind === "compaction" ? [control, tail] : [question, tail];
      context.expectAccounting(
        counted.length,
        counted.reduce((total, event) => total + storedBytes(event), 0),
      );
      const bounded = context.bounded();
      expect(bounded.boundaryCount).toBe(kind === "leaf" ? 0 : 1);
      expect(bounded.events).toEqual(
        kind === "leaf" ? [header, question, tail] : [header, question, answer, control, tail],
      );
    });
  },
);

it("accounts for appends and rewrites beyond the resident window without scans", async ({
  actor: f,
}) => {
  const events = Array.from({ length: 600 }, (_, index) =>
    messageEvent(`message-${index}`, index === 0 ? null : `message-${index - 1}`, "x"),
  );
  transaction(f, () =>
    appendTranscriptEventsInTransaction(f.database, f.scope, events, {
      scheduleProjectionReconcile: false,
    }),
  );
  using context = reader(f);
  context.install();
  using stats = counts(f, ["aggregate"], (sql) =>
    /\bsum\(/iu.test(sql) && sql.includes('"transcript_events"') ? "aggregate" : null,
  );
  const originalBytes = events.reduce((total, event) => total + storedBytes(event), 0);
  context.expectAccounting(events.length, originalBytes);
  const appended = {
    ...messageEvent("after-window", events.at(-1)!.id, question.message.content),
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  const command: Mutation = {
    type: "session.actor.appendTranscriptEvent",
    input: {
      target: f.target,
      commandId: "append-after-window",
      phaseId: "append",
      append: {
        kind: "metadata",
        input: {
          scope: f.scope,
          event: appended,
          message: {
            messageJson: JSON.stringify(appended.message),
            cwd: "/synthetic",
            validateTurn: false,
          },
          options: {},
        },
      },
    },
  };
  const rewritten = steer(appended, "new-run");
  await commit(f, command);
  context.install();
  context.expectAccounting(events.length + 1, originalBytes + storedBytes(appended));
  transaction(f, () => rewrite(f, events.length, JSON.stringify(appended), rewritten));
  context.expectAccounting(events.length + 1, originalBytes + storedBytes(rewritten));
  expect(stats.counts.aggregate).toBe(0);
  expect(
    readSessionTranscriptBoundedActiveContextCore(f.scope, {
      maxBytes: 1024 * 1024,
      maxEvents: 100,
    }),
  ).toMatchObject({ events: [...events.slice(-99), rewritten], truncated: true });
});

it("retains an oversized actor until replaced by another oversized actor", async ({ actor: f }) => {
  const largeLabel = "x".repeat(9 * 1024 * 1024);
  const other = { ...f.target, sessionKey: "agent:main:byte-budget-other" };
  const companion = { ...f.target, sessionKey: "agent:main:byte-budget-companion" };
  transaction(f, () => {
    for (const [target, sessionId, label] of [
      [f.target, f.scope.sessionId, largeLabel],
      [other, "byte-budget-other", undefined],
      [companion, "byte-budget-companion", undefined],
    ] as const) {
      writeSessionEntry(f.database, target.sessionKey, { sessionId, updatedAt: 1, label });
    }
  });

  const small = f.read(other);
  f.read(companion);
  expect(f.read(other).version).toEqual(small.version);

  const initial = f.read();
  const command = activityCommand(f, "oversized-activity", 2);
  const committed = await commit(f, command);
  expect(committed.failure).toBeUndefined();
  expect(f.reply()).toEqual({ kind: "committed" });
  expect(committed.receipt.afterVersion).toEqual({
    epoch: initial.version.epoch,
    sequence: initial.version.sequence + 1,
  });
  const current = f.read();
  expect(current.version).toEqual(committed.receipt.afterVersion);
  expect(current.entry).toMatchObject({ updatedAt: 2, label: largeLabel });

  const competing = f.read(other);
  expect(f.read().version).toEqual(current.version);
  expect(f.read(other).version).toEqual(competing.version);
  const neighboring = f.read(companion);
  expect(f.read(other).version).toEqual(competing.version);
  expect(f.read(companion).version).toEqual(neighboring.version);

  expect(
    f.mutate({
      ...command,
      input: { ...command.input, expected: current.version, commandId: "competing-activity" },
    }).kind,
  ).toBe("committed");

  f.writeEntry(
    { sessionId: "byte-budget-companion", updatedAt: 2, label: largeLabel },
    companion.sessionKey,
  );
  const secondOversized = f.read(companion);
  expect(secondOversized.version.epoch).not.toBe(neighboring.version.epoch);
  expect(f.read(other).version).toEqual(competing.version);
  const rehydrated = f.read();
  expect(rehydrated.version.epoch).not.toBe(current.version.epoch);
  expect(rehydrated.entry).toMatchObject({ updatedAt: 2, label: largeLabel });
  expect(f.read(other).version).toEqual(competing.version);
  expect(f.read(companion).version.epoch).not.toBe(secondOversized.version.epoch);

  f.read();
  f.writeEntry({ sessionId: f.scope.sessionId, updatedAt: 3, label: "small replacement" });
  const smaller = f.read();
  f.read(other);
  f.read(companion);
  expect(f.read().version).toEqual(smaller.version);
  expect(f.read().entry?.label).toBe("small replacement");
});

it("evicts ordinary actors under byte pressure, but keeps the oversized actor", ({ actor: f }) => {
  const ordinary = { ...f.target, sessionKey: "agent:main:ordinary" };
  const newcomers = Array.from({ length: 3 }, (_, index) => ({
    ...f.target,
    sessionKey: `agent:main:newcomer-${index}`,
  }));
  transaction(f, () => {
    // Stored JSON, parsed rows, and hot entries together exceed the ordinary budget.
    for (const [target, mib] of [
      [f.target, 9],
      [ordinary, 1],
      ...newcomers.map((newcomer) => [newcomer, 1] as const),
    ] as const) {
      writeSessionEntry(f.database, target.sessionKey, {
        sessionId: target.sessionKey,
        updatedAt: 1,
        label: "x".repeat(mib * 1024 * 1024),
      });
    }
  });
  const oversizedVersion = f.read().version;
  const ordinaryVersion = f.read(ordinary).version;
  for (const newcomer of newcomers) {
    f.read(newcomer);
  }
  expect(f.read().version).toEqual(oversizedVersion);
  expect(f.read(ordinary).version.epoch).not.toBe(ordinaryVersion.epoch);
  expect(f.read().version).toEqual(oversizedVersion);
});
