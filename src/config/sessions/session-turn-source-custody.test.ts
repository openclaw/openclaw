import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readSessionPendingInputByKey } from "./session-accessor.sqlite-pending-inputs.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";
import { acquireSessionInputActor, bindUserTurnInputActor } from "./session-input-actor.js";
import { withSessionTranscriptSourcePublication } from "./transcript-write-context.js";

afterEach(() => {
  vi.restoreAllMocks();
});

type Fixture = ReturnType<typeof fixture>;
type Input = NonNullable<Awaited<ReturnType<typeof acquireSessionInputActor>>>;
type InputTarget = Parameters<typeof acquireSessionInputActor>[0];
async function withFixture(
  run: (f: Fixture & { acquire(target?: InputTarget): Promise<Input> }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const f = fixture();
    const inputs: Input[] = [];
    const acquire = async (
      target: InputTarget = {
        agentId: f.scope.agentId,
        storePath: f.scope.storePath,
        target: f.target,
      },
    ) => {
      const input = expectDefined(
        await acquireSessionInputActor(target, { assertCurrent() {}, assertReadable() {} }),
        "durable input actor",
      );
      inputs.push(input);
      return input;
    };
    try {
      await run({ ...f, acquire });
    } finally {
      for (const input of inputs) {
        await input.actor.release();
      }
    }
  });
}
type RecorderOptions = Parameters<typeof createUserTurnTranscriptRecorder>[0];
function recorder(
  f: Fixture,
  options: Omit<RecorderOptions, "target"> & { target?: RecorderOptions["target"] },
) {
  return createUserTurnTranscriptRecorder({
    updateMode: "none",
    ...options,
    target: options.target ?? {
      ...f.scope,
      expectedSessionId: f.scope.sessionId,
      sessionEntry: f.read(),
    },
  });
}
const messages = (f: Fixture) => f.events().filter((event) => event.type === "message");
const user = (content: string, idempotencyKey: string, timestamp = 1) => ({
  role: "user" as const,
  content,
  timestamp,
  idempotencyKey,
});
function expectSource(
  publish: unknown,
  database: Parameters<typeof readOpenClawAgentDatabaseIdentity>[0],
  entry: Record<string, unknown>,
) {
  const { identity, birthtime } = readOpenClawAgentDatabaseIdentity(database);
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    {
      agentId: database.agentId,
      path: database.path,
      databaseIdentity: identity,
      databaseBirthtime: birthtime,
    },
    expect.objectContaining(entry),
  );
}

it("prepares shared-ID input through its transcript owner and retains intervening metadata", async () => {
  await withFixture(async (f) => {
    const base = { ...f.scope, sessionKey: "agent:main:cron:job" };
    const run = { ...base, sessionKey: `${base.sessionKey}:run:${base.sessionId}` };
    replaceSessionEntrySync(base, {
      sessionId: base.sessionId,
      updatedAt: 2,
      lifecycleRevision: "base",
      label: "base entry",
    });
    replaceSessionEntrySync(run, {
      sessionId: run.sessionId,
      updatedAt: 3,
      lifecycleRevision: "run",
      label: "run entry",
    });
    const baseEntry = readExactSessionEntryRow(f.database, base.sessionKey)!.entry;
    const input = await f.acquire({
      ...run,
      target: { canonicalKey: run.sessionKey, storeKeys: [run.sessionKey] },
    });
    const persist = async (key: string) => {
      const rec = recorder(f, {
        message: user(key, key),
        target: { ...base, expectedSessionId: base.sessionId, sessionEntry: baseEntry },
      });
      bindUserTurnInputActor(rec, { phase: "acceptInput", acquire: async () => input });
      return rec.persistApproved();
    };
    await expect(persist("shared-id:first")).resolves.toMatchObject({
      appended: true,
      sessionEntry: { lifecycleRevision: "run", label: "run entry" },
    });
    await patchSessionEntryCore(run, () => ({ label: "later metadata" }));
    await expect(persist("shared-id:second")).resolves.toMatchObject({
      appended: true,
      sessionEntry: { lifecycleRevision: "run", label: "later metadata" },
    });
    expect(readExactSessionEntryRow(f.database, base.sessionKey)?.entry).toEqual(baseEntry);
    expect(messages(f)).toHaveLength(2);
  });
});

it.each([false, true])(
  "commits initialized first input from an absent preimage (warm=%s)",
  async (warm) => {
    await withFixture(async (f) => {
      const scope = { ...f.scope, sessionKey: "agent:main:first-input", sessionId: "first-input" };
      const input = await f.acquire({
        ...scope,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      });
      const rec = recorder(f, {
        message: user("Initial lifecycle", "first-input:user"),
        target: {
          ...scope,
          expectedSessionId: scope.sessionId,
          sessionEntry: undefined,
          initialSessionEntry: {
            sessionId: scope.sessionId,
            updatedAt: 1,
            status: "done",
            abortedLastRun: false,
          },
        },
      });
      if (warm) {
        await input.actor.read({ assertCurrent() {}, authorize() {} });
      }
      bindUserTurnInputActor(rec, { phase: "acceptInput", acquire: async () => input });
      await expect(rec.persistApproved()).resolves.toMatchObject({ appended: true });
      expect(readExactSessionEntryRow(f.database, scope.sessionKey)?.entry).toMatchObject({
        sessionId: scope.sessionId,
        status: "done",
        abortedLastRun: false,
      });
      expect(
        readTranscriptEventRows(f.database, scope.sessionId)
          .map((row) => JSON.parse(row.eventJson))
          .filter((event) => event.type === "message"),
      ).toHaveLength(1);
    });
  },
);

it("returns the durable committed message when prepared input arrives after its key", async () => {
  await withFixture(async (f) => {
    const input = await f.acquire();
    const original = { role: "user", content: "Original", idempotencyKey: "prepared-input" };
    const accepted = { ...original, content: "Accepted" };
    const append = (commandId: string, message: unknown) =>
      input.actor.appendToolResult(
        {
          commandId,
          phaseId: "prepared-input",
          turn: {
            agentId: f.scope.agentId,
            sessionKey: f.scope.sessionKey,
            options: {
              expectedSessionId: f.scope.sessionId,
              sessionFile: "synthetic-session.jsonl",
              messages: [
                {
                  eventId: "accepted-input",
                  message: original,
                  preparedMessage: { prepared: true, message },
                },
              ],
            },
          },
        },
        { assertCurrent() {}, authorize() {} },
      );
    expect(await append("first", accepted)).toMatchObject({ kind: "committed" });
    const replay = await append("retry", {
      ...original,
      content: "Must not replace accepted input",
    });
    expect(replay).toMatchObject({
      kind: "committed",
      receipt: {
        transcript: {
          appendedMessages: [{ appended: false, messageId: "accepted-input", message: accepted }],
        },
      },
    });
    expect(messages(f)).toEqual([
      expect.objectContaining({ id: "accepted-input", message: accepted }),
    ]);
  });
});

it.each([
  { phase: "acceptInput", change: "metadata" },
  { phase: "adoptRun", change: "metadata" },
  { phase: "acceptInput", change: "lifecycle" },
  { phase: "adoptRun", change: "lifecycle" },
] as const)(
  "preserves input custody across a $change write before $phase admission",
  async ({ phase, change }) => {
    await withFixture(async (f) => {
      const input = await f.acquire();
      const message = user("Retain one prepared input.", "intervening-write:user");
      const prepare = vi.fn<NonNullable<RecorderOptions["beforeMessageWrite"]>>(
        ({ message: preparedMessage }) => preparedMessage,
      );
      const rec = recorder(f, { message, beforeMessageWrite: prepare, onPersistenceError() {} });
      bindUserTurnInputActor(rec, { phase, acquire: async () => input });
      let changed = false;
      const intervene = async () => {
        if (changed) {
          return;
        }
        changed = true;
        await patchSessionEntryCore(f.scope, () =>
          change === "metadata" ? { updatedAt: 2, startedAt: 2 } : { abortedLastRun: true },
        );
      };
      if (phase === "acceptInput") {
        const execute = input.actor.acceptInput.bind(input.actor);
        vi.spyOn(input.actor, "acceptInput").mockImplementation(async (...args) => {
          await intervene();
          return execute(...args);
        });
      } else {
        const execute = input.actor.adoptRun.bind(input.actor);
        vi.spyOn(input.actor, "adoptRun").mockImplementation(async (...args) => {
          await intervene();
          return execute(...args);
        });
      }
      const persistence = rec.persistApproved();
      if (change === "metadata") {
        await expect(persistence).resolves.toMatchObject({ appended: true, message });
        expect(rec.hasPersisted()).toBe(true);
        expect(rec.getAdmissionReceipt()).toMatchObject({ sessionId: f.scope.sessionId });
        expect(messages(f)).toEqual([expect.objectContaining({ message })]);
        expect(f.read()).toMatchObject({ startedAt: 2 });
      } else {
        await expect(persistence).rejects.toThrow(
          "Session actor turn was refused by its current owner",
        );
        expect(rec.hasPersisted()).toBe(false);
        expect(rec.getAdmissionReceipt()).toBeUndefined();
        expect(f.events()).toEqual([]);
        expect(f.read()).toMatchObject({ abortedLastRun: true });
      }
      expect(prepare).toHaveBeenCalledOnce();
    });
  },
);

it("retains actor-bound recorder custody through a durable worker publication failure", async () => {
  await withFixture(async (f) => {
    const input = await f.acquire();
    const failure = new Error("durable input publication failed");
    const message = user("Keep the worker's committed input.", "durable-actor:user");
    const rec = recorder(f, { message, onPersistenceError() {} });
    bindUserTurnInputActor(rec, { phase: "acceptInput", acquire: async () => input });
    try {
      expect(input.actor.target.database.kind).toBe("file");
      await expect(
        rec.stageApproved?.({ runId: "durable-actor", assertCurrent() {} }),
      ).resolves.toBe(true);
      expect(
        readSessionPendingInputByKey(f.database, f.scope, message.idempotencyKey),
      ).toMatchObject({
        state: "queued",
        consumed_event_id: null,
      });
      expect(f.events()).toEqual([]);
      bindUserTurnInputActor(rec, { phase: "adoptRun", acquire: async () => input });
      const published = vi.fn<Parameters<typeof withSessionTranscriptSourcePublication>[1]>(() => {
        expect(rec.hasPersisted()).toBe(true);
        expect(rec.getPersistedMessage?.()).toEqual(message);
        expect(rec.getAdmissionReceipt()).toMatchObject({ sessionId: f.scope.sessionId });
        throw failure;
      });
      await expect(
        withSessionTranscriptSourcePublication(f.scope, published, () => rec.persistApproved()),
      ).rejects.toThrow(failure.message);
      expectSource(published, f.database, { sessionId: f.scope.sessionId });
      const receipt = expectDefined(rec.getAdmissionReceipt(), "committed worker admission");
      expect(rec.isPendingInputConsumed?.()).toBe(true);
      expect(
        readSessionPendingInputByKey(f.database, f.scope, message.idempotencyKey),
      ).toBeUndefined();
      await expect(rec.persistFallback()).resolves.toMatchObject({
        appended: true,
        messageId: receipt.entryId,
        message,
      });
      expect(messages(f)).toEqual([expect.objectContaining({ id: receipt.entryId, message })]);
      expect(published).toHaveBeenCalledOnce();
    } finally {
      rec.finishPendingInput?.("interrupted");
      await rec.waitForPendingInputSettlement?.();
    }
  });
});

it.each(["fresh", "replay"])(
  "fences unstaged original input at COMMIT while retaining %s semantics",
  async (mode) => {
    await withFixture(async (f) => {
      let live = true;
      const sourceCommitted = vi.fn();
      const assertCurrent = vi.fn(() => {
        if (!live) {
          throw new Error("original input authority closed");
        }
      });
      const makeRecorder = () =>
        recorder(f, {
          message: user("synthetic command", "unstaged-command", Date.now()),
          assertOriginalInputCommit: assertCurrent,
          beforeMessageWrite: ({ message }) => {
            assertCurrent();
            return message;
          },
          onPersistenceError: () => {},
        });
      const persist = () =>
        withSessionTranscriptSourcePublication(f.scope, sourceCommitted, () =>
          makeRecorder().persistFallback(),
        );
      if (mode === "replay") {
        await persist();
        expect(sourceCommitted).toHaveBeenCalledOnce();
        sourceCommitted.mockClear();
        live = false;
        assertCurrent.mockClear();
      }
      let commitSeen = false;
      probe.admission(admission, (request, grant, callback) => {
        if (request.stage === "commit") {
          commitSeen = true;
          live = false;
        }
        callback(request, grant);
      });
      if (mode === "fresh") {
        await expect(persist()).rejects.toThrow("original input authority closed");
        expect(commitSeen).toBe(true);
        expect(sourceCommitted).not.toHaveBeenCalled();
        expect(f.events()).toEqual([]);
      } else {
        await expect(persist()).resolves.toMatchObject({ appended: false });
        expect(assertCurrent).not.toHaveBeenCalled();
        expect(sourceCommitted).toHaveBeenCalledOnce();
        expect(messages(f)).toHaveLength(1);
      }
    });
  },
);

it.each(["worker", "native"] as const)(
  "retains a new Goal's committed store through a %s postcommit failure",
  async (writer) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:goal-source-custody",
        sessionId: "goal-source-custody",
        storePath: state.statePath("goal-source.sqlite"),
      };
      const failure = new Error("synthetic postcommit failure");
      const fail = () => {
        throw failure;
      };
      const databaseScope = { agentId: scope.agentId, path: scope.storePath };
      const beforeFreshMessageCommit =
        writer === "native"
          ? () => {
              const database = openOpenClawAgentDatabase(databaseScope);
              expect(deferSqlitePostCommitPublication(database.db, fail)).toBe(true);
            }
          : undefined;
      const sourceCommitted = vi.fn<Parameters<typeof withSessionTranscriptSourcePublication>[1]>();
      const persistence = expect(
        withSessionTranscriptSourcePublication(scope, sourceCommitted, () =>
          persistSessionTranscriptTurn(scope, {
            expectedSessionId: scope.sessionId,
            initialSessionEntry: { sessionId: scope.sessionId, updatedAt: Date.now() },
            sessionTurnMutation: {
              kind: "goal",
              runId: "goal-source-run",
              operation: {
                action: "start",
                objective: "Retain this committed Goal.",
                operationId: "goal-source-operation",
                requestFingerprint: "goal-source-fingerprint",
                issuedAtMs: Date.now(),
              },
            },
            messages: [
              {
                eventId: "goal-source-message",
                message: { role: "user", content: "Retain this committed Goal." },
                beforeFreshMessageCommit,
              },
            ],
            onMessageCommitted: writer === "worker" ? fail : undefined,
          }),
        ),
      );
      if (writer === "worker") {
        await persistence.rejects.toBe(failure);
      } else {
        await persistence.resolves.toMatchObject({ appendedCount: 1 });
      }
      const database = openOpenClawAgentDatabase(databaseScope);
      expectSource(sourceCommitted, database, {
        sessionId: scope.sessionId,
        goal: expect.objectContaining({ objective: "Retain this committed Goal." }),
      });
      expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry.goal?.objective).toBe(
        "Retain this committed Goal.",
      );
      expect(
        readTranscriptEventRows(database, scope.sessionId).filter(
          (row) => JSON.parse(row.eventJson).id === "goal-source-message",
        ),
      ).toHaveLength(1);
    });
  },
);
