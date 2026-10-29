import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { assertOpenClawAgentSchemaContains } from "../state/openclaw-agent-db-schema-helpers.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";

const key = "agent:main:retained-work";
const owner = {
  agentId: "main",
  sessionKey: key,
  sessionId: "incarnation-1",
  lifecycleRevision: null,
};
const source = {
  runId: "run-1",
  turnId: "turn-1",
  toolCallId: "save-1",
  processGeneration: "process-1",
};
const steps = [
  { step: "Publish", status: "completed" as const },
  { step: "Verify CI and merge", status: "pending" as const },
];

it("keeps a single canonical plan while public replacement removes displayed steps", () => {
  using db = new DatabaseSync(":memory:");
  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  db.prepare(
    "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES (?,?,?,1)",
  ).run(key, owner.sessionId, JSON.stringify({ sessionId: owner.sessionId }));
  const input = {
    steps,
    workCommand: {
      owner,
      source,
      expected: null,
      kind: "begin" as const,
      display: "replace" as const,
      scope: "Publish, verify CI and merge",
    },
  };
  writeSessionProgressCard(db, key, input);
  const row = db.prepare("SELECT * FROM session_progress_cards").get()!;
  expect(row.work_json).toEqual(expect.any(String));
  expect(row.steps_json).toBeNull();
  expect(readSessionProgressCard(db, key)?.steps).toEqual(steps);
  writeSessionProgressCard(db, key, { markdown: "CI and merge remain." });
  expect(readSessionProgressCard(db, key)?.steps).toBeUndefined();
  expect(db.prepare("SELECT work_json FROM session_progress_cards").get()?.work_json).toBe(
    row.work_json,
  );
});

import { createMemorySessionActorOwner } from "../config/sessions/session-actor-memory.js";
import { readSessionActorStorageResult } from "../config/sessions/session-actor-storage-result.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
  readSessionProgressAggregate,
  readSessionProgressWork,
  clearSessionProgressCardForReset,
} from "./progress-card-store.js";
import type { ProgressCardWrite } from "./progress-card-values.js";
import type { ProgressWorkCommand, ProgressWorkState } from "./progress-card-work.js";

async function fixture(
  mode: "sql" | "memory",
  run: (api: {
    write(input: ProgressCardWrite): Promise<unknown>;
    card(): Promise<ReturnType<typeof readSessionProgressCard>>;
    work(): Promise<ProgressWorkState | undefined>;
    reset(): Promise<void>;
  }) => Promise<void>,
) {
  if (mode === "sql") {
    using db = new DatabaseSync(":memory:");
    db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    db.prepare(
      "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES (?,?,?,1)",
    ).run(key, owner.sessionId, JSON.stringify({ sessionId: owner.sessionId }));
    await run({
      write: async (input) => writeSessionProgressCard(db, key, input),
      card: async () => readSessionProgressCard(db, key),
      work: async () => readSessionProgressAggregate(db, key)?.work,
      reset: async () => {
        clearSessionProgressCardForReset(db, key);
      },
    });
    return;
  }
  const memory = createMemorySessionActorOwner({
    agentId: "main",
    path: ":memory:retained-progress",
  });
  const authority = { assertCurrent() {}, authorize() {} };
  const lifetime = { assertCurrent() {}, assertReadable() {} };
  const actor = await memory.acquire({ database: memory.identity, sessionKey: key }, lifetime);
  try {
    readSessionActorStorageResult(
      await actor.storage!.mutate(
        {
          type: "session.entry.create",
          input: { entry: { sessionId: owner.sessionId, updatedAt: 1, incognito: true } },
        },
        authority,
      ),
    );
    await run({
      write: async (input) =>
        readSessionActorStorageResult(
          await actor.storage!.mutate(
            { type: "progressCard.put", input: { sessionKey: key, ...input } },
            authority,
          ),
        ),
      card: () =>
        actor.storage!.read({ type: "progressCard.get", input: { sessionKey: key } }, authority),
      work: () =>
        actor.storage!.read({ type: "progressCard.work", input: { sessionKey: key } }, authority),
      reset: async () => {
        readSessionActorStorageResult(
          await actor.storage!.mutate(
            { type: "progressCard.clearForReset", input: { sessionKey: key } },
            authority,
          ),
        );
      },
    });
  } finally {
    memory.close();
  }
}
const initial = (): ProgressCardWrite => ({
  steps,
  workCommand: {
    owner,
    source,
    expected: null,
    kind: "begin",
    scope: "Publish, verify CI and merge",
    display: "replace",
  },
});
const reconcile = (
  revision: number,
  toolCallId: string,
  change: Partial<Extract<ProgressWorkCommand, { kind: "reconcile" }>> = {},
): ProgressWorkCommand => ({
  kind: "reconcile",
  owner,
  source: { ...source, toolCallId },
  expected: { generation: 1, revision },
  ...change,
});

for (const mode of ["sql", "memory"] as const) {
  it.each([false, true])(
    mode + " rejects absent-work retirement without poisoning later begin (legacy=%s)",
    (legacy) =>
      fixture(mode, async (api) => {
        if (legacy) {
          await api.write({ markdown: "Legacy display only", steps });
        }
        const card = await api.card();
        await expect(
          api.write({
            workCommand: {
              kind: "retire",
              owner,
              source,
              expected: null,
            },
          }),
        ).rejects.toThrow("No retained work to retire");
        expect(await api.work()).toBeUndefined();
        expect(await api.card()).toEqual(card);
        await api.write(initial());
        expect(await api.work()).toMatchObject({ generation: 1, revision: 1, record: { steps } });
        const retire: ProgressCardWrite = {
          workCommand: {
            kind: "retire",
            owner,
            source: { ...source, toolCallId: "retire-managed" },
            expected: { generation: 1, revision: 1 },
          },
        };
        await api.write(retire);
        const retired = await api.work();
        expect(retired).toMatchObject({ generation: 1, revision: 2, record: null });
        await api.write(retire);
        expect(await api.work()).toEqual(retired);
      }),
  );
  it(
    mode +
      " preserves obligations, rejects implicit pruning/completion atomically, and requires explicit new task",
    () =>
      fixture(mode, async (api) => {
        await api.write(initial());
        const before = await api.work();
        const display = await api.card();
        for (const plan of [
          [steps[0]!],
          steps.map((s) => ({ ...s, status: "completed" as const })),
        ]) {
          await expect(
            api.write({
              steps: plan,
              markdown: "not committed",
              workCommand: reconcile(1, "invalid", { display: "replace" }),
            }),
          ).rejects.toThrow();
          expect(await api.work()).toEqual(before);
          expect(await api.card()).toEqual(display);
        }
        await api.write({
          steps: steps.map((s) => ({ ...s, status: "completed" })),
          workCommand: reconcile(1, "complete", {
            disposition: { kind: "completed", source: { ...source, toolCallId: "complete" } },
          }),
        });
        expect((await api.work())?.record).toMatchObject({
          steps: [{ status: "completed" }, { status: "completed" }],
          disposition: { kind: "completed" },
        });
        await expect(
          api.write({ steps, workCommand: reconcile(2, "implicit-new") }),
        ).rejects.toThrow("Terminal work");
        await api.write({
          steps: [{ step: "Different task", status: "pending" }],
          workCommand: {
            owner,
            source: { ...source, toolCallId: "new" },
            expected: { generation: 1, revision: 2 },
            kind: "begin",
            scope: "Different task",
            display: "replace",
          },
        });
        expect(await api.work()).toMatchObject({
          generation: 2,
          revision: 3,
          record: { scope: "Different task" },
        });
      }),
  );

  it(mode + " converges after lost acknowledgment and keeps display revisions separate", () =>
    fixture(mode, async (api) => {
      const first = initial();
      await api.write(first);
      const saved = await api.work();
      const card = await api.card();
      await api.write(first);
      expect(await api.work()).toEqual(saved);
      expect(await api.card()).toEqual(card);
      await api.write({
        steps,
        workCommand: reconcile(1, "normalized-noop", { display: "replace" }),
      });
      expect(await api.work()).toMatchObject({ generation: 1, revision: 1 });
      expect(await api.card()).toEqual(card);
      await api.write({ markdown: "Published; verification remains.", steps: [] });
      expect(await api.card()).toMatchObject({
        revision: 2,
        markdown: "Published; verification remains.",
      });
      expect((await api.card())?.steps).toBeUndefined();
      await api.write({ expectedRevision: 1 });
      expect(await api.card()).not.toBeNull();
      await api.write({ expectedRevision: 2 });
      expect(await api.card()).toBeNull();
      expect(await api.work()).toMatchObject({ generation: 1, revision: 1, record: { steps } });
      await api.write({
        workCommand: reconcile(1, "pause", {
          disposition: {
            kind: "paused-blocked",
            reason: "Review required",
            resumeCondition: "Review accepted",
            source,
          },
        }),
      });
      expect(await api.card()).toBeNull();
      expect(await api.work()).toMatchObject({
        revision: 2,
        record: { disposition: { kind: "paused-blocked" } },
      });
      await expect(api.write(first)).rejects.toThrow("changed before commit");
    }),
  );

  it(mode + " preserves a quiet hold and detaches rather than erases a retired checklist", () =>
    fixture(mode, async (api) => {
      await api.write(initial());
      await api.write({
        workCommand: reconcile(1, "hold", {
          disposition: {
            kind: "paused-blocked",
            reason: "Review",
            resumeCondition: "Accepted review",
            source,
          },
        }),
      });
      await api.write({
        steps: [{ step: "Verify CI and merge", status: "in_progress" }],
        workCommand: reconcile(2, "plan-update"),
      });
      expect(await api.work()).toMatchObject({
        revision: 3,
        record: {
          steps: [steps[0], { step: "Verify CI and merge", status: "in_progress" }],
          disposition: { kind: "paused-blocked" },
        },
      });
      const held = await api.work();
      // This exercises the reducer's already-bound reference contract, not native spawn acceptance.
      await api.write({
        workCommand: {
          owner,
          source: { ...source, toolCallId: "late-wait" },
          expected: { generation: 1, revision: 3 },
          kind: "observe-wait",
          receipt: { kind: "child", runId: "child-run", childSessionKey: "agent:main:child" },
          resumeCondition: "Child settles",
        },
      });
      expect(await api.work()).toEqual(held);
      const displayed = (await api.card())!.steps;
      await api.write({
        workCommand: {
          owner,
          source: { ...source, toolCallId: "cancel" },
          expected: { generation: 1, revision: 3 },
          kind: "retire",
        },
      });
      expect(await api.work()).toMatchObject({ generation: 1, revision: 4, record: null });
      expect((await api.card())?.steps).toEqual(displayed);
      expect((await api.card())?.revision).toBe(3);
      await expect(api.write({ steps, workCommand: reconcile(4, "implicit") })).rejects.toThrow(
        "Terminal work",
      );
    }),
  );

  it(mode + " retires hidden work on reset and rejects a stale callback", () =>
    fixture(mode, async (api) => {
      await api.write(initial());
      await api.write({});
      expect(await api.card()).toBeNull();
      await api.reset();
      expect(await api.card()).toBeNull();
      expect(await api.work()).toMatchObject({ generation: 1, revision: 2, record: null });
      await expect(
        api.write({ steps, workCommand: reconcile(1, "stale-after-reset") }),
      ).rejects.toThrow("changed before commit");
    }),
  );
}

it.each([false, true])(
  "reads legacy/partial columns without backfill and upgrades only at write (partial=%s)",
  (partial) => {
    using db = new DatabaseSync(":memory:");
    db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    db.exec(
      "DROP TABLE session_progress_cards; CREATE TABLE session_progress_cards(session_key TEXT NOT NULL PRIMARY KEY, markdown TEXT, steps_json TEXT, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE) STRICT;",
    );
    if (partial) {
      db.exec("ALTER TABLE session_progress_cards ADD COLUMN work_json TEXT;");
    }
    db.prepare(
      "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES (?,?,?,1)",
    ).run(key, owner.sessionId, JSON.stringify({ sessionId: owner.sessionId }));
    db.prepare(
      "INSERT INTO session_progress_cards(session_key,markdown,revision,created_at,updated_at) VALUES (?, 'Legacy paused note',1,1,1)",
    ).run(key);
    const before = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='session_progress_cards'")
      .get();
    assertOpenClawAgentSchemaContains(db, ":memory:", OPENCLAW_AGENT_SCHEMA_SQL);
    expect(readSessionProgressCard(db, key)?.markdown).toBe("Legacy paused note");
    expect(readSessionProgressAggregate(db, key)?.work).toBeUndefined();
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name='session_progress_cards'").get(),
    ).toEqual(before);
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        writeSessionProgressCard(db, key, { markdown: "Rolled back upgrade" });
        throw new Error("rollback additive upgrade");
      }),
    ).toThrow("rollback additive upgrade");
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name='session_progress_cards'").get(),
    ).toEqual(before);
    writeSessionProgressCard(db, key, { markdown: "Still display only" });
    expect(readSessionProgressAggregate(db, key)?.work).toBeUndefined();
    writeSessionProgressCard(db, key, initial());
    expect(readSessionProgressAggregate(db, key)?.work).toMatchObject({
      generation: 1,
      revision: 1,
      record: { steps },
    });
  },
);

it("rejects malformed persisted work instead of presenting it as completed or absent", () => {
  using db = new DatabaseSync(":memory:");
  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  db.prepare(
    "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES (?,?,?,1)",
  ).run(key, owner.sessionId, JSON.stringify({ sessionId: owner.sessionId }));
  writeSessionProgressCard(db, key, initial());
  db.exec("UPDATE session_progress_cards SET work_json='{}'");
  expect(() => readSessionProgressAggregate(db, key)).toThrow("Invalid retained work");
  expect(() => readSessionProgressCard(db, key)).toThrow("Invalid retained work");
  // The lifecycle owner can still retire corrupt task material without decoding it.
  clearSessionProgressCardForReset(db, key);
  expect(readSessionProgressAggregate(db, key)?.work?.record).toBeNull();
});

it.each(["sql", "memory"] as const)(
  "%s keeps accepted waiting quiet until explicit reconciliation",
  (mode) =>
    fixture(mode, async (api) => {
      await api.write(initial());
      await api.write({
        workCommand: {
          kind: "observe-wait",
          owner,
          source: { ...source, toolCallId: "wait" },
          expected: { generation: 1, revision: 1 },
          receipt: { kind: "media", runId: "accepted-media", taskId: "accepted-media" },
          resumeCondition: "Existing media owner delivers",
        },
      });
      await api.write({ markdown: "Waiting for the accepted operation" });
      await api.write({ steps, workCommand: reconcile(2, "status-plan") });
      expect(await api.work()).toMatchObject({
        revision: 2,
        record: { disposition: { kind: "waiting", receipt: { runId: "accepted-media" } }, steps },
      });
      await api.write({
        workCommand: reconcile(2, "resume", { disposition: { kind: "actionable" } }),
      });
      expect(await api.work()).toMatchObject({
        revision: 3,
        record: { disposition: { kind: "actionable" } },
      });
      const before = await api.work();
      await expect(
        api.write({
          workCommand: reconcile(3, "bad-owner", {
            owner: { ...owner, sessionId: "foreign-incarnation" },
          }),
        }),
      ).rejects.toThrow("incarnation");
      expect(await api.work()).toEqual(before);
    }),
);

it("does not turn an invalid retained fence into absent work", () => {
  using db = new DatabaseSync(":memory:");
  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  db.prepare(
    "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES (?,?,?,1)",
  ).run(key, owner.sessionId, JSON.stringify({ sessionId: owner.sessionId }));
  writeSessionProgressCard(db, key, initial());
  db.exec("UPDATE session_progress_cards SET work_generation=0");
  expect(() => readSessionProgressAggregate(db, key)).toThrow("Invalid retained work fence");
});

it.each(["sql", "memory"] as const)(
  "%s advances the source only on explicit reconciliation",
  (mode) =>
    fixture(mode, async (api) => {
      await api.write(initial());
      await api.write({ markdown: "Status only" });
      await api.write({ steps, workCommand: reconcile(1, "implicit-plan") });
      expect((await api.work())?.record?.source).toEqual(source);
      const current = {
        ...source,
        runId: "new-run",
        turnId: "new-turn",
        toolCallId: "current",
        processGeneration: "new-process",
      };
      const command = reconcile(1, "current", {
        source: current,
        disposition: { kind: "actionable" },
      });
      await api.write({ workCommand: command });
      expect(await api.work()).toMatchObject({ revision: 2, record: { source: current, steps } });
      await api.write({ workCommand: command });
      expect((await api.work())?.revision).toBe(2);
    }),
);

it.each([0, 1_700_000_000_000])(
  "SQL denies archivedAt=%s retained-work access without changing saved state",
  (archivedAt) => {
    using db = new DatabaseSync(":memory:");
    db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    const entry = { sessionId: owner.sessionId, updatedAt: 1 };
    db.prepare(
      "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES (?,?,?,1)",
    ).run(key, owner.sessionId, JSON.stringify(entry));
    writeSessionProgressCard(db, key, initial());
    expect(readSessionProgressWork(db, owner)).toMatchObject({
      generation: 1,
      revision: 1,
      record: { steps },
    });
    const saved = db.prepare("SELECT * FROM session_progress_cards WHERE session_key=?").get(key);
    const display = readSessionProgressCard(db, key);
    db.prepare("UPDATE session_nodes SET entry_json=? WHERE session_key=?").run(
      JSON.stringify({ ...entry, archivedAt }),
      key,
    );
    const resumedSteps = [steps[0]!, { ...steps[1]!, status: "in_progress" as const }];
    const writes: ProgressCardWrite[] = [
      {
        steps: resumedSteps,
        workCommand: reconcile(1, "archive-reconcile", { display: "replace" }),
      },
      {
        markdown: "Uncommitted managed note",
        managedWork: { owner, source, expected: { generation: 1, revision: 1 } },
      },
      { managedWork: { owner, source, expected: { generation: 1, revision: 1 } } },
    ];
    const denied = [
      () => readSessionProgressWork(db, owner),
      ...writes.map((input) => () => writeSessionProgressCard(db, key, input)),
    ];
    for (const operation of denied) {
      expect(operation).toThrow("Work owner incarnation is no longer current");
      expect(
        db.prepare("SELECT * FROM session_progress_cards WHERE session_key=?").get(key),
      ).toEqual(saved);
      expect(readSessionProgressCard(db, key)).toEqual(display);
    }
    db.prepare("UPDATE session_nodes SET entry_json=? WHERE session_key=?").run(
      JSON.stringify(entry),
      key,
    );
    for (const input of writes.slice(1)) {
      writeSessionProgressCard(db, key, input);
      expect(readSessionProgressWork(db, owner)).toMatchObject({ revision: 1, record: { steps } });
    }
    expect(readSessionProgressCard(db, key)).toBeNull();
    writeSessionProgressCard(db, key, writes[0]!);
    expect(readSessionProgressWork(db, owner)).toMatchObject({
      generation: 1,
      revision: 2,
      record: { steps: resumedSteps },
    });
    expect(readSessionProgressCard(db, key)).toMatchObject({ revision: 4, steps: resumedSteps });
  },
);
